#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

bash .devcontainer/preflight.sh

# Install for the default Node ABI, then build the shared workspace packages.
npm --prefix web ci
npm --prefix web run predev
