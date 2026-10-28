# Continuous integration

The **Rust cross-OS** workflow (`.github/workflows/rust-cross-os.yml`) builds and tests the Rust workspace on Linux, macOS and Windows. It starts on every pull request, every push to `main`, merge groups, a nightly schedule and manual runs.

Draft pull requests skip CI jobs before runner allocation, while each job still
reports a skipped check. Marking a PR ready starts CI with the existing path and
label filters. Converting it back to a draft cancels its older PR run. Main,
merge groups, schedules and manual runs keep their existing behavior.

On ready PRs, the jobs are selected as follows:

- `rust (linux)` and `rust (windows)` run when a `changes` job finds a change to `rust/**`, `rust-toolchain.toml`, `web/package*.json`, `web/apps/**`, `web/packages/**`, `web/tsconfig*.json`, `web/scripts/atomic-package-build.mjs`, `web/scripts/storage-fixtures/**`, `fixtures/**`, `scripts/setup-ci-linux.sh`, the workflow itself, or the CI filter scripts and their tests. Other changes skip both jobs while keeping their check reports present.
- `rust (macos)` uses the same path selection. It runs only when relevant inputs change and the PR has the exact `macos` label and is not a draft. Adding or removing the label, marking the PR ready for review and converting it to a draft each start a new run.
- When those jobs run on a pull request, nextest uses an affected-crate filter from `scripts/ci-affected-nextest-filter.py`: for each changed `rust/crates/<pkg>/` path it unions `rdeps(=<pkg>)` so reverse dependents are covered. A crate whose sources read another crate's files by path (for example pp-gateway's `include_str!("../../pp-storage/...")` drift guards) joins the selection when that crate changes. The filtered nextest steps pass `--no-tests=warn`, so a selection that matches nothing in a job's `CARGO_SCOPE` (Windows excludes every reverse dependent of pp-core, for example) passes instead of exiting 4. Shared inputs (workspace `Cargo.toml` / `Cargo.lock`, toolchain, web assets, fixtures, `rust/tests/**`, `rust/scripts/**`, the workflow, or the filter scripts) keep `all()`. Clippy and doctests still cover the whole `CARGO_SCOPE`.

Pushes to `main`, merge groups, nightly and manual runs execute all three jobs regardless of paths, and nextest keeps `all()`. A new push to a pull request cancels that pull request's older run. Every non-PR run has its own concurrency group, so each merge has a result and no `main` run waits for or cancels another. Its purpose is to stop code that compiles on one OS only from reaching `main`.

This page covers what the Rust jobs run and how to reproduce them. [Change a CI workflow](ci-controls.md) covers review, the actionlint and zizmor checks, action pins and required checks. Both apply to this workflow.

## The OS jobs

The workflow has one job per OS. Each job uses the toolchain pinned in `rust-toolchain.toml`.

