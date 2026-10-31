# Rust and React development container

The optional `.devcontainer/` environment provides Rust 1.99.0, Node 24.21.0
for runtime/assets, and a separate Node 22.23.3 parity oracle. All three official
base images are digest-pinned. Debian packages receive the current Bookworm
updates at build time, so the image is not a byte-for-byte archived OS snapshot.

It includes Linux GTK/WebKit development libraries, Chromium, Python virtual
environments with pip, rustfmt, and Clippy. A separate `/opt/sidecar-venv`
provides the Flask and Waitress versions pinned by the legacy sidecar image.
It runs as `developer`, without sudo,
privileged mode, the host Docker socket, or automatic port forwarding. It does
not install a product service, enable sharing, or change telemetry defaults.

## Open the environment

Use a normal standalone clone with its `.git` directory inside the checkout.
Opening a host Git worktree whose `.git` file points outside the mounted folder
does not provide working Git metadata inside the container. Use a separate
clone rather than mounting your entire home directory or modifying that file.

Open the clone with a Dev Containers-compatible editor and select its reopen
command. Alternatively, with the Dev Container CLI installed:

```sh
devcontainer up --workspace-folder /absolute/path/to/PrintPartner
devcontainer exec --workspace-folder /absolute/path/to/PrintPartner \
  bash .devcontainer/smoke.sh
```

The CLI/editor builds with `.devcontainer/` as its context, not the repository,
so source files, credentials, and customer data do not enter image layers.
Only the selected checkout is mounted for development. As with any developer
environment, repository lifecycle scripts execute with access to that checkout.
Use a trusted clone and keep real secrets and production data elsewhere.

Setup and smoke share `.devcontainer/preflight.sh` for toolchain checks.
The post-create script performs `npm ci` under Node 24 and runs the existing
`predev` command to build contracts and domain packages.
It neither launches a server nor runs the full test suites.
The root package's Node 22 engine warning is expected during this transition.

## Smoke checks and feature modes

Run `bash .devcontainer/smoke.sh` after post-create. It checks both Node versions,
the Rust tools and Linux libraries, Python venv/pip creation, the pp-domain
library tests with `desktop_rebuild` off/on, shared React Sponsor-action tests,
Node G-code filename matching, and Python sidecar unit/shutdown tests using a
synthetic slicer. A missing test file fails rather than passing with zero Vitest tests.
Check the executed counts in Cargo/Vitest output.

These checks do not require a generated asset manifest, native window, printer,
or real data. They prove only those selected paths.

For both Rust applications, run the heavier selector after post-create:

```sh
bash .devcontainer/smoke.sh --runtime
```

It repeats the fast checks, builds the desktop web assets, generates the measured
manifest at the checkout's HEAD, and runs five gateway argument-parser unit
tests, three gateway CLI-refusal integration tests, and desktop browser-policy
unit tests with `desktop_rebuild` off/on.
Each selected Rust run must execute at least one passing test. Missing matches
fail even if Cargo exits zero. Budget 20 minutes for a cold build, depending on
available CPU and registry access. The manifest remains generated and ignored;
do not replace it with a placeholder.

These are headless tests, not installed-native acceptance or a running gateway
journey. They do not prove runtime cutover, browser E2E, real Orca,
Windows/macOS support, or release signing. Gateway parser unit tests do not
prove runtime startup; report the CLI integration selector separately.

For a raw Docker build without an editor or CLI:

```sh
docker build --tag printpartner-dev:local .devcontainer
```

Run containers without published ports or extra host mounts. Do not reuse the
product image or the production data folder. On Linux, the editor/CLI adjusts
the developer UID to the checkout owner; raw Docker users must arrange matching
ownership rather than running repository commands as root or changing broad
host permissions.

## Parity Node and native modules

`PP_SCHEMA_PARITY_NODE=/opt/node22/bin/node` names the oracle. It does not change
the active `node` or npm. For fixture work that requires Node 22 native modules:

```sh
PATH="/opt/node22/bin:$PATH" npm --prefix web ci
PP_TEST_NODE="$PP_SCHEMA_PARITY_NODE" \
  "$PP_SCHEMA_PARITY_NODE" --conditions=development fixtures/parity/auth-health/generate.mjs --check
```

Restore the default Node 24 install before runtime/asset work:

```sh
bash .devcontainer/post-create.sh
```

Do not run Node 22 and Node 24 npm installs concurrently in the same checkout.
See [CI](ci.md) and [building](building.md) for the full checks and measured asset
manifest requirements. The image does not preinstall every CI scanner or
nextest; missing tools remain explicit blockers in `scripts/local-ci.py`.

The workflow's lightweight configuration tests run without Docker:

```sh
python3 -B -m unittest discover -s scripts -p test_devcontainer.py -v
```

## Historical validation evidence

On 2026-10-31, the environment built on Linux x86-64 and completed
`@devcontainers/cli` 0.80.2 `up` and `exec` against an isolated standalone clone.
The checkout used base `6448fb2f7ca4d2051a8a03626b1d5674d92f3529` plus the
uncommitted environment definition. The smoke command executed five pp-domain
tests with the feature off, ten with it on, and four React tests. All passed.
It also verified the toolchain versions, non-root user, GTK/WebKit libraries,
and Python venv/pip creation. The validation container stopped successfully.

That CLI version emitted a base-image metadata path warning for the tagged,
digest-pinned Rust image. Its build and lifecycle commands still exited zero.
The expected Node engine warning also remains. Neither warning was counted as
a failed or skipped test. Hosted CI and independent exact-head review remain
pending in that historical receipt; no all-application readiness score was
recalculated. New evidence for the extended selectors belongs on the current
PR's exact head, not this older checkout.
