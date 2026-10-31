#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ $# -gt 1 || ( $# -eq 1 && "$1" != --runtime ) ]]; then
  echo "Usage: bash .devcontainer/smoke.sh [--runtime]" >&2
  exit 2
fi

test "$(id -u)" != 0
bash .devcontainer/preflight.sh
cargo fmt --version
cargo clippy --version
pkg-config --modversion gtk+-3.0 webkit2gtk-4.1 libsoup-3.0

python3 - <<'PY'
from pathlib import Path
import tempfile
import venv

with tempfile.TemporaryDirectory(prefix="pp-venv-smoke-") as temporary:
    venv.EnvBuilder(with_pip=True).create(Path(temporary) / "venv")
print("Python virtual environment with pip: passed")
PY

# No assets, generated manifest, native window, printer, or real data required.
cargo test --manifest-path rust/Cargo.toml --locked -p pp-domain --lib
cargo test --manifest-path rust/Cargo.toml --locked -p pp-domain --lib --features desktop_rebuild
npm --prefix web exec -w @print-partner/web -- vitest run src/lib/supportLinks.test.ts
npm --prefix web exec -w @print-partner/server -- vitest run src/services/gcode-object-parser.test.ts
(cd slicer-sidecar && "${PP_SIDECAR_PYTHON:-/opt/sidecar-venv/bin/python}" -B -m unittest test_sidecar.py test_shutdown.py)

if [[ ${1:-} == --runtime ]]; then
  python3 scripts/local-ci.py --only web-assets --fail-on-skip

  # Cargo permits zero matches. Require a nonzero executed result as well.
  LOG="$(mktemp)"
  trap 'rm -f "$LOG"' EXIT
  cargo_tests() {
    cargo test --manifest-path rust/Cargo.toml --locked "$@" | tee "$LOG"
    grep -Eq 'test result: ok\. [1-9][0-9]* passed;' "$LOG"
  }
  cargo_tests -p pp-server --bin pp-server
  cargo_tests -p pp-server --test cli
  cargo_tests -p pp-desktop --lib browser::tests
  cargo_tests -p pp-desktop --lib browser::tests --features desktop_rebuild
fi
