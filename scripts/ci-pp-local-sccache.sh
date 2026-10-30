#!/usr/bin/env bash
# Point Cargo at the pp-local container's sccache. The container already sets
# SCCACHE_DIR, SCCACHE_CACHE_SIZE and a host-mounted CARGO_HOME, so this script
# only picks the wrapper and never creates cache directories (GRE-1042).
set -euo pipefail

# sccache cannot cache incremental builds.
echo CARGO_INCREMENTAL=0 >> "$GITHUB_ENV"
# Keep one server for the whole job so the final stats cover every step.
if [ -z "${SCCACHE_IDLE_TIMEOUT:-}" ]; then
  echo SCCACHE_IDLE_TIMEOUT=0 >> "$GITHUB_ENV"
fi

if [ -n "${RUSTC_WRAPPER:-}" ]; then
  echo "RUSTC_WRAPPER is already $RUSTC_WRAPPER"
elif wrapper=$(command -v sccache); then
  echo "RUSTC_WRAPPER=$wrapper" >> "$GITHUB_ENV"
elif [ -x /opt/pp-sccache-bin/sccache ]; then
  echo RUSTC_WRAPPER=/opt/pp-sccache-bin/sccache >> "$GITHUB_ENV"
elif [ -f /opt/pp-sccache-bin ] && [ -x /opt/pp-sccache-bin ]; then
  echo RUSTC_WRAPPER=/opt/pp-sccache-bin >> "$GITHUB_ENV"
else
  echo "::warning::sccache not found on this pp-local runner; building without a compiler cache"
fi

echo "nproc=$(nproc) SCCACHE_DIR=${SCCACHE_DIR:-unset} SCCACHE_CACHE_SIZE=${SCCACHE_CACHE_SIZE:-unset} CARGO_HOME=${CARGO_HOME:-unset} CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-unset}"
free -g 2>/dev/null || true
