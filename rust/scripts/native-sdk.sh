#!/usr/bin/env bash
set -euo pipefail
if [[ -n "${PP_NATIVE_SYSROOT:-}" ]]; then
  export PKG_CONFIG="$PP_NATIVE_SYSROOT/usr/bin/pkgconf"
  export PKG_CONFIG_SYSROOT_DIR="$PP_NATIVE_SYSROOT"
  export PKG_CONFIG_PATH="$PP_NATIVE_SYSROOT/usr/lib/x86_64-linux-gnu/pkgconfig:$PP_NATIVE_SYSROOT/usr/share/pkgconfig:/usr/lib/x86_64-linux-gnu/pkgconfig:/usr/share/pkgconfig"
  export LIBRARY_PATH="$PP_NATIVE_SYSROOT/usr/lib/x86_64-linux-gnu:/usr/lib/x86_64-linux-gnu${LIBRARY_PATH:+:$LIBRARY_PATH}"
  export LD_LIBRARY_PATH="$PP_NATIVE_SYSROOT/usr/lib/x86_64-linux-gnu:$PP_NATIVE_SYSROOT/lib/x86_64-linux-gnu:/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  export RUSTFLAGS="-L native=$PP_NATIVE_SYSROOT/usr/lib/x86_64-linux-gnu -L native=/usr/lib/x86_64-linux-gnu${RUSTFLAGS:+ $RUSTFLAGS}"
fi
