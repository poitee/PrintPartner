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
