#!/usr/bin/env bash
# Prepare a Factory Environment instance for Print Partner Mission workers.
# Use it as the repository setup script: `bash scripts/factory-environment/setup.sh`.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

RUSTUP_VERSION=1.29.2
NODE_RUNTIME=24.21.0
NODE_PARITY=22.23.3
PREFIX="${PP_TOOL_PREFIX:-$HOME/.local/print-partner}"

case "$(uname -m)" in
  x86_64)
    node_arch=x64 rust_triple=x86_64-unknown-linux-gnu
    rustup_sha=5be191e8c70a5007074254cb74d78dbfdd25cd5a61c27de7b8e5410122ec24f4
    runtime_sha=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6
    parity_sha=df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de ;;
  aarch64)
    node_arch=arm64 rust_triple=aarch64-unknown-linux-gnu
    rustup_sha=a9c168dbea81a84671c6b7a5c1795cb0eb699020110d107ddfca427bd797e697
    runtime_sha=6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2
    parity_sha=a44aeb94849a299b22df10b9e622ec2f605c2183501bc40590705131de7c740f ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

packages=(build-essential ca-certificates curl git xz-utils python3 python3-venv
  pkg-config libssl-dev libglib2.0-dev libgtk-3-dev libwebkit2gtk-4.1-dev
  libsoup-3.0-dev libayatana-appindicator3-dev librsvg2-dev)
if [[ $(id -u) == 0 ]]; then
  as_root=()
elif sudo -n true 2>/dev/null; then
  as_root=(sudo -n)
else
  echo "Root or passwordless sudo is required to install: ${packages[*]}" >&2
  exit 1
fi
"${as_root[@]}" apt-get update
"${as_root[@]}" env DEBIAN_FRONTEND=noninteractive \
  apt-get install -y --no-install-recommends "${packages[@]}"

download() { # url sha256 destination
  curl -fsSL --retry 3 -o "$3" "$1"
  echo "$2  $3" | sha256sum -c --quiet -
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$PREFIX"
for spec in "node24 $NODE_RUNTIME $runtime_sha" "node22 $NODE_PARITY $parity_sha"; do
  read -r name version sha <<<"$spec"
  if [[ ! -x "$PREFIX/$name/bin/node" || "$("$PREFIX/$name/bin/node" --version)" != "v$version" ]]; then
    archive="$work/node-$version.tar.xz"
    download "https://nodejs.org/dist/v$version/node-v$version-linux-$node_arch.tar.xz" "$sha" "$archive"
    rm -rf "${PREFIX:?}/${name:?}" && mkdir -p "$PREFIX/$name"
    tar -xJf "$archive" -C "$PREFIX/$name" --strip-components 1
  fi
done

export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}" RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
if [[ ! -x "$CARGO_HOME/bin/rustup" ]]; then
  download "https://static.rust-lang.org/rustup/archive/$RUSTUP_VERSION/$rust_triple/rustup-init" \
    "$rustup_sha" "$work/rustup-init"
  chmod +x "$work/rustup-init"
  "$work/rustup-init" -y --no-modify-path --default-toolchain none --profile minimal
fi
# rust-toolchain.toml names the version and components.
"$CARGO_HOME/bin/rustup" toolchain install
# Outside the checkout no toolchain file applies, so make the pinned one the default.
"$CARGO_HOME/bin/rustup" default "$("$CARGO_HOME/bin/rustup" show active-toolchain | cut -d" " -f1)"

python3 -m venv "$PREFIX/sidecar-venv"
"$PREFIX/sidecar-venv/bin/pip" install --quiet flask==3.1.3 waitress==3.0.2

cat >"$PREFIX/env.sh" <<ENV
export PATH="$PREFIX/node24/bin:$CARGO_HOME/bin:\$PATH"
export CARGO_HOME="$CARGO_HOME" RUSTUP_HOME="$RUSTUP_HOME"
export PP_SCHEMA_PARITY_NODE="$PREFIX/node22/bin/node"
export INSTA_UPDATE=no
ENV
for profile in "$HOME/.bashrc" "$HOME/.profile"; do
  grep -qsF "$PREFIX/env.sh" "$profile" || echo ". \"$PREFIX/env.sh\"" >>"$profile"
done
# shellcheck source=/dev/null
. "$PREFIX/env.sh"

test "$(node --version)" = "v$NODE_RUNTIME"
test "$("$PP_SCHEMA_PARITY_NODE" --version)" = "v$NODE_PARITY"
rustc --version
cargo clippy --version
npm --prefix web ci
npm --prefix web run predev
echo "Print Partner environment ready. New shells load $PREFIX/env.sh."
