# Building

The repository has two build trees:

- `web/` holds the React web UI and the Node server that the Rust core replaces.
- `rust/` holds the Rust workspace. [Architecture](../ARCHITECTURE.md#crate-map) lists its crates.

## Web

Use Node 22 and npm 10 or later. From the repository root:

```sh
cd web
npm ci
npm run quality
```

Run `npm run quality` before you open a PR that changes `web/`. The root [README](../../README.md#local-development) describes the dev server and the package layout.

## Rust

Use the toolchain pinned in `rust-toolchain.toml`. These commands check formatting and lints for the whole workspace and build the headless launcher:

```sh
cargo fmt --manifest-path rust/Cargo.toml --all --check
cargo clippy --manifest-path rust/Cargo.toml --locked --workspace --all-targets -- -D warnings
cargo build --manifest-path rust/Cargo.toml --locked -p pp-server
```

To compile the flagged rebuild code, select a crate and add `--features desktop_rebuild`. For example:

```sh
cargo check --manifest-path rust/Cargo.toml --locked -p pp-storage --features desktop_rebuild
```

The workspace also has these checks:

- `python3 rust/scripts/check-boundaries.py --self-test` checks that each crate depends only on the crates it is allowed to use.
- `python3 rust/scripts/check-ast-grep.py` checks the ast-grep lint counts against `rust/ast-grep-baseline.json`.

[rust/README.md](../../rust/README.md) has the full command list. Some tests need the built web assets and the desktop bundle manifest that it describes. [rust/scripts/AGENTS.md](../../rust/scripts/AGENTS.md) has the rules for files under `rust/scripts/`.

## Desktop app

[pp-desktop/README.md](../../rust/crates/pp-desktop/README.md) describes how to run the native development app. [Desktop app](../desktop.md) describes the app itself.
