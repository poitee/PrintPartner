#!/usr/bin/env bash
set -euo pipefail

sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  build-essential ca-certificates curl git python3 python3-venv \
  pkg-config tar zstd unzip zip xz-utils jq gh procps psmisc lsof \
  file binutils iproute2 netcat-openbsd iptables
