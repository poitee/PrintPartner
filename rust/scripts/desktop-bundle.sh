#!/usr/bin/env bash
set -euo pipefail
repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
stage="${PP_DESKTOP_STAGE:?Set PP_DESKTOP_STAGE to a completed target-native stage}"
[[ "$(uname -s)" == "Darwin" ]] || { echo "The app bundle helper requires macOS" >&2; exit 1; }
export MACOSX_DEPLOYMENT_TARGET="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["bundle"]["macOS"]["minimumSystemVersion"])' "$repo/rust/crates/pp-desktop/tauri.conf.json")"
export PP_DESKTOP_RELEASE_MANIFEST="$stage/bundle-manifest.json"
cd "$repo/rust/crates/pp-desktop"
cargo tauri build --config "$stage/bundle-config.json" --no-sign --no-binary-patching --bundles app
