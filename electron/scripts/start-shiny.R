#!/usr/bin/env Rscript

args <- commandArgs(trailingOnly = TRUE)
if (length(args) < 2) {
  stop("Usage: start-shiny.R <app_root> <user_data_dir>")
}
log <- function(...) { cat(sprintf(...), "\n"); try(flush.console(), silent = TRUE) }


app_root <- normalizePath(args[[1]], mustWork = TRUE)
user_data <- normalizePath(args[[2]], mustWork = FALSE)
if (!dir.exists(user_data)) {
  dir.create(user_data, recursive = TRUE, showWarnings = FALSE)
}

# -----------------------------------------------------------------------------
# 1) Database location (parent dir of data113/, as expected by global.R)
# -----------------------------------------------------------------------------
db_root   <- file.path(user_data, "idep-data")   # IDEP_DATABASE
db_ver    <- "data113"
datapath  <- file.path(db_root, db_ver)         # <db_root>/data113
Sys.setenv(IDEP_DATABASE = db_root)

cat("start-shiny: app_root     = ", app_root,  "\n", sep = "")
cat("start-shiny: user_data    = ", user_data, "\n", sep = "")
cat("start-shiny: IDEP_DATABASE= ", Sys.getenv("IDEP_DATABASE"), "\n", sep = "")
cat("start-shiny: datapath     = ", datapath,  "\n", sep = "")

# -----------------------------------------------------------------------------
# 2) Ensure full data113 bundle exists under IDEP_DATABASE
#    - We want:
#        <datapath>/demo/orgInfo.db
#        <datapath>/db/*.db
# -----------------------------------------------------------------------------
ensure_data113 <- function(db_root, db_ver = "data113", app_root = NULL) {
  base_url  <- "https://bioinformatics.sdstate.edu/data/"
  datapath  <- file.path(db_root, db_ver)
  demo_db   <- file.path(datapath, "demo", "orgInfo.db")
  db_dir    <- file.path(datapath, "db")

  cat("ensure_data113: db_root  = ", db_root,  "\n", sep = "")
  cat("ensure_data113: datapath = ", datapath, "\n", sep = "")

  # helper to list .db files safely
  list_db_files <- function(path) {
    if (!dir.exists(path)) return(character(0))
    list.files(path, pattern = "[.]db$", full.names = TRUE)
  }

  have_org <- file.exists(demo_db)
  db_files <- list_db_files(db_dir)
  have_db  <- length(db_files) > 0

  if (have_org && have_db) {
    cat("ensure_data113: existing data113 bundle is OK.\n")
    cat("  orgInfo.db: ", demo_db, "\n", sep = "")
    cat("  db files:   ", length(db_files), "\n", sep = "")
    return(invisible(TRUE))
  }

  cat("ensure_data113: data113 missing or incomplete; downloading...\n")

  dir.create(datapath, recursive = TRUE, showWarnings = FALSE)

  tar_url  <- paste0(base_url, db_ver, "/", db_ver, ".tar.gz")
  tar_path <- file.path(datapath, paste0(db_ver, ".tar.gz"))

  cat("  Download URL: ", tar_url,  "\n", sep = "")
  cat("  Saving to:    ", tar_path, "\n", sep = "")

  options(timeout = 300)

  tryCatch(
    {
      download.file(
        url      = tar_url,
        destfile = tar_path,
        mode     = "wb",
        quiet    = FALSE
      )
    },
    error = function(e) {
      stop("Failed to download data bundle from ", tar_url,
           "\n  Reason: ", conditionMessage(e))
    }
  )

  cat("  Unpacking into: ", db_root, "\n", sep = "")
  # Tarball expands to data113/, so exdir must be the parent (db_root)
  tryCatch(
    {
      untar(tar_path, exdir = db_root)
    },
    error = function(e) {
      warning("untar failed: ", conditionMessage(e))
    }
  )

  if (file.exists(tar_path)) {
    file.remove(tar_path)
  }

  # Re-check after untar
  demo_db <- file.path(datapath, "demo", "orgInfo.db")
  db_dir  <- file.path(datapath, "db")

  have_org <- file.exists(demo_db)
  db_files <- list_db_files(db_dir)

  cat("  orgInfo.db exists? ", have_org, "\n", sep = "")
  cat("  # of species .db files after untar: ", length(db_files), "\n", sep = "")

  # If orgInfo.db missing, that is fatal
  if (!have_org) {
    stop(
      "orgInfo.db not found at: ", demo_db,
      "\nCheck IDEP_DATABASE / datapath configuration and data113 layout."
    )
  }

  # If we still have no species DBs, try to reuse an existing system copy
  if (!length(db_files)) {
    cat("  No .db files found in ", db_dir, " after untar.\n", sep = "")
    cat("  Trying to reuse an existing data113 bundle on this system...\n")

    # candidate locations that might already have the full data113
    fallback_roots <- unique(c(
      "/data113",                              # system-wide
      file.path(app_root, "data113"),         # repo/data113
      file.path(dirname(app_root), "data113") # parent/data113
    ))

    for (fr in fallback_roots) {
      cand_demo <- file.path(fr, "demo", "orgInfo.db")
      cand_db   <- file.path(fr, "db")

      if (file.exists(cand_demo) &&
          length(list_db_files(cand_db)) > 0) {

        cat("  Found existing data113 at: ", fr, "\n", sep = "")
        cat("  Copying orgInfo.db and db/*.db into per-user cache...\n")

        # ensure dirs
        dir.create(file.path(datapath, "demo"), recursive = TRUE, showWarnings = FALSE)
        dir.create(db_dir, recursive = TRUE, showWarnings = FALSE)

        # copy orgInfo.db
        file.copy(cand_demo, demo_db, overwrite = TRUE)

        # copy db files
        file.copy(list_db_files(cand_db), db_dir, overwrite = TRUE)

        # refresh db_files and break if successful
        db_files <- list_db_files(db_dir)
        cat("  After copy, # of species .db files: ", length(db_files), "\n", sep = "")
        if (length(db_files)) break
      }
    }
  }

  # Final status
  if (!length(db_files)) {
    warning(
      "No .db species files found in: ", db_dir, "\n",
      "The app will start, but species-specific queries (e.g. enrichment) ",
      "will fail until you provide the mapping DBs into that folder."
    )
  }

  invisible(TRUE)
}

