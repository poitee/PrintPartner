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

# Use a candidate only if it runs and reports itself as sccache.
is_sccache() {
  [ -n "$1" ] && [ -f "$1" ] && [ -x "$1" ] || return 1
  local version
  version=$("$1" --version 2>/dev/null) || return 1
  [[ $version == "sccache "* ]]
}

if [ -n "${RUSTC_WRAPPER:-}" ]; then
  echo "RUSTC_WRAPPER is already $RUSTC_WRAPPER"
else
  wrapper=
  # PATH first, then the fleet's install paths, then any sccache the image already
  # ships under /opt, /usr/local or CARGO_HOME. Nothing is downloaded or installed.
  mapfile -t found < <(find /opt /usr/local "${CARGO_HOME:-$HOME/.cargo}/bin" -maxdepth 4 \
    -name sccache -type f -perm -u+x 2>/dev/null | sort || true)
  for candidate in "$(command -v sccache || true)" /opt/pp-sccache-bin/sccache /opt/pp-sccache-bin \
      /opt/sccache-bin/sccache "${found[@]}"; do
    if is_sccache "$candidate"; then wrapper=$candidate; break; fi
  done
  if [ -n "$wrapper" ]; then
    echo "RUSTC_WRAPPER=$wrapper" >> "$GITHUB_ENV"
    "$wrapper" --version
  else
    echo "::warning::sccache not found on this pp-local runner; building without a compiler cache"
    echo "Top level of /opt, then any *sccache* path up to three levels down:"
    find /opt -mindepth 1 -maxdepth 1 2>/dev/null | head -40 || true
    find /opt /usr/local -maxdepth 3 -iname '*sccache*' 2>/dev/null | head -40 || true
  fi
fi

echo "nproc=$(nproc) SCCACHE_DIR=${SCCACHE_DIR:-unset} SCCACHE_CACHE_SIZE=${SCCACHE_CACHE_SIZE:-unset} CARGO_HOME=${CARGO_HOME:-unset} CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-unset}"
free -g 2>/dev/null || true
