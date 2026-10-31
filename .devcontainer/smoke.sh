#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

test "$(id -u)" != 0
test "$(node --version)" = v24.21.0
test "$("${PP_SCHEMA_PARITY_NODE:?Parity Node must be configured}" --version)" = v22.23.3
test "$(rustc --version | cut -d ' ' -f 2)" = 1.99.0
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
