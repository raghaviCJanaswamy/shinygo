# electron/scripts/get_r_windows.ps1
$ErrorActionPreference = "Stop"

# -------- Config --------
$Rver = $env:R_VERSION

if (-not $Rver -or $Rver -eq "") { $Rver = "4.4.2" }   # default version

$out    = "r-win"
$outAbs = Join-Path (Get-Location) $out
New-Item -ItemType Directory -Force -Path $out | Out-Null

Write-Host "Using R version: $Rver"
Write-Host "Output base: $outAbs"

# Candidate URLs (try old/ and base/ mirrors)
$urls = @(
  "https://cloud.r-project.org/bin/windows/base/old/$Rver/R-$Rver-win.exe",
  "https://cran.r-project.org/bin/windows/base/old/$Rver/R-$Rver-win.exe",
  "https://cloud.r-project.org/bin/windows/base/R-$Rver-win.exe",
  "https://cran.r-project.org/bin/windows/base/R-$Rver-win.exe"
)

# Temp dir for download + install
$tmp = New-Item -ItemType Directory -Force -Path (Join-Path $env:TEMP ("rwin_" + [Guid]::NewGuid())) | Select-Object -ExpandProperty FullName

try {
  # -------- Download installer --------
  $exe = Join-Path $tmp "R-$Rver-win.exe"
  $downloaded = $false

  foreach ($u in $urls) {
    Write-Host "Trying $u ..."
    try {
      Invoke-WebRequest -Uri $u -OutFile $exe -UseBasicParsing
      if ((Get-Item $exe).Length -gt 0) {
        $downloaded = $true
        Write-Host "Downloaded $u"
        break
      }
    }
    catch {
      Write-Host "Download failed from $u, trying next mirror..."
    }
  }

  if (-not $downloaded) {
    throw "Failed to download R-$Rver Windows installer from all candidates."
  }

  # -------- Run installer silently into a private directory --------
  $installRoot = Join-Path $tmp "R-full"
  New-Item -ItemType Directory -Force -Path $installRoot | Out-Null

  Write-Host "Running R installer in silent mode to $installRoot ..."
  & $exe /VERYSILENT /DIR="$installRoot" /NORESTART /SP- /SUPPRESSMSGBOXES | Out-Null

  # -------- Locate Rscript.exe under the installed tree --------
  $rscript = Get-ChildItem -Recurse -Path $installRoot -Filter Rscript.exe -File -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $rscript) {
    throw "Rscript.exe not found under $installRoot after running installer."
  }

  # R home is the directory that owns bin\Rscript.exe
  $rHome = $rscript.Directory.Parent
  Write-Host "Detected R home: $($rHome.FullName)"

  if (-not (Test-Path (Join-Path $rHome.FullName "bin\R.exe"))) {
    throw "Found Rscript.exe but expected R.exe in same bin folder; layout unexpected at $($rHome.FullName)"
  }

  # -------- Normalize to r-win/R/... --------
  $dest = Join-Path $outAbs "R"
  if (Test-Path $dest) {
    Write-Host "Cleaning existing $dest ..."
    Remove-Item -Recurse -Force $dest
  }
  New-Item -ItemType Directory -Force -Path $dest | Out-Null

  Write-Host "Copying portable R from $($rHome.FullName) to $dest ..."
  Copy-Item -Recurse -Force -Path $rHome.FullName -Destination $dest

  Write-Host "Contents of $dest after copy:"
  Get-ChildItem -Recurse $dest | ForEach-Object { $_.FullName }

  # Look for Rscript.exe anywhere under r-win/R
  $destRscript = Get-ChildItem -Recurse -Path $dest -Filter Rscript.exe -File -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $destRscript) {
    throw "Final Rscript.exe not found anywhere under $dest"
  }

  Write-Host "Rscript located at: $($destRscript.FullName)"
  Write-Host "Rscript version:"
  & $destRscript.FullName --version

  Write-Host "✅ Windows R runtime ready under $dest"
}
finally {
  if (Test-Path $tmp) {
    Write-Host "Cleaning up temp dir $tmp ..."
    Remove-Item -Recurse -Force $tmp
  }
}
