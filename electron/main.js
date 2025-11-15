// main.js
const { app, BrowserWindow } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
  const fs = require("node:fs");
const net = require("node:net");

function resolveFirstExisting(list) {
  for (const p of list) if (fs.existsSync(p)) return p;
  return null;
}
function resourcesBase() {
  return app.isPackaged ? process.resourcesPath : path.resolve(__dirname, "..");
}

function locateRuntimeAndApp() {
  const base = resourcesBase();

  const rHome = resolveFirstExisting([
    path.join(base, "runtime", "win", "R"),
    path.join(base, "app", "runtime", "win", "R"),
  ]);
  if (!rHome) throw new Error("Bundled R runtime not found.");

  // Prefer 64-bit Rscript
  const rExec64 = path.join(rHome, "bin", "x64", "Rscript.exe");
  const rExec = fs.existsSync(rExec64) ? rExec64 : path.join(rHome, "bin", "Rscript.exe");

  const rLib  = path.join(rHome, "library");
  if (!fs.existsSync(rExec)) throw new Error(`Rscript.exe missing at: ${rExec}`);
  if (!fs.existsSync(rLib))  throw new Error(`R library dir missing at: ${rLib}`);

  const appDir = resolveFirstExisting([
    path.join(base, "shinyapp"),
    path.join(base, "resources", "shinyapp"),
    path.join(base, "app", "resources", "shinyapp"),
  ]);
  if (!appDir) throw new Error("Shiny app folder not found.");

  for (const f of ["server.R", "ui.R"]) {
    const p = path.join(appDir, f);
    if (!fs.existsSync(p)) throw new Error(`Missing ${f} in app: ${p}`);
  }

  // Data root that global.R should use
  const dataRoot = path.join(base, "data"); // <resources>/data

  return { rHome, rExec, rLib, appDir, base, dataRoot };
}

// Ensure the layout nudges global.R to download if db/ is missing
function preflightData(dataRoot, logFile) {
  const verDir  = path.join(dataRoot, "data113");
  const demoOrg = path.join(verDir, "demo", "orgInfo.db");
  const dbDir   = path.join(verDir, "db");

  try {
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.mkdirSync(verDir,   { recursive: true });

    if (fs.existsSync(dbDir)) {
      fs.appendFileSync(logFile, `[NODE][preflight] db/ present at ${dbDir}\n`);
      return;
    }

    // If only demo is present, remove orgInfo.db so global.R triggers the download
    if (fs.existsSync(demoOrg)) {
      fs.appendFileSync(logFile, `[NODE][preflight] removing demo orgInfo.db to trigger download: ${demoOrg}\n`);
      fs.unlinkSync(demoOrg);
    } else {
      fs.appendFileSync(logFile, `[NODE][preflight] no db/ and no demo orgInfo.db; download should trigger\n`);
    }
  } catch (e) {
    // non-fatal; R will still try and then fail with a clear message if needed
    try { fs.appendFileSync(logFile, `[NODE][preflight] warning: ${String(e)}\n`); } catch {}
    console.warn("[preflightData] warning:", e);
  }
}

function waitForPort(host, port, timeoutMs = 60000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    (function tryOnce() {
      const s = net.connect({ host, port }, () => { s.end(); resolve(); });
      s.on("error", () => {
        s.destroy();
        if (Date.now() - start > timeoutMs) reject(new Error(`Timed out waiting for ${host}:${port}`));
        else setTimeout(tryOnce, 300);
      });
    })();
  });
}

