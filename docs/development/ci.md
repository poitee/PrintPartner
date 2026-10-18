# Continuous integration

The **Rust cross-OS** workflow (`.github/workflows/rust-cross-os.yml`) builds and tests the Rust workspace on Linux, macOS and Windows. It starts on every pull request and every push to `main`. On PRs, a `changes` job selects `rust/**`, `rust-toolchain.toml`, `web/package*.json`, `web/apps/**`, `web/packages/**`, `web/tsconfig*.json`, `web/scripts/atomic-package-build.mjs`, `web/scripts/storage-fixtures/**`, `fixtures/**`, the workflow itself, and the CI filter script and its tests. Other changes skip the three named Rust jobs while keeping their check reports present. Every push to `main` and manual run executes all three jobs. A new push to a pull request cancels that pull request's older run. Every push to `main` gets its own run, so each merge has a result. Its purpose is to stop code that compiles on one OS only from reaching `main`.

This page covers what the Rust jobs run and how to reproduce them. [Change a CI workflow](ci-controls.md) covers review, the actionlint and zizmor checks, action pins and required checks. Both apply to this workflow.

## The OS jobs

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
9. `cargo test --doc`, with `desktop_rebuild` off. nextest does not run doctests.
10. `cargo test --doc`, with `desktop_rebuild` on.

On macOS PRs, steps 6, 8 and 10 are skipped. Linux and Windows keep both feature states on PRs. Pushes to `main` and manual runs keep both states on every OS.

The macOS volume exists because the default macOS `TMPDIR` breaks three kinds of test. Its paths are too long for Unix socket names, it is under the `/var` symbolic link that no-follow opens refuse, and it treats `Straße.stl` and `STRASSE.stl` as one name.

Steps 4 to 10 run even when an earlier one of them fails, so one run reports every failure. Clippy uses `--keep-going`, so it reports errors in every crate whose dependencies compile.

Each job declares its runner in `runs-on`, its package scope in `CARGO_SCOPE`, and its test filter in `NEXTEST_FILTER`. The three jobs share the same anchored steps. They have no matrix, so GitHub reports their exact required names both when running and when skipped. To use a self-hosted runner, change `runs-on`.

