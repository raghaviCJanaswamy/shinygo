const { request } = require('undici');
const tar = require('tar');

const DB_VER = process.env.IDEP_DB_VER || 'data113';
const DB_BASE_URL = process.env.IDEP_DB_URL || 'http://bioinformatics.sdstate.edu/data/';

// ==== Electron main =========================================================
const { app, BrowserWindow, dialog, shell } = require('electron');
const path = require('path');
const { spawn, execSync } = require('child_process');
const fs = require('fs-extra');

let shinyProc = null;
let shinyPort = null;
let mainWindow = null;

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';
const isDev = !app.isPackaged;

// ---------- small helpers ----------
function appRootPath() {
  // dev: repo root; prod: resources/app (keep Shiny app outside asar)
  return isDev ? path.join(__dirname, '..', '..')
               : path.join(process.resourcesPath, 'app');
}

function parsePortFrom(txt) {
  let m = /Listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(txt);
  if (m) return m[1];
  m = /\[APP\]\s+USING_PORT\s+(\d+)/.exec(txt);
  if (m) return m[1];
  return null;
}

async function attachLogging(child) {
  const logFile = path.join(app.getPath('userData'), 'shiny-backend.log');
  await fs.ensureFile(logFile);

  const write = async (buf) => {
    const txt = buf.toString();
    await fs.appendFile(logFile, txt);
    if (!shinyPort) {
      const p = parsePortFrom(txt);
      if (p) { shinyPort = p; createWindow(); }
    }
  };

  child.stdout.on('data', write);
  child.stderr.on('data', write);
  child.on('exit', async (code) => {
    await fs.appendFile(logFile, `\n[MAIN] backend exited with code ${code}\n`);
    if (!shinyPort) {
      dialog.showErrorBox('Shiny backend failed', `See log:\n${logFile}`);
      app.quit();
    }
  });

  // pop open the log if backend hasn’t started after 2 minutes
  setTimeout(() => { if (!shinyPort) shell.showItemInFolder(logFile); }, 120000);
}

// ---------- R runtime discovery (platform-aware) ----------
async function normalizeRuntime(runtimeDir) {
  const rDir = path.join(runtimeDir, 'R');

  // Flatten .../R/R-full/* -> .../R/*
  const rFull = path.join(rDir, 'R-full');
  if (await fs.pathExists(path.join(rFull, 'bin'))) {
    for (const name of await fs.readdir(rFull)) {
      await fs.move(path.join(rFull, name), path.join(rDir, name), { overwrite: true });
    }
    await fs.remove(rFull);
  }

  // Flatten accidental double R: .../R/R/* -> .../R/*
  const nestedR = path.join(rDir, 'R');
  if (await fs.pathExists(path.join(nestedR, 'bin'))) {
    for (const name of await fs.readdir(nestedR)) {
      await fs.move(path.join(nestedR, name), path.join(rDir, name), { overwrite: true });
    }
    await fs.remove(nestedR);
  }
}

// Return the directory that directly contains the R folder (…/R/…)
// Replace your ensureRuntimeDir() with this
async function ensureRuntimeDir() {
  const platformSub = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';

  const quick = [
    path.join(process.resourcesPath, 'runtime', platformSub),     // resources/runtime/win
    path.join(app.getPath('userData'), 'runtime', platformSub),   // userData/runtime/win
    path.join(appRootPath(), 'electron', 'runtime', platformSub), // dev/electron/runtime/win
    path.join(process.resourcesPath, 'runtime')                   // resources/runtime (no sub)
  ];

  for (const base of quick) {
    const rDir = path.join(base, 'R');
    if (fs.existsSync(path.join(rDir, 'bin'))) {
      await normalizeRuntime(base);
      return base;
    }
  }

  // recursive search under likely roots
  const roots = [
    path.join(process.resourcesPath, 'runtime'),
    path.join(app.getPath('userData'), 'runtime'),
    path.join(appRootPath(), 'electron', 'runtime')
  ];

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      let ents = [];
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }

      // does this dir contain R/bin/Rscript(.exe)?
      const rBin = path.join(dir, 'R', 'bin');
      const rscript = path.join(rBin, process.platform === 'win32' ? 'Rscript.exe' : 'Rscript');
      if (fs.existsSync(rscript)) {
        await normalizeRuntime(dir);
        return dir; // <- this directory directly contains R/
      }

      for (const e of ents) if (e.isDirectory()) stack.push(path.join(dir, e.name));
    }
  }

  const tried = quick.concat(roots).map(p => `  - ${p}`).join('\n');
  throw new Error(`No R runtime found. Expected at one of:\n${tried}`);
}



