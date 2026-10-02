#!/usr/bin/env bash
set -euo pipefail
repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
node="${PP_DEV_NODE:?Set PP_DEV_NODE to the absolute Node 24.21.0 executable}"
[[ "$node" == /* && -x "$node" ]] || { echo "PP_DEV_NODE must be an absolute executable path" >&2; exit 1; }
export PATH="$(dirname -- "$node"):$PATH"
stage="${PP_DEV_STAGE:-$(mktemp -d)/runtime}"
data="${PP_DEV_DATA:-$(mktemp -d)}"
source "$repo/rust/scripts/native-sdk.sh"
VITE_PRINT_PARTNER_DESKTOP=1 npm --prefix "$repo/web" run build
python3 "$repo/rust/scripts/stage-desktop.py" --web "$repo/web" --node "$node" --output "$stage" --commit "$(git -C "$repo" rev-parse HEAD)"
export PP_DESKTOP_RELEASE_MANIFEST="$stage/bundle-manifest.json"
cargo build --manifest-path "$repo/rust/Cargo.toml" --locked -p pp-desktop
exec "$repo/rust/target/debug/pp-desktop" --dev-stage "$stage" --data "$data"
