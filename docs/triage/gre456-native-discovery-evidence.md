# GRE-456 native discovery evidence

## Scope

`pp-services::native_slicers` reads standard macOS Orca and Bambu application bundles without executing a process. Bundle metadata supplies the executable name and release version. Only fixed executable names are accepted. Canonical paths must remain inside the Applications root and the bundle.

The macOS reader searches `/Applications` before `~/Applications`, using `OrcaSlicer.app`, `BambuStudio.app`, and `Bambu Studio.app`. Existing config directories are `~/Library/Application Support/OrcaSlicer` and `~/Library/Application Support/BambuStudio`. A missing directory returns `None`; Linux profile directories do not substitute for macOS configuration.

`discover_native_kind` reports unsupported native discovery on other platforms and for Prusa. `discover_macos` takes explicit roots so the same path logic can run against temporary fixtures on Linux. The existing profile-file discovery API remains available.

The bundle version is metadata evidence, not proof that an installed app launches successfully. This slice adds no HTTP routes, workers, UI, or shell commands. Native handoff must use direct execution with an argv array and its own validation. GRE-380 still needs its installed-macOS evidence gate and GRE-456 still needs route and worker cutover evidence before completion.

## Behavioral failure before implementation

The initial library implementation returned `Absent`. The app-bundle fixture test failed with `expected installed app`.

```sh
cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-services --no-tests=fail -E 'test(ticket_t_44_discovery)'
```

Observed on Linux on 2026-10-14 with Rust 1.99.0 and nextest 0.9.146.

```text
Summary: 7 tests run: 6 passed, 1 failed, 0 skipped
FAIL pp-services::ticket_t_44_discovery ticket_t_44_discovery_native_apps_return_versions_and_real_config_dirs
```

## Verification after implementation

The documented workspace prerequisites in `rust/README.md` were built before the exact acceptance command. The first workspace attempt failed because `rust/bundle-manifest.json` was missing. Generating the measured manifest after the desktop web build resolved that prerequisite.

```sh
cargo nextest run --locked --manifest-path rust/Cargo.toml --no-tests=fail -E 'test(ticket_t_44_discovery)'
```

```text
Summary: 15 tests run: 15 passed, 530 skipped
```

The filter selected six existing profile-discovery tests and nine new native tests. Temporary fixtures cover both slicers, versions, existing and missing macOS config directories, system and user app locations, precedence and fallback, XML and binary metadata, malformed metadata, invalid versions and executables, shell-like path characters, unsupported kinds and platforms, and escaping symlinks. Fixtures never launch an app.

Additional checks passed.

```sh
cargo clippy --locked --manifest-path rust/Cargo.toml -p pp-services --all-targets -- -D warnings
cargo fmt --manifest-path rust/Cargo.toml -p pp-services --check
python3 rust/scripts/check-boundaries.py --self-test
python3 rust/scripts/check-ast-grep.py
```

The Rust lint ratchet remained at 47 `no-unwrap-expect` hits and 8 `runtime-process-command` hits. No baseline changed.

## Metadata containment follow-up

On 2026-10-14, the regression fixture reproduced the reported bug on main `0538015b3b159f0e1e68d86f9ce35c429ebb7ec6`. The production library was unchanged. `Contents/Info.plist` pointed to a valid plist outside `OrcaSlicer.app`, still inside Applications with the sibling name `OrcaSlicer.app-external.plist`. Discovery returned `Installed` with `external-version` instead of `InvalidBundle` with `Metadata`.

```sh
cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-services --no-tests=fail -E 'test(ticket_t_44_discovery_metadata_symlink_cannot_escape_bundle)'
```

```text
Summary: 1 test run: 0 passed, 1 failed, 15 skipped
exit 100
```

The reader now canonicalizes `Contents/Info.plist`, requires a regular file within the canonical bundle, and parses that canonical path. An escaped, missing, unresolved, or non-regular metadata path reports `InvalidBundle` with `Metadata`. A contained metadata symlink remains supported. Existing bundle precedence and fallback remain available. This is a directory-fixture check, not protection against concurrent replacement of bundle files by another process.

The new fixtures cover an outside metadata symlink, a contained metadata symlink, and a metadata directory. The crate-level discovery filter returned 18 passed, 0 skipped, exit 0. No application was launched.

The library-only follow-up adds no route, worker, startup hook, or ownership entry. GRE-456 remains In Progress for its remaining criteria. GRE-380 remains blocked on installed-Mac evidence, and cutover stays with GRE-593 and the desktop rebuild slices.

After `npm --prefix web ci`, the desktop web build, and manifest generation from the documented prerequisites, the exact workspace acceptance command passed.

```sh
cargo nextest run --locked --manifest-path rust/Cargo.toml --no-tests=fail -E 'test(ticket_t_44_discovery)'
```

```text
Summary: 18 tests run: 18 passed, 546 skipped
exit 0
```

`cargo fmt --manifest-path rust/Cargo.toml --all --check`, pp-services Clippy with `-D warnings`, crate-boundary self-tests, and the unchanged Rust lint ratchet also passed. The ratchet retained 47 `no-unwrap-expect` hits and 8 `runtime-process-command` hits.