function launchShiny(port) {
  const { rHome, rExec, rLib, appDir, base, dataRoot } = locateRuntimeAndApp();

  const logFile = path.join(app.getPath("userData"), "shiny-startup.log");
  fs.mkdirSync(path.dirname(logFile), { recursive: true });

  fs.writeFileSync(
    logFile,
    [
    "=== Shiny bootstrap ===",
    `isPackaged: ${app.isPackaged}`,
    `resourcesBase: ${base}`,
    `Rscript: ${rExec}`,
    `Rlib   : ${rLib}`,
    `appDir : ${appDir}`,
    `dataRoot: ${dataRoot}`,
    "=======================",
    ""
    ].join("\n"),
    "utf8"
  );

  // Make sure data layout will cause global.R to download if needed
  preflightData(dataRoot, logFile);

  // R code: log early arch info BEFORE sink, then sink everything to file
  const runCode = `
    logf <- "${logFile.replace(/\\/g, "/")}"

    # Early diagnostics BEFORE sink (helps if R crashes early)
    try(cat("[R] starting Rscript…\\n"), silent=TRUE)
    try(cat("[R] R.home(): ", R.home(), "\\n", sep=""), silent=TRUE)
    try(cat("[R] R.version$arch: ", R.version$arch, "\\n", sep=""), silent=TRUE)

    # Redirect all output to the log
    con <- file(logf, open="at"); sink(con, split=TRUE); sink(con, type="message", split=TRUE)

    .libPaths(c("${rLib.replace(/\\/g, "/")}"))
    Sys.setenv(
      R_HOME        = "${rHome.replace(/\\/g, "/")}",
      R_LIBS        = "${rLib.replace(/\\/g, "/")}",
      R_LIBS_USER   = "${rLib.replace(/\\/g, "/")}",
      IDEP_DATABASE = "${dataRoot.replace(/\\/g, "/")}"
    )
    
    options(
      repos = c(CRAN="https://cloud.r-project.org"),
      shiny.port = ${port},
      shiny.host = "127.0.0.1",
      timeout = 600,
      download.file.method = "libcurl"
    )

    dir.create(file.path(Sys.getenv("IDEP_DATABASE"), "data113"), recursive=TRUE, showWarnings=FALSE)

    cat("[R] IDEP_DATABASE: ", Sys.getenv("IDEP_DATABASE"), "\\n"); flush.console()
    cat("[R] getwd: ", getwd(), "\\n"); flush.console()
    cat("[R] .libPaths: ", paste(.libPaths(), collapse="; "), "\\n"); flush.console()

    # quick network probe to the tarball (logs connectivity only)
    cat("[R] network probe to data URL...\\n"); flush.console()
    tryCatch({
      u <- url("http://bioinformatics.sdstate.edu/data/data113/data113.tar.gz", "rb"); close(u)
      cat("[R] probe OK\\n"); flush.console()
    }, error=function(e) {
      cat("[R] probe failed: ", conditionMessage(e), "\\n"); flush.console()
    })

    req <- c("shiny","httpuv","RSQLite","DBI","dplyr","tidyr","DT","plotly",
             "visNetwork","igraph","dendextend","ggplot2","gridExtra",
             "shinyBS","reactable","shinybusy")
    for (p in req) {
      cat("[R] loading: ", p, "…\\n"); flush.console()
      suppressPackageStartupMessages(library(p, character.only=TRUE))
    }

    setwd("${appDir.replace(/\\/g, "/")}")
    cat("[R] app files: ", paste(list.files(".", recursive=TRUE), collapse=", "), "\\n"); flush.console()
    cat("[R] running app…\\n"); flush.console()

    shiny::runApp(".", launch.browser=FALSE)
  `;

  const rBin    = path.join(rHome, "bin");
  const rBinX64 = path.join(rHome, "bin", "x64");

  fs.appendFileSync(
    logFile,
    `[NODE] about to spawn R\n` +
    `[NODE] process.resourcesPath = ${process.resourcesPath}\n` +
    `[NODE] dataRoot (resources/data) = ${dataRoot}\n` +
    `[NODE] (child env) IDEP_DATABASE = ${dataRoot}\n\n`,
    "utf8"
  );

  // NOTE: x64 FIRST on PATH; export R_ARCH=x64
  const child = spawn(
    rExec,
    ["--no-restore", "--no-save", "--no-site-file", "--no-init-file", "-e", runCode],
    {
      stdio: ["ignore", "ignore", "ignore"],   // all R output goes to the log via sink()
    windowsHide: true,
    env: {
      ...process.env,
        PATH: [rBinX64, rBin, process.env.PATH || ""].join(path.delimiter),
        R_HOME: rHome,
        R_LIBS: rLib,
        R_LIBS_USER: rLib,
        R_ARCH: "x64",               // <- critical to avoid 32/64-bit DLL mismatches
        IDEP_DATABASE: dataRoot      // reinforce for child process
      }
    }
  );

  child.on("exit", code => fs.appendFileSync(logFile, `\n[R EXIT] ${code}\n`, "utf8"));

  const isReady = async () => {
    try { await waitForPort("127.0.0.1", port, 1000); return true; } catch { return false; }
  };

  return { child, logFile, isReady, getErr: () => "", getOut: () => "" };
}

async function createWindow() {
  const port = 39845;
  let proc;
  const win = new BrowserWindow({ width: 1200, height: 800, webPreferences: { contextIsolation: true } });

  try {
    proc = launchShiny(port);
    // poll until port is open (Shiny bound)
    const start = Date.now();
    while (!(await proc.isReady())) {
      if (Date.now() - start > 60000) throw new Error("Timed out waiting for Shiny to bind the port");
      await new Promise(r => setTimeout(r, 300));
    }
    await win.loadURL(`http://127.0.0.1:${port}/`);
  } catch (err) {
    const msg = [
      "Failed to start Shiny.",
      "",
      String(err),
      "",
      "See log file:",
      proc?.logFile || "(no log file)",
      "",
      "STDERR:",
      "(empty)",
      "",
      "STDOUT:",
      "(empty)"
    ].join("\n");
    await win.loadURL("data:text/plain," + encodeURIComponent(msg));
  }

  win.on("closed", () => {
    if (proc?.child && !proc.child.killed) { try { proc.child.kill(); } catch(_) {} }
  });
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
