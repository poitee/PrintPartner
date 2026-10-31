#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

test "$(node --version)" = v24.21.0
test "$("${PP_SCHEMA_PARITY_NODE:?Parity Node must be configured}" --version)" = v22.23.3
test "$(rustc --version | cut -d ' ' -f 2)" = 1.99.0

# Install for the default Node ABI, then build the shared workspace packages.
npm --prefix web ci
npm --prefix web run build -w @print-partner/contracts
npm --prefix web run build -w @print-partner/domain