# Make sure the bundle is ready
ensure_data113(db_root, db_ver = db_ver, app_root = app_root)

# -----------------------------------------------------------------------------
# 3) Figure out where our bundled R library should live
#    - In dev:   <repo>/electron/runtime/R-lib
#    - In prod:  <resources>/runtime/R-lib  (parent of app_root)
# -----------------------------------------------------------------------------
find_bundle_lib <- function(app_root) {
  # Dev layout: repo root is app_root, electron/runtime/R/library exists
  dev_lib <- file.path(app_root, "electron", "runtime", "R", "library")
  if (dir.exists(dev_lib)) return(dev_lib)

  # Packaged layout: app_root = <resources>/app, runtime/R/library is sibling
  res_dir <- dirname(app_root)
  prod_lib <- file.path(res_dir, "runtime", "R", "library")
  if (dir.exists(prod_lib) || dir.exists(dirname(prod_lib))) return(prod_lib)

  # Fallback: put it into user_data
  file.path(user_data, "R-lib")
}

bundle_lib <- find_bundle_lib(app_root)
dir.create(bundle_lib, recursive = TRUE, showWarnings = FALSE)

# Put bundled lib first
.libPaths(c(bundle_lib, .libPaths()))
cat("Library paths:\n"); print(.libPaths())

# -----------------------------------------------------------------------------
# 4) Ensure required packages are installed into bundle_lib
# -----------------------------------------------------------------------------
options(repos = c(CRAN = "https://cloud.r-project.org"))

needed_pkgs <- c(
  "shiny",
  "shinyBS",
  "reactable",
  "DBI",
  "RSQLite",
  "ggplot2",
  "gridExtra",
  "plotly",
  "reshape2",
  "visNetwork",
  "shinybusy",
  "dplyr",
  "DT",
  "httpuv"
)

ip <- installed.packages(lib.loc = bundle_lib)
missing <- setdiff(needed_pkgs, rownames(ip))

if (length(missing)) {
  cat("Installing missing packages into:", bundle_lib, "\n")
  cat("Missing:", paste(missing, collapse = ", "), "\n")

  tryCatch(
    {
      install.packages(missing, lib = bundle_lib, dependencies = TRUE)
    },
    error = function(e) {
      message("ERROR installing packages: ", conditionMessage(e))
      stop("Failed to install required R packages. Check your network / permissions.")
    }
  )

  # Re-check
  ip2 <- installed.packages(lib.loc = bundle_lib)
  still_missing <- setdiff(needed_pkgs, rownames(ip2))
  if (length(still_missing)) {
    stop("Still missing packages after install: ",
         paste(still_missing, collapse = ", "))
  }
} else {
  cat("All required packages already present in bundle lib.\n")
}

# Load key packages explicitly to fail early if anything is broken
suppressPackageStartupMessages({
  library(shiny)
  library(DBI)
  library(RSQLite)
})

# -----------------------------------------------------------------------------
# 5) Start Shiny app
# -----------------------------------------------------------------------------
port <- httpuv::randomPort()

options(shiny.port = port, shiny.host = "127.0.0.1")

log("[APP] USING_PORT %d", port)   
setwd(app_root)

shiny::runApp(
  appDir = app_root,
  host = "127.0.0.1",
  port = port,
  launch.browser = FALSE
)