| Check name | Runner | Packages | Tests |
|------------|--------|----------|-------|
| `rust (linux)` | Aggregate over `rust (linux) build` plus rebuild partitions when selected | The whole workspace | All |
| `rust (macos)` | `macos-26` | The whole workspace | All except [macOS exclusions](#macos-exclusions) |
| `rust (windows)` | `windows-latest` | The workspace without [Windows exclusions](#windows-exclusions) | All in those packages |

`rust (linux) build` uses `[self-hosted, linux, x64, pp-local]` for same-repository PRs, pushes to `main`, merge groups, and manual dispatch. The nightly schedule keeps `ubuntu-latest`.

Build caching and linking differ by OS:

- Linux does not use the GitHub Actions cache for Rust builds. On `pp-local`, sccache caches compiler output on the runner fleet. The hosted nightly run builds without a cache.
- macOS and Windows restore and save `Swatinem/rust-cache`. Only `main` saves.
- Linux installs `mold` and links with it through `CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS=-C link-arg=-fuse-ld=mold`. macOS and Windows keep their default linkers.
- All jobs set `CARGO_PROFILE_DEV_DEBUG` and `CARGO_PROFILE_TEST_DEBUG` to `line-tables-only`. Panic locations keep their file and line, and the build output is smaller.

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

On self-hosted Linux pull requests, step 8 (`nextest` with `desktop_rebuild` on) is skipped so the long rebuild-on suite does not saturate `pp-local` runners. Windows PRs (including self-hosted `pp-local-win`) and hosted Linux PRs still run step 8. Steps 6 and 10 still run on Linux and Windows PRs; macOS PRs skip steps 6, 8 and 10 as before.

On `push` to `main`, `merge_group`, and `workflow_dispatch`, Linux replaces the in-job step 8 with a nextest archive built once on `pp-local` (`--zstd-level 11`), then three `rust (linux) rebuild m/3` jobs that run `cargo nextest run --archive-file … --workspace-remap "$GITHUB_WORKSPACE/rust" --partition slice:m/3` on the three fleet Linux slots. The build job also uploads a zstd-compressed pack of the measured desktop trees (`rust/bundle-manifest.json` and the web `dist` outputs). Artifact uploads set `compression-level: 0` so GitHub does not re-gzip already-compressed archives. Atomic package builds publish `dist/current` as a symlink to `dist/releases/<id>`; the dependency inventory records that link and the files under the release path. The pack step therefore archives each package's full `dist/` tree **without** `tar -h`, asserts the `current` symlink and a release-path file (for example `desktop-resolution.js`) are in the archive, and each partition restores those trees so the symlink topology still matches. Packing only `dist/current` with `-h` flattens the link and fails dependency inventory checks. Each partition runs `npm ci` only — it must not rebuild web assets or regenerate the manifest, because the archived binaries embed those digests at compile time. The required check `rust (linux)` is an aggregate that needs the Linux build and those partitions: on push / merge_group / workflow_dispatch it requires rebuild `success`; on PRs and schedule rebuild may be `skipped`. The schedule keeps the monolithic in-job step 8 on `ubuntu-latest`. PRs never enable rebuild-on nextest on `pp-local`. Each such non-PR Linux path uses four `pp-local` slot-runs (one build plus three partitions) instead of a single hosted runner.

The macOS volume exists because the default macOS `TMPDIR` breaks three kinds of test. Its paths are too long for Unix socket names, it is under the `/var` symbolic link that no-follow opens refuse, and it treats `Straße.stl` and `STRASSE.stl` as one name.

Steps 4 to 10 run even when an earlier one of them fails, so one run reports every failure. Clippy uses `--keep-going`, so it reports errors in every crate whose dependencies compile.

Each job declares its runner in `runs-on`, its package scope in `CARGO_SCOPE`, and its test filter in `NEXTEST_FILTER` (from the `changes` job output, defaulting to `all()`). The three jobs share the same anchored steps. They have no matrix, so GitHub reports their exact required names both when running and when skipped. To use a self-hosted runner, change `runs-on`. The Linux rebuild partitions always use `all()` because they only run on non-PR events.

`rust (linux)` and `rust (windows)` are required checks on `main`; `rust (macos)` is advisory. [Settings for Chad](ci-controls.md#settings-for-chad) lists the full ruleset.

## Run the required checks with one command

Run this command from the repository before you push:

```sh
PP_SCHEMA_PARITY_NODE=/path/to/node-v22.23.3 just ci
```

`just ci` passes its arguments to `python3 scripts/local-ci.py`, which holds the only list of steps. Without [just](https://github.com/casey/just), run `python3 scripts/local-ci.py` from the repository root with the same arguments. Agents run this command before they push, as [Gate evidence](../contributing/gate-evidence.md#run-ci-locally-before-you-push) says.

It runs each step below in order and continues after a failure, so one run reports every failure. At the end it prints one `PASS`, `FAIL` or `SKIP` line for each step and exits 1 if any step failed. To see the step ids, use `just ci --list`. To select steps, use `just ci --only fmt,clippy-off` or `just ci --skip nextest-on`.

| Step | What it runs | CI source |
|------|--------------|-----------|
| `local-ci-self-test` | `scripts/test_local_ci.py` | None. This test fails when a copied command no longer matches its workflow step. |
| `selector-tests` | The path-filter and macOS-alert unit tests | `rust-cross-os.yml` `changes` |
| `actionlint` | `actionlint -color` | `actionlint` (required) |
| `zizmor` | `zizmor --min-severity informational --config .github/zizmor.yml .` | `zizmor` (required) |
| `ast-grep` | `ast-grep test`, `test_ast_grep.py` and `check-ast-grep.py` against `origin/main` | `ast-grep ratchet` |
| `boundaries` | `check-boundaries.py --self-test` and `check-domain-deps.py --self-test` | `chain-tip-gate.yml` |
| `historical-schema` | `rust/scripts/fetch-historical-schema-commits.sh`, which fetches the pinned commits that the pp-storage tests archive. It runs before nextest. | `rust (linux)` (required) |
| `fmt`, `clippy-off`, `clippy-on`, `nextest-off`, `nextest-on`, `doc-off`, `doc-on` | Steps 4 to 10 of the OS jobs, with the Linux `--workspace` scope | `rust (linux)` (required) |
| `web-assets` | Desktop web build and `rust/bundle-manifest.json` | `rust (linux)` (required) |
| `workaround-ratchet` | `scripts/workaround-ratchet.mjs` and its tests, which cap `TODO`, `eslint-disable` and Rust `#[allow]` markers. It runs after `web-assets`, which installs its parser. | `web` job of `web-ci.yml` |
| `node-fixtures` | The `--check` mode of each Node parity fixture generator, and the HTTP route inventory diff, on Node 22.23.3 | `desktop-contracts.yml` and `auth-admission-freshness.yml` |

Except where noted below, each step runs the command lines of its workflow step without changes. The script sets the same environment that CI sets: `NEXTEST_FILTER`, `PP_TEST_NODE`, `VITE_PRINT_PARTNER_DESKTOP`, and `RUNNER_TEMP`. The cargo steps also get `INSTA_UPDATE=no`, so a snapshot mismatch fails the step instead of writing a `.snap.new` file. `RUNNER_TEMP` is under `$CARGO_TARGET_DIR/local-ci`, or under `rust/target/local-ci` if `CARGO_TARGET_DIR` is not set. The local command differs from CI in these ways:

- It does not install tools. If a tool is not on `PATH`, or if its version is not the version that CI pins, the step is reported as `SKIP` with the reason. The pinned versions are Node 24.21.0, ast-grep 0.50.0, actionlint 1.7.12 and zizmor 1.31.1. The `node-fixtures` step is also skipped when `PP_SCHEMA_PARITY_NODE` does not point to Node 22.23.3.
- `ast-grep` fetches `origin/main` without `--depth=1`, because a shallow fetch would make a full clone shallow.
- It does not set the CI-only `CARGO_PROFILE_*_DEBUG` and mold `RUSTFLAGS` values. They change debug info and the linker, not test results, and setting them would invalidate your local build cache.
- `nextest-on` always runs. CI skips it on self-hosted Linux PRs, but the merge queue runs it. Use `--skip nextest-on` for a shorter run.
- The nextest profile is `default` unless you set `NEXTEST_PROFILE`. Pull requests on `pp-local` use `pp-local-linux`.
- `node-fixtures` runs `npm ci` with Node 22, so `web/node_modules` ends with Node 22 native modules. The next run's `web-assets` step installs them again with Node 24.

The command does not cover these checks:

- `rust (windows)` and `rust (macos)`. They need Windows and macOS runners. The command reports both as `SKIP`.
- `Lint Evidence block`. It reads the pull request body. The command reports it as `SKIP`.
- `cargo deny check` (`desktop-deny.yml`). It runs on changes to `rust/**`. To run it locally, use `cargo deny --manifest-path rust/Cargo.toml --all-features check`. CI also runs `cargo deny --manifest-path rust/fuzz/Cargo.toml --all-features --locked check`.
- The Linux rebuild partitions, the Desktop runtime, Native macOS bundle and Docker workflows, the `web-ci.yml` steps other than the workaround ratchet, and the `contracts:verify` and `test:desktop-parity` steps of `desktop-contracts.yml`.

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

## macOS test filter

On non-PR events the macOS job uses `NEXTEST_FILTER: all()`. On PRs it uses the same affected-crate `rdeps` filter as Linux and Windows. It still runs any selected `pp-core` `runtime_m0`, `pp-compat` `ticket_t_2::`, and `origin_tests::ticket_t_12_missing_config_persists_private_port_and_reuses_it` binaries that match the filter. **Native macOS bundle** still runs its own selected lifecycle tests.

GRE-645 removed the earlier group skip. Hosted run 38925272452 mounted `/Volumes/pptmp` with `apfs, local, nodev, nosuid, journaled, nobrowse` and recorded `exec /usr/bin/node` exiting 126: `/bin/sh: line 0: exec: /usr/bin/node: cannot execute: No such file or directory`. Those scripts now `exec "$NODE"` from `PP_TEST_NODE`. Run 38941881212, with `--test-threads 1`, still failed 3 of 74 because one release verification hashed about 42,203 dependency files in 10.7 to 19.7 seconds. Each start verifies once, on a blocking thread, before the 32-second readiness budget (GRE-661). Each restart verifies again after `Starting` is published. The crash-guard status fuse covers that hash plus the 30-second probe. The measured-release parent-death test starts its 30-second acknowledgement when the helper publishes `release-verified`, not when the helper process is spawned. The config test's 3-second deadline starts when the re-executed child enters. The GRE-671 backoff test never ran Node; it runs with the rest of `ticket_t_2::`.

To collect twenty consecutive green hosted `rust (macos)` job links after tip is green, use `scripts/gre645_macos_soak.sh`. Default mode is dry-run. `--execute` is Chad-gated: it dispatches `rust-cross-os.yml` on the chosen ref, waits for each `rust (macos)` job, appends JSONL evidence (`run`, `job`, `sha`), and stops on the first red. It does not change packing or skip lists. Prove with `python3 -B -m unittest discover -s scripts -p test_gre645_macos_soak.py`.

## Other Rust workflows

- **Desktop Rust (hosted)** (`desktop-fleet-rust.yml`) runs only the ast-grep ratchet, in the `ast-grep ratchet` job. It runs on pull requests and pushes to `main` that change `rust/**`. Every push to `main` gets its own run, so a merge of two individually green pull requests is still checked. On a push, the ratchet compares against the `main` commit that push replaced. It does not build or test Rust; `rust (linux)` does that once per push.
- **Native macOS bundle** (`desktop-native-macos.yml`) builds the unsigned macOS app and runs the macOS storage tests. Its `changes` job selects them by event and changed paths:
  - On pull requests, `linux-precheck`, `server-smoke`, the arm64 `bundle` and `macos-storage-gate` run only when the PR has the exact `macos` label, is not a draft, and changes desktop inputs. The selector includes the Rust inputs above, the native workflow, its cleanup tests and the Rust verification helper directory. Fork PRs skip `macos-storage-gate`. The Intel bundle never runs on pull requests.
  - Pushes to `main` or `master`, merge groups, nightly and manual runs select every job, including the Intel bundle.

  Every macOS job also needs a successful `linux-precheck`, so a broken web build never starts a macOS runner. Skipped jobs still report their checks. A new push, label change or draft change on a pull request cancels that pull request's older run. Every non-PR run has its own concurrency group, so a push to `main` never waits for or cancels another `main` run.
  The source fixture registers the named `cleanup_source_fixture` function with `trap cleanup_source_fixture EXIT` after a successful attach. It captures `$?` immediately and exits with that status on every cleanup path. Cleanup targets only this step's owned mount. It tries normal detach of the mount three times, with `sleep 2` between failures. If all three fail, it records holders and then forces detach of the whole-disk device that `hdiutil attach` printed first, again up to three times with `sleep 2` between failures. A forced unmount can succeed while ejecting the backing device returns `Resource busy`. The mount path is then an ordinary directory, so the forced retries target the device. The explicit sleeps total at most eight seconds. The `hdiutil` calls and holder diagnostics add time, so eight seconds is not a wall-clock cleanup bound.

  After normal detach retries fail, `lsof +f -- "$fixture_mount"` records open files on the source fixture's owned APFS filesystem before forced detach. A diagnostic failure, or failure of all three forced attempts, warns without changing the test exit status. Run `python3 scripts/test_native_image_cleanup.py -v` for executable cleanup fixtures. The same suite runs in `macos-storage-gate`, including a macOS-only disposable APFS image held open by a child process. Linux skips that native proof.

  GRE-839's focused targets are `CleanupTest.test_cleanup_function_preserves_all_exit_status_cases` and `CleanupTest.test_cleanup_function_passes_actionlint_shellcheck`. Run them with `python3 scripts/test_native_image_cleanup.py -v CleanupTest.test_cleanup_function_preserves_all_exit_status_cases CleanupTest.test_cleanup_function_passes_actionlint_shellcheck`. Put actionlint 1.7.12 and ShellCheck on `PATH` to run the analysis target. It skips when either tool is absent. The existing Actionlint workflow checks the workflow independently.

  The status target executes the complete extracted workflow step through `bash --noprofile --norc -e -o pipefail`, using disposable files and executable tool doubles. Its 35 cases combine statuses 0, 1, 23, 130 and 255 with normal detach success on each attempt and all diagnostic-success/failure and forced-detach-success/failure combinations. Each case asserts the exact exit status, combined output, ordered command arguments and preserved fixture and unrelated sentinel bytes. The analysis target requires empty successful output from both tools, then injects an unquoted mount expansion into the cleanup body and requires SC2086 from each tool to prove the function is inspected. The cross-OS workflow has no matching EXIT trap to extract.
- **Desktop runtime** (`desktop-runtime.yml`) builds `pp-api` and `pp-server` and runs the proofs that need the built server on Linux: the serial `runtime_m0` lifecycle log, the Python lifecycle, upload and gateway drivers, the source artifact checks and `verify.py`. Unit tests, clippy and fmt are not repeated here; `rust (linux)` runs them.

When `rust (macos)` or a Native macOS bundle workflow job fails on a push to `main`, an alert job opens an issue labelled `ci-macos-main` for that workflow run, or comments on the existing open issue for the same run. Rust failures confined to Linux or Windows do not alert. Only the alert job receives `issues: write`.

Required Rust and lint jobs fail if their input-selection job fails, so a broken filter or failing filter test cannot pass through the required checks. `rust (macos)` also runs that check when the label and draft state select it. Failure alerts run independently with a separate issue per workflow run, so a shared concurrency queue cannot drop pending alerts. Reruns comment on the existing open issue for that run.

## Ephemeral PR runners

Same-repository `pull_request` jobs use `[self-hosted, linux, x64, pp-local]`
for Rust Linux, ast-grep, web checks, WebKit STL smoke, PR evidence lint, desktop contracts, desktop runtime,
source artifacts, embedded-driver smoke, and the native
macOS Linux precheck. ARM64 native macOS jobs and cross-OS macOS use
`[self-hosted, macos, arm64, pp-local-mac]` when the PR has the `macos` label and is not a draft.
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

Fork PRs use each job's existing GitHub-hosted label. Schedules and releases keep
their existing hosted runners. Linux Rust on pushes to `main`, merge groups, and
manual dispatches uses the `pp-local` fleet so desktop_rebuild nextest can archive
once and partition across the three slots; other non-PR workflows stay hosted.
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