function assertRuntimeLooksRight(runtimeDir) {
  const R_HOME = path.join(runtimeDir, 'R');
  const rscript = path.join(R_HOME, 'bin', isWin ? 'Rscript.exe' : 'Rscript');
  const rDll64  = isWin ? path.join(R_HOME, 'bin', 'x64', 'R.dll') : null;

  const missing = [R_HOME, rscript].filter(p => !fs.existsSync(p));
  if (isWin && !fs.existsSync(rDll64)) missing.push(rDll64);

  if (missing.length) {
    throw new Error(
      'R runtime looks incomplete. Missing:\n' +
      missing.map(p => `  - ${p}`).join('\n') +
      '\nExpected layout: runtime/<win|mac|linux>/R/bin/...'
    );
  }
}

// probe a binary to ensure it runs and prints OK
async function probe(binaryPath, env, kind) {
  const args = kind === 'rscript'
    ? ['-e', 'cat("OK")']
    : ['--vanilla', '--slave', '-e', 'cat("OK")'];

  return await new Promise((resolve) => {
    const p = spawn(binaryPath, args, { env, windowsHide: true, shell: false });
    let out = '', err = '';
    p.stdout.on('data', b => out += b.toString());
    p.stderr.on('data', b => err += b.toString());
    p.on('exit', code => resolve({ code, out: out.trim(), err: err.trim() }));
  });
}

async function findWorkingRBinary(runtimeDir, env) {
  const R_HOME = path.join(runtimeDir, 'R');
  const bin    = path.join(R_HOME, 'bin');
  const bin64  = path.join(bin, 'x64');

  const cand = isWin ? [
    { p: path.join(bin64, 'Rscript.exe'), kind: 'rscript' },
    { p: path.join(bin,   'Rscript.exe'), kind: 'rscript' },
    { p: path.join(bin64, 'Rterm.exe'),   kind: 'rterm'   },
    { p: path.join(bin64, 'R.exe'),       kind: 'rterm'   },
    { p: path.join(bin,   'Rterm.exe'),   kind: 'rterm'   },
    { p: path.join(bin,   'R.exe'),       kind: 'rterm'   },
  ] : [
    { p: path.join(bin, 'Rscript'), kind: 'rscript' },
    { p: path.join(bin, 'R'),       kind: 'rterm'   },
  ];

  for (const c of cand) {
    if (!fs.existsSync(c.p)) continue;
    const t = await probe(c.p, env, c.kind);
    if (t.code === 0 && /OK/.test(t.out)) return c;
  }

  // show the first failure with details
  for (const c of cand) {
    if (fs.existsSync(c.p)) {
      const t = await probe(c.p, env, c.kind);
      throw new Error(
        `R probe failed for ${c.p}\nexit=${t.code}\nstdout=${t.out}\nstderr=${t.err}\n` +
        `PATH=${env.PATH}\nR_HOME=${env.R_HOME}\n`
      );
    }
  }
  throw new Error('No R binary found in runtime.');
}

function argsFor(kind, startShinyScript, appRoot, userDataDir) {
  return kind === 'rscript'
    ? [startShinyScript, appRoot, userDataDir]
    : ['--vanilla', '--slave', '-f', startShinyScript, '--args', appRoot, userDataDir];
}

// Build the environment block that prevents DLL load crashes on Windows
function buildREnv(runtimeDir, userDataDir, dbRoot) {
  const R_HOME = path.join(runtimeDir, 'R');
  const bin    = path.join(R_HOME, 'bin');
  const bin64  = path.join(bin, 'x64');
  const PATH   = [bin, fs.existsSync(bin64) ? bin64 : null, process.env.PATH || '']
                  .filter(Boolean).join(path.delimiter);

  const env = {
    ...process.env,
    R_HOME,
    R_ARCH: isWin ? 'x64' : undefined,
    R_USER: userDataDir,
    R_LIBS_USER: path.join(R_HOME, 'library'),
    PATH
  };

  // IDEP database root (this is what your global.R expects)
  if (dbRoot) env.IDEP_DATABASE = dbRoot;
  env.IDEP_DB_VER = DB_VER;

  return env;
}

// ---- Robust local DB finder (no download) ----------------------------------
const CANDIDATE_DATA_SUBDIR = path.join('data113', 'demo', 'orgInfo.db');

