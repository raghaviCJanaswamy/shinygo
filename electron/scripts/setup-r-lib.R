#!/usr/bin/env Rscript

# Fast, binary-only installs for Windows CI
options(repos = c(CRAN = "https://cloud.r-project.org"))
options(pkgType = "binary")  # critical on Windows CI
Sys.setenv(R_REMOTES_NO_ERRORS_FROM_WARNINGS = "true")

args <- commandArgs(trailingOnly = TRUE)
if (length(args) < 2) {
  stop("Usage: setup-r-lib.R <r_home> <lib_target>")
}
r_home    <- normalizePath(args[[1]], mustWork = TRUE)
lib_target <- normalizePath(args[[2]], mustWork = FALSE)
if (!dir.exists(lib_target)) dir.create(lib_target, recursive = TRUE, showWarnings = FALSE)

# Put target first but keep existing paths as fallback
.libPaths(c(lib_target, .libPaths()))

# ---- Define packages (no archived/heavy native deps) ----
# Removed: reshape2 (archived), RPostgreSQL (native libpq), sf/terra (GDAL/GEOS/PROJ)
need <- unique(c(
  "shiny","shinyBS","reactable","DBI","RSQLite","ggplot2","gridExtra",
  "plotly","dplyr","DT","httpuv","tidyr","visNetwork","shinybusy",
  "dendextend","igraph"
  # If you relied on reshape2::melt/dcast, use:
  # "data.table"  # for data.table::melt / data.table::dcast
))

# Optional: hard-exclude packages if they sneak in via Suggests
blacklist <- c("reshape2","sf","terra","RPostgreSQL")

# ---- Helper: install with retries, binary-only, minimal deps ----
install_chunk <- function(pkgs) {
  if (!length(pkgs)) return(invisible(TRUE))
  tries <- 3L
  for (i in seq_len(tries)) {
    message(sprintf("Installing (%d/%d): %s", i, tries, paste(pkgs, collapse = ", ")))
    try({
      install.packages(
        pkgs,
        lib          = lib_target,
        type         = "binary",
        dependencies = c("Depends","Imports"),
        Ncpus        = max(1L, parallel::detectCores(logical = TRUE) - 1L)
      )
      return(invisible(TRUE))
    }, silent = TRUE)
    if (i < tries) Sys.sleep(2 * i)
  }
  stop("Failed to install after retries: ", paste(pkgs, collapse = ", "))
}

# ---- Compute to-install (exclude blacklisted if present) ----
ip <- rownames(installed.packages(lib.loc = lib_target))
to_install <- setdiff(setdiff(need, ip), blacklist)

# Install in small batches to reduce transient failures
if (length(to_install)) {
  batch_size <- 8L
  for (idx in seq(1L, length(to_install), by = batch_size)) {
    install_chunk(to_install[idx:min(idx + batch_size - 1L, length(to_install))])
  }
}

# ---- Final sanity: ensure all required pkgs present ----
ip2 <- rownames(installed.packages(lib.loc = lib_target))
missing <- setdiff(need, ip2)
# If any missing are blacklisted, just warn; otherwise, fail
missing_nonblack <- setdiff(missing, blacklist)

if (length(missing_nonblack)) {
  stop(sprintf("Missing after install: %s", paste(missing_nonblack, collapse = ", ")))
} else if (length(missing)) {
  warning(sprintf(
    "Skipped blacklisted packages (by design on Windows CI): %s",
    paste(intersect(missing, blacklist), collapse = ", ")
  ))
}

message("Installed packages in ", lib_target, ":")
print(intersect(need, ip2))
