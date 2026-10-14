# GRE-353 feature unification correction

Committed locally at `99517b342adfdc4c635c069642dc4e07058fc3d6` on `owner/gre353-next-202610141227-9efa`.
The parent commit is `0f429d3a8484ef3a98243d7ced56fd0a54664842`. The rebased main base is `f73756f7d2b8b6aa1fbcb4950c040f96ede5b746`.
The working tree is clean. This is the second ordered commit.
No push, PR, merge, child delegation, remote deletion, rustls update, or contact to Chad occurred.
No score rounds ran. The earlier provider flag remains in the parent record. This correction encountered no provider restriction.

`DesktopAccountPin` and `SpawnSpec.account_pin` now have the same public shape in every feature configuration.
Capture and apply enforce compat's compile gate with `cfg!(feature = "desktop_rebuild")`.
Core always captures after acquiring `StorageLease`, using its stored `DesktopRebuild` gate.
Core's disabled gate produces an explicit `Disabled` pin even when dependency features enable compat independently.
Every other existing constructor supplies `Disabled` without caller feature guards.
Disabled capture does not read mapping files, and disabled apply leaves setup bytes unchanged.
The enum remains `Disabled | Missing | Present { sha256: [u8; 32] }`.
No Node source, dependency manifest, lockfile, native permission, or runtime lifetime design changed.

The correction changes five allowed files with 35 additions and 21 deletions, totaling 56 changed lines.
The net final mapping slice changes 17 files with 1317 additions and 39 deletions, totaling 1356 changed lines.
The two ordered commits contain 1396 changed lines when their individual diff totals are added.
Both totals remain below 1500.
The net total is reproducible with `git diff --numstat f73756f7d2b8b6aa1fbcb4950c040f96ede5b746 99517b342adfdc4c635c069642dc4e07058fc3d6`.

Changed files are listed below.

- `rust/crates/pp-compat/src/account_pin.rs`.
- `rust/crates/pp-compat/src/lib.rs`.
- `rust/crates/pp-compat/src/ticket_t_2.rs`.
- `rust/crates/pp-compat/tests/installed_bundle_lifecycle.rs`.
- `rust/crates/pp-core/src/lib.rs`.

The throughput checkpoint remains one writer for one shared constructor contract.
The stable public data shape blocked the build and was corrected first.
Independent source workstreams do not apply because capture, setup, and constructors share that contract.
No separate source stream or shared mutable writer exists. Fixture directories remain disposable.
The parent retains the playbook and independent design and review delegation under the explicit no-child constraint.

Model the Domain retained the explicit three-state enum instead of booleans with optional hashes.
Laziness Protocol removed caller feature guards and the redundant setup rebinding block.
Fix Root Causes reproduced E0063 before replacing the feature-dependent public shape.
Test Behavior, Not Implementation added compile-off capture and apply controls with exact pin and setup-byte assertions.
Prove It Works required real Core runtime gate controls and mapping crash and restart scenarios.
Sequence Work into Verifiable Units kept this verified correction in a separate second commit.
The deslop inspection found no added comments, suppressions, casts, fallback APIs, or unrelated changes.

All build and test commands passed through `python3 /persist/home/pstack-t3/skills/landing/scripts/land.py slot --`.
The reproducible runner is `/persist/home/.local/state/pstack-t3/gre353-owner-mapping/unification-fix/verify.py`.
Its exact commands, exit codes, and log paths are recorded in `/persist/home/.local/state/pstack-t3/gre353-owner-mapping/unification-fix/results.json`.
The environment used `CARGO_BUILD_JOBS=4`, `CARGO_TARGET_DIR=/persist/home/.local/state/pstack-t3/gre353-next/target`, and native Node 24.21.0 first in PATH.
The runner removed inherited `PP_DESKTOP_REBUILD`. Runtime cases set their gates in isolated subprocesses.
The stage manifest was `/persist/home/.local/state/pstack-t3/gre353-owner-mapping/exact-0f429d3a8484-stage/bundle-manifest.json`.

The verification commands and results follow.