async function findExistingDatabase(app_, fs_, path_) {
  const roots = [
    path_.join(process.resourcesPath, 'data'),
    path_.join(process.resourcesPath, 'app', 'electron', 'data'),
    path_.join(process.resourcesPath, 'app', 'data'),
    path_.join(app_.getPath('userData'), 'resources', 'data'),
    path_.join(app_.getPath('userData'), 'data'),
    app_.getPath('userData')
  ];

  const logFile = path_.join(app_.getPath('userData'), 'shiny-backend.log');
  try { await fs_.ensureFile(logFile); } catch {}
  const log = async (s) => { try { await fs_.appendFile(logFile, s + '\n'); } catch {} };

  for (const root of roots) {
    const p = path_.join(root, CANDIDATE_DATA_SUBDIR);
    if (fs_.existsSync(p)) { await log(`[DB] Found orgInfo at: ${p}`); return root; }
    const nested = path_.join(root, 'electron', CANDIDATE_DATA_SUBDIR);
    if (fs_.existsSync(nested)) { await log(`[DB] Found orgInfo at (electron/...): ${nested}`); return path_.join(root, 'electron'); }
  }

  // recursive last resort
  try {
    let hit = null;
    const walk = (dir) => {
      const ents = fs_.readdirSync(dir, { withFileTypes: true });
      for (const e of ents) {
        const f = path_.join(dir, e.name);
        if (e.isDirectory()) walk(f);
        else if (e.isFile() && e.name.toLowerCase() === 'orginfo.db') { hit = f; throw new Error('__FOUND__'); }
      }
    };
    walk(process.resourcesPath);
  } catch (e) {
    if (String(e.message) === '__FOUND__') {
      const hitDir = path_.dirname(path_.dirname(path_.dirname(hit))); // …/data/data113
      const dbRoot = path_.dirname(hitDir);                            // …/data
      if (dbRoot && fs_.existsSync(dbRoot)) {
        await fs_.appendFile(path_.join(app_.getPath('userData'), 'shiny-backend.log'),
          `[DB] Found by recursive search: ${hit}\n[DB] Using dbRoot: ${dbRoot}\n`);
        return dbRoot;
      }
    }
  }

  throw new Error(
    `iDEP database not found. Looked for ${CANDIDATE_DATA_SUBDIR} under:\n` +
    `- ${path_.join(process.resourcesPath, 'data')}\n` +
    `- ${path_.join(process.resourcesPath, 'app', 'electron', 'data')}\n` +
    `- ${path_.join(process.resourcesPath, 'app', 'data')}\n` +
    `Ensure resources/data/data113/... is packaged.`
  );
}

// ---- Start Shiny -----------------------------------------------------------
async function startShiny(runtimeDir, dbRoot) {
  assertRuntimeLooksRight(runtimeDir);

  const appRoot     = appRootPath();
  const userDataDir = app.getPath('userData');
  const env         = buildREnv(runtimeDir, userDataDir, dbRoot);

  // prefer a launcher that actually runs on THIS machine/layout
  const { p: rbin, kind } = await findWorkingRBinary(runtimeDir, env);

  const startShinyScript = isDev
    ? path.join(appRoot, 'start-shiny.R')
    : path.join(process.resourcesPath, 'app', 'start-shiny.R');

  const args = argsFor(kind, startShinyScript, appRoot, userDataDir);

  shinyProc = spawn(rbin, args, { cwd: appRoot, env, windowsHide: true });
  attachLogging(shinyProc);
  if (!mainWindow) createWindow();
}

// ---- Window / lifecycle ----------------------------------------------------
function createWindow() {
  if (mainWindow) return;

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });

  const url = shinyPort
    ? `http://127.0.0.1:${shinyPort}`
    : 'data:text/html,<h3>Starting Shiny backend...</h3>';

  mainWindow.loadURL(url);
  mainWindow.on('closed', () => { mainWindow = null; });
}

function killChild() {
  if (!shinyProc) return;
  try {
    if (isWin) execSync(`taskkill /pid ${shinyProc.pid} /T /F`);
    else shinyProc.kill('SIGTERM');
  } catch {}
  shinyProc = null;
}

// ---- Single-instance + startup chain --------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(async () => {
  try {
    const runtimeDir = await ensureRuntimeDir();                 // ← returns .../runtime/<os>
    const dbRoot     = await findExistingDatabase(app, fs, path); // ← use FOUND DB path
    await startShiny(runtimeDir, dbRoot);
  } catch (e) {
    dialog.showErrorBox('Startup error', String(e && e.stack || e));
    app.quit();
  }
});

app.on('before-quit', killChild);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (mainWindow === null) createWindow(); });
