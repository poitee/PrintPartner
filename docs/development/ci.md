# Continuous integration

The **Rust cross-OS** workflow (`.github/workflows/rust-cross-os.yml`) builds and tests the Rust workspace on Linux, macOS and Windows. It runs on every pull request and on every push to `main`. Its purpose is to stop code that compiles on one OS only from reaching `main`.

## The matrix

The workflow has one job per OS. Each job uses the toolchain pinned in `rust-toolchain.toml`.

| Check name | Runner | Packages | Tests |
|------------|--------|----------|-------|
| `rust (linux)` | `ubuntu-latest` | The whole workspace | All |
| `rust (macos)` | `macos-26` | The whole workspace | All except [macOS exclusions](#macos-exclusions) |
| `rust (windows)` | `windows-latest` | The workspace without [Windows exclusions](#windows-exclusions) | All in those packages |

Each job runs these steps in order:

1. Install the toolchain, nextest 0.9.148, Node 22.23.3 for the storage fixtures, and Node 24.21.0.
2. Build the desktop web assets and write `rust/bundle-manifest.json`. `pp-compat` embeds this file at compile time.
3. On macOS only, mount a case-sensitive APFS volume at `/Volumes/pptmp` and set `TMPDIR` to `/Volumes/pptmp/tmp`.
4. `cargo fmt --check`.
5. `cargo clippy -D warnings`, with `desktop_rebuild` off.
6. `cargo clippy -D warnings`, with `desktop_rebuild` on.
7. `cargo nextest run`, with `desktop_rebuild` off.
8. `cargo nextest run`, with `desktop_rebuild` on.

The macOS volume exists because the default macOS `TMPDIR` breaks three kinds of test. Its paths are too long for Unix socket names, it is under the `/var` symbolic link that no-follow opens refuse, and it treats `Straße.stl` and `STRASSE.stl` as one name.

Steps 4 to 8 run even when an earlier one of them fails, so one run reports every failure. Clippy uses `--keep-going`, so it reports errors in every crate whose dependencies compile.

The `include` list in the workflow is the only place that names runner labels, the per-OS package scope (`scope`) and the per-OS nextest filter (`tests`). To move a job to a self-hosted runner, change its `runner` value there.

## Run a job locally

To run the same checks on your machine, build the assets and manifest first. From the repository root:

```sh
npm --prefix web ci
VITE_PRINT_PARTNER_DESKTOP=1 npm --prefix web run build
python3 rust/scripts/build-desktop-manifest.py --web web --node "$(command -v node)" --output rust/bundle-manifest.json --commit "$(git rev-parse HEAD)"
```

Then run the checks:

```sh
cargo fmt --manifest-path rust/Cargo.toml --all --check
cargo clippy --manifest-path rust/Cargo.toml --locked --workspace --all-targets --keep-going -- -D warnings
cargo clippy --manifest-path rust/Cargo.toml --locked --workspace --all-targets --keep-going --features desktop_rebuild -- -D warnings
cargo nextest run --manifest-path rust/Cargo.toml --locked --workspace --no-fail-fast
cargo nextest run --manifest-path rust/Cargo.toml --locked --workspace --no-fail-fast --features desktop_rebuild
```

On macOS, set `TMPDIR` to a short directory on a case-sensitive volume before you run the tests. The workflow step `Mount a short case-sensitive TMPDIR` has the commands. To skip the same tests as CI, add `-E` with the `tests` value of the macOS entry. On Windows, replace `--workspace` with the `scope` value of the Windows entry. On Linux, the Tauri shell also needs the GTK and WebKit packages that the workflow installs with `apt-get`.

Clippy and fmt do not read the manifest contents. For a lint-only run, `echo '{}' > rust/bundle-manifest.json` is enough. The tests need the real manifest.

## Read a failure

1. Open the failed check on the pull request, or run `gh pr checks <number>`.
2. Find the first failed step. The step name says which tool and which feature setting failed.
3. Run `gh run view <run-id> --log-failed` to print only the failed steps.

These failures are common:

- `error[E0433]: cannot find unix in os`, or `cannot find function ... in crate libc`, on Windows only. Code uses a Unix API outside a platform module. Move it into one, as [Keep platform code in cfg modules](#keep-platform-code-in-cfg-modules) describes.
- `unused variable` or `function is never used` on one OS only. A value is used only inside a `#[cfg]` block. Compute the value inside that block, or gate the function with the same `#[cfg]`.
- A test that fails on one OS only. Run that test locally on the same OS with `cargo nextest run -E 'test(<name>)'`.

## Keep platform code in cfg modules

Put code that differs by OS in one module for each platform, and select the module once:

```rust
#[cfg(unix)]
mod unix;
#[cfg(unix)]
use unix as platform;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as platform;
```

Shared code calls `platform::lock_file(...)` and never names an OS. Every platform module defines the same functions. When one module lacks a function, the job for that OS fails to compile.

Do not scatter `#[cfg(...)]` on statements or `if cfg!(...)` checks through shared functions. Tests are the exception: a test, or one block in a test that checks an OS-only fact, may carry its own `#[cfg]`.

## Windows exclusions

These crates do not build on Windows yet. The Windows job excludes them with `--exclude` in its `scope` value.

| Crate | Why it is excluded |
|-------|--------------------|
| `pp-storage` | The data-directory lease and schema files use `libc` and `std::os::unix` file APIs. |
| `pp-compat` | The Node child supervisor uses Unix sockets, process groups, signals and file modes. |
| `pp-source` | Source directory reads use Unix file modes and no-follow opens. |
| `pp-api`, `pp-core`, `pp-gateway`, `pp-server`, `pp-desktop` | They depend on an excluded crate. |

When a crate builds and passes its tests on Windows, delete its `--exclude` in the same pull request.

## macOS exclusions

These tests fail on the macOS runner. The `tests` value of the macOS entry skips them by exact name. When a test passes on macOS, delete it from that filter in the same pull request.

| Crate | Tests | Failure |
|-------|-------|---------|
| `pp-compat` | Nine `ticket_t_2::` supervisor tests | Health and drain states do not change within the 8-second wall-time limit. Two owner-death tests report that the fixture never executed Node. |
| `pp-core` | Four `runtime_m0` lifecycle tests, and `origin_tests::ticket_t_12_missing_config_persists_private_port_and_reuses_it` | The Node child does not reach readiness, and some shell children exit with status 126. These tests passed with the default macOS `TMPDIR`, so the mounted volume is a suspect. |
| `pp-source` | `acquisition_labels::raw_long_labels_contract_to_valid_file_and_directory_paths` | The extracted directory is missing on APFS. This test exists only with `desktop_rebuild` on. |

## Other Rust workflows

- **Desktop Rust (hosted)** (`desktop-fleet-rust.yml`) runs the ast-grep lint counts and splits the Linux test suite into two partitions. It runs when Rust or web build inputs change.
- **Native macOS bundle** (`desktop-native-macos.yml`) builds the unsigned macOS app and runs the macOS storage tests. On pull requests it runs only when macOS inputs change or the PR has the `ci:macos` label.
- **Desktop runtime** (`desktop-runtime.yml`) runs the Python lifecycle and gateway proofs against the built server on Linux.