`rust (linux)` and `rust (windows)` are required checks on `main`; `rust (macos)` is advisory. [Settings for Chad](ci-controls.md#settings-for-chad) lists the full ruleset.

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
cargo test --manifest-path rust/Cargo.toml --locked --workspace --no-fail-fast --doc
cargo test --manifest-path rust/Cargo.toml --locked --workspace --no-fail-fast --doc --features desktop_rebuild
```

On macOS, set `TMPDIR` to a short directory on a case-sensitive volume before you run the tests. The workflow step `Mount a short case-sensitive TMPDIR` has the commands. Also set `PP_TEST_NODE` to the Node executable, as CI does. Without it the runtime tests fall back to `/usr/bin/node`, which macOS does not have. To skip the same tests as CI, add `-E` with the `NEXTEST_FILTER` value of the macOS job. On Windows, replace `--workspace` with the Windows job's `CARGO_SCOPE` value. On Linux, the Tauri shell also needs the GTK and WebKit packages that the workflow installs with `apt-get`.

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

These crates do not build on Windows yet. The Windows job excludes them with `--exclude` items in `CARGO_SCOPE`. The table below names each port ticket.

| Crate | Port ticket | Why it is excluded |
|-------|-------------|--------------------|
| `pp-storage` | GRE-653 | The data-directory lease and schema files use `libc` and `std::os::unix` file APIs. |
| `pp-source` | GRE-653 | Source directory reads use Unix file modes and no-follow opens. |
| `pp-compat` | GRE-654 | The Node child supervisor uses Unix sockets, process groups, signals and file modes. |
| `pp-core` | GRE-654 | It depends on `pp-compat` and `pp-storage`. |
| `pp-api`, `pp-gateway`, `pp-server` | GRE-655 | They depend on an excluded crate. |
| `pp-desktop` | GRE-656 | It is the Tauri shell and depends on an excluded crate. GRE-656 ends with the Windows job building the whole workspace. |

`rust (windows)` therefore does not compile the Tauri shell yet. When a port ticket's crates build and pass their tests on Windows, delete its `CARGO_SCOPE` exclusion in the same pull request.

## macOS exclusions

The `NEXTEST_FILTER` value of the macOS job skips these tests. The comment above the macOS filter names the ticket for each skipped term. When a test passes on macOS, delete it from that filter in the same pull request.

The macOS job skips two lifecycle groups as a whole. They are every test in the `pp-core` `runtime_m0` binary and every `pp-compat` test under `ticket_t_2::`. Linux still runs both groups in full, and **Native macOS bundle** still runs its own selected macOS lifecycle tests. GRE-645 owns the skip. On the hosted runner, one release verification takes 10 to 20 seconds, almost all of it spent walking and hashing about 42,000 dependency files. Each runtime start verifies the release once, on a blocking thread before the 32-second readiness budget starts, and hashes files in parallel. Every supervisor restart verifies again (GRE-661). The skip stays until macOS runs of both groups pass (GRE-645).

The filter also skips one test by name, outside those groups:

| Crate | Test | Ticket | Failure |
|-------|------|--------|---------|
| `pp-core` | `origin_tests::ticket_t_12_missing_config_persists_private_port_and_reuses_it` | GRE-645 | It reruns the test binary with a 3-second deadline, which it misses while release verification in other tests saturates the runner. |

## Other Rust workflows

- **Desktop Rust (hosted)** (`desktop-fleet-rust.yml`) runs only the ast-grep ratchet, in the `ast-grep ratchet` job. It runs on pull requests and pushes to `main` that change `rust/**`. Every push to `main` gets its own run, so a merge of two individually green pull requests is still checked. On a push, the ratchet compares against the `main` commit that push replaced. It does not build or test Rust; `rust (linux)` does that once per push.
- **Native macOS bundle** (`desktop-native-macos.yml`) builds the unsigned macOS app and runs the macOS storage tests. On pull requests, its macOS jobs run only when the PR is ready for review and has the `macos` label. A new push to `main` does not cancel a running `main` run; it waits, and only the newest waiting push runs next.
  After normal detach retries fail, `lsof +f -- "$fixture_mount"` records open files on the source fixture's owned APFS filesystem before forced detach. Diagnostic and detach failures warn without changing the test exit status. Run `python3 scripts/test_native_image_cleanup.py -v` for executable cleanup fixtures. The same suite runs in `macos-storage-gate`, including a macOS-only disposable APFS image held open by a child process. Linux skips that native proof.
- **Desktop runtime** (`desktop-runtime.yml`) builds `pp-api` and `pp-server` and runs the proofs that need the built server on Linux: the serial `runtime_m0` lifecycle log, the Python lifecycle, upload and gateway drivers, the source artifact checks and `verify.py`. Unit tests, clippy and fmt are not repeated here; `rust (linux)` runs them.

When `rust (macos)` or a Native macOS bundle workflow job fails on a push to `main`, an alert job opens an issue labelled `ci-macos-main` for that workflow run, or comments on the existing open issue for the same run. Rust failures confined to Linux or Windows do not alert. Only the alert job receives `issues: write`.

Required Rust and lint jobs fail if their input-selection job fails, so a broken filter or failing filter test cannot pass through the required checks. Failure alerts run independently with a separate issue per workflow run, so a shared concurrency queue cannot drop pending alerts. Reruns comment on the existing open issue for that run.

## Ephemeral PR runners

Same-repository `pull_request` jobs use `[self-hosted, linux, x64, pp-local]`
for Rust Linux, ast-grep, web checks, WebKit STL smoke, PR evidence lint, desktop contracts, desktop runtime,
source artifacts, embedded-driver smoke, and the native
macOS Linux precheck. ARM64 native macOS jobs and cross-OS macOS use
`[self-hosted, macos, arm64, pp-local-mac]` with the existing `macos` PR label gate.
Each runner accepts one job and is destroyed afterward. Linux has three slots with
3 vCPU and 8 GB each; macOS has two fresh Tart VM slots.
Routing matches registration labels, not ephemeral runner names. Live PR jobs
have used `pp-linux-*` registrations with the `pp-local` label. Runner join
configuration belongs to the runner host and is not supplied through workflow env.

PR evidence lint uses `pull_request`, including body edits, and checks out trusted
default-branch tooling. Same-repository PRs use the Linux fleet; forks retain
`ubuntu-latest`. The required check remains `Lint Evidence block`.

Rust Linux selects the `pp-local-linux` nextest profile for same-repository PRs.
The real-Node `runtime_m0` suite and compatibility-process package reserve all
three nextest slots while running. Their assertions and deadlines are unchanged.
The local job has a 120-minute budget for this schedule. Hosted Rust Linux keeps
the default profile and 90-minute job budget.

Local Linux uses the host-managed Cargo cache volume. It skips `Swatinem/rust-cache`
because that action's post-job cleanup deletes registry source directories that
another container may still be compiling. Hosted runners, macOS and Windows keep
the action cache. Each job's target directory remains in its own workspace.

Fork PRs use each job's existing GitHub-hosted label. Pushes, schedules, releases,
manual dispatches and merge groups also keep their existing hosted runners.
Docker image jobs, service-container jobs and cargo-deny stay hosted because the
Linux runner containers have no Docker socket. Selector and result-only jobs stay
hosted. WebKit STL smoke uses the Linux fleet after a fresh-image proof rendered
the production STL canvas with Mesa llvmpipe under Xvfb:
[run 39110024828](https://github.com/poitee/PrintPartner/actions/runs/39110024828).
Its fork and manual-dispatch fallback remains `ubuntu-24.04`.
Rust verification stays hosted
because its iptables LAN guard requires privileges absent from the containers.
No job routed to the local fleet references `secrets.`.

The `scripts/setup-ci-linux.sh` script installs build tools, Python and the GitHub CLI through
`sudo apt-get`. Setup actions install Node, Rust and Chrome explicitly. Rust uses
1.99.0 with rustfmt and clippy. Changes to the setup script trigger every
path-filtered consumer, including Rust input selection. The local web validation
job has a 45-minute limit after two runs reached the hosted 20-minute limit while
still executing tests. Fork PRs and non-PR runs retain the 20-minute limit.

Rust Windows jobs select `[self-hosted, windows, x64, pp-local-win]` only when
`PP_LOCAL_WIN` is `true` and the event is a same-repository PR. The switch defaults
off; it is now enabled after the full local Rust job passed:
[Windows Rust smoke](https://github.com/poitee/PrintPartner/actions/runs/39079477016).
Fork PRs and non-PR events retain `windows-latest`. The runner image supplies Git
Bash, PowerShell 7 and Python 3.13. The job verifies Python's version and hashing
API and passes its exact executable path to manifest generation. It avoids the
setup-python Windows installer, which requires administrator privileges.
The `ci/runner-smoke-win` branch remains for Chad to remove.

Local macOS jobs install Python 3.12 through pinned `actions/setup-python` before
building manifests, which require `hashlib.file_digest`. They create the action's
required `/Users/runner/hostedtoolcache` prefix and give the actual VM user ownership,
including when that user is `admin`. The action sets PATH and Python discovery
variables to the installed interpreter. A required step checks the version and API;
cross-OS manifest generation uses the action's exact interpreter path. Historical
schema trees missing from a shallow checkout are fetched together in one Git
operation, then every pinned tree and the required archive are checked.

Linux and macOS label smoke passed before this change:
[run 39072361760](https://github.com/poitee/PrintPartner/actions/runs/39072361760).
The temporary `ci/runner-smoke` branch was deleted after both jobs succeeded.