- `python3 /persist/home/pstack-t3/skills/landing/scripts/land.py slot -- cargo fmt --manifest-path rust/Cargo.toml --all --check`. PASS.  Log `/persist/home/.local/state/pstack-t3/gre353-owner-mapping/unification-fix/fmt.log`.
- `python3 /persist/home/pstack-t3/skills/landing/scripts/land.py slot -- cargo check --locked --manifest-path rust/Cargo.toml -p pp-core --features pp-compat/desktop_rebuild`. PASS.  Log `/persist/home/.local/state/pstack-t3/gre353-owner-mapping/unification-fix/mixed-feature-check.log`.
- `python3 /persist/home/pstack-t3/skills/landing/scripts/land.py slot -- cargo clippy --locked --manifest-path rust/Cargo.toml -p pp-core -p pp-compat --all-targets -- -D warnings`. PASS.  Log `/persist/home/.local/state/pstack-t3/gre353-owner-mapping/unification-fix/clippy-off.log`.
- `python3 /persist/home/pstack-t3/skills/landing/scripts/land.py slot -- cargo clippy --locked --manifest-path rust/Cargo.toml -p pp-core -p pp-compat --all-targets --features desktop_rebuild -- -D warnings`. PASS.  Log `/persist/home/.local/state/pstack-t3/gre353-owner-mapping/unification-fix/clippy-on.log`.
- `python3 /persist/home/pstack-t3/skills/landing/scripts/land.py slot -- cargo clippy --locked --manifest-path rust/Cargo.toml -p pp-core -p pp-compat --all-targets --features pp-compat/desktop_rebuild -- -D warnings`. PASS.  Log `/persist/home/.local/state/pstack-t3/gre353-owner-mapping/unification-fix/clippy-mixed.log`.
- `python3 /persist/home/pstack-t3/skills/landing/scripts/land.py slot -- cargo test --locked --manifest-path rust/Cargo.toml -p pp-compat --lib account_pin -- --nocapture`. PASS. 2 pin tests passed. Log `/persist/home/.local/state/pstack-t3/gre353-owner-mapping/unification-fix/pin-units-off.log`.
- `python3 /persist/home/pstack-t3/skills/landing/scripts/land.py slot -- cargo test --locked --manifest-path rust/Cargo.toml -p pp-compat --lib --features desktop_rebuild account_pin -- --nocapture`. PASS. 3 pin tests passed. Log `/persist/home/.local/state/pstack-t3/gre353-owner-mapping/unification-fix/pin-units-on.log`.
- `python3 /persist/home/pstack-t3/skills/landing/scripts/land.py slot -- cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-core --test runtime_m0 --no-tests=fail --success-output=immediate --features pp-compat/desktop_rebuild -E 'test(ticket_t_68_desktop_account_mapping)'`. PASS. 2 real runtime controls passed with only compat enabled. Core compile-off and runtime-off controls both refused mapping and preserved database bytes. Log `/persist/home/.local/state/pstack-t3/gre353-owner-mapping/unification-fix/mapping-off-mixed.log`.
- `python3 /persist/home/pstack-t3/skills/landing/scripts/land.py slot -- cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-core --test runtime_m0 --no-tests=fail --success-output=immediate --features desktop_rebuild -E 'test(ticket_t_68_desktop_account_mapping)'`. PASS. 9 real mapping scenarios passed. Crash and restart lifetime controls and refusals before product writes remained green. Log `/persist/home/.local/state/pstack-t3/gre353-owner-mapping/unification-fix/mapping-on.log`.
- `python3 /persist/home/pstack-t3/skills/landing/scripts/land.py slot -- cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-core --test runtime_m0 --no-tests=fail --success-output=immediate --features pp-compat/desktop_rebuild -E 'test(protected_real_node_lifecycle)'`. PASS. 1 protected real Node lifecycle passed with only compat enabled. The receipt records child_reaped=true, persisted_origin=true, and build_id=1. Log `/persist/home/.local/state/pstack-t3/gre353-owner-mapping/unification-fix/lifecycle-mixed.log`.

`git diff --check` and `git diff --cached --check` passed before commit.
The original failed compile log remains at `/persist/home/.local/state/pstack-t3/gre353-owner-mapping/mixed-feature-check.log`.
Its SHA-256 is `2b83ae78ada443f6b1eb7068b032716297ef394e707b228a37c4008f6c04e40a`.
The correction's E0063 reproduction is `/persist/home/.local/state/pstack-t3/gre353-owner-mapping/unification-fix/mixed-feature-repro.log`.
An initial reproduction omitted the manifest environment variable and failed at build setup.
That setup failure remains at `/persist/home/.local/state/pstack-t3/gre353-owner-mapping/unification-fix/mixed-feature-before.log`. The corrected reproduction reached E0063 before any source edit.
Runtime receipts are `/persist/home/.local/state/pstack-t3/gre353-owner-mapping/unification-fix/runtime-receipts.json`.
The fixture audit is `/persist/home/.local/state/pstack-t3/gre353-owner-mapping/unification-fix/fixture-audit.json`. All 12 recorded fixtures exist and have no remaining owner marker.
Committed source hashes are `/persist/home/.local/state/pstack-t3/gre353-owner-mapping/unification-fix/commit-source-hashes.json`.

Verification limits remain explicit.
These checks used the supplied parent stage for unchanged Node code and the final Rust source bytes before commit.
They do not constitute a freshly rebuilt exact-final-head artifact proof.
The parent still rebuilds `99517b342adfdc4c635c069642dc4e07058fc3d6` before its independent evidence, CI, and fresh Grok Build score.
Mac, signed release acceptance, native handoffs, and legacy default-tenant mapping remain open in GRE-353.
This correction does not complete GRE-353.
