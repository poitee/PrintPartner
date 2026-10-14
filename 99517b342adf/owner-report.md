Local implementation committed at `968b35a3f5548433ba3e2f330a38a97ba4eada08` on `owner/gre353-next-202610141227-9efa`.
The commit changes 17 files with 1302 additions and 38 deletions. The total changed line count is 1340, below the 1500-line limit.
The working tree is clean. No push or PR exists. No children were spawned, no rustls or lockfile update occurred, and no native permissions changed.

Core captures `DesktopAccountPin::Disabled | Missing | Present { sha256 }` once after acquiring the storage lease. The supervisor owns the immutable `SpawnSpec` and sends the same pin to every compatibility child. Disabled setup bytes remain unchanged. Node parses the trusted account-mode object and compares actual presence and descriptor-read bytes before schema and exact-account admission. Rust contains no account or SQL lookup semantics. The fixed HMAC transport principal remains `default/desktop-owner`.

Node retains current-schema admission before product writes, nonadmin preservation, refreshed request metadata, database replacement checks, backup refusal, mapped tenant background and shutdown work, and suppression of global maintenance. The accepted original implementation is included in this commit alongside the lifetime correction.

Model the Domain determined the explicit three-state pin instead of booleans plus optional hashes. Fix Root Causes moved lifetime ownership from Node to the Core launch. Prove It Works determined the real child crash and gateway checks alongside unit controls. Type System Discipline determined a fixed 32-byte Rust hash and a strict Node discriminated schema.

All builds and tests used `python3 /persist/home/pstack-t3/skills/landing/scripts/land.py slot --`. The reproducible runner is `/persist/home/.local/state/pstack-t3/gre353-owner-mapping/verify-pin-fix.py`. Its run directory is `/persist/home/.local/state/pstack-t3/gre353-owner-mapping/pin-fix-20261014-172049`.
Environment used native Node 24.21.0 first in PATH, `VITE_PRINT_PARTNER_DESKTOP=1`, `CARGO_BUILD_JOBS=4`, `CARGO_TARGET_DIR=/persist/home/.local/state/pstack-t3/gre353-next/target`, and `PP_DESKTOP_RELEASE_MANIFEST=/persist/home/.local/state/pstack-t3/gre353-owner-mapping/pin-fix-20261014-172049/stage/bundle-manifest.json`. The runner removed inherited `PP_DESKTOP_REBUILD`. Runtime cases set gates in isolated subprocesses.

The commands and results are recorded below.

- `npm --prefix web run test -w @print-partner/server -- src/desktop-account.test.ts src/desktop-context.test.ts`. 68 tests passed across 2 files. Log `/persist/home/.local/state/pstack-t3/gre353-owner-mapping/pin-fix-20261014-172049/node-tests.log`.
- `npm --prefix web run typecheck -w @print-partner/server`. PASS. Log `/persist/home/.local/state/pstack-t3/gre353-owner-mapping/pin-fix-20261014-172049/typecheck.log`.
- `npm --prefix web run build`. server and desktop web build PASS. Log `/persist/home/.local/state/pstack-t3/gre353-owner-mapping/pin-fix-20261014-172049/web-build.log`.
- `python3 rust/scripts/stage-desktop.py --web web --node /opt/agent-fleet/artifacts/.local/share/mise/installs/node/24.21.0/bin/node --output /persist/home/.local/state/pstack-t3/gre353-owner-mapping/pin-fix-20261014-172049/stage --commit 10eda6522ee595d44d32b79c09e7af422a282ea8`. fresh stage PASS with Node v24.21.0. Log `/persist/home/.local/state/pstack-t3/gre353-owner-mapping/pin-fix-20261014-172049/stage.log`.
- `cargo clippy --locked --manifest-path rust/Cargo.toml -p pp-core -p pp-compat --all-targets -- -D warnings`. pp-core and pp-compat all targets PASS with warnings denied. Log `/persist/home/.local/state/pstack-t3/gre353-owner-mapping/pin-fix-20261014-172049/clippy-off.log`.
- `cargo clippy --locked --manifest-path rust/Cargo.toml -p pp-core -p pp-compat --all-targets --features desktop_rebuild -- -D warnings`. pp-core and pp-compat all targets PASS with warnings denied. Log `/persist/home/.local/state/pstack-t3/gre353-owner-mapping/pin-fix-20261014-172049/clippy-on.log`.
- `cargo test --locked --manifest-path rust/Cargo.toml -p pp-compat --features desktop_rebuild account_pin -- --nocapture`. 3 Rust pin tests PASS. Log `/persist/home/.local/state/pstack-t3/gre353-owner-mapping/pin-fix-20261014-172049/pin-units.log`.
- `cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-core --features desktop_rebuild --test runtime_m0 --no-tests=fail --success-output=immediate -E 'test(ticket_t_68_desktop_account_mapping)'`. 9 real runtime scenarios PASS. Log `/persist/home/.local/state/pstack-t3/gre353-owner-mapping/pin-fix-20261014-172049/mapping-on.log`.
- `cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-core --test runtime_m0 --no-tests=fail --success-output=immediate -E 'test(ticket_t_68_desktop_account_mapping)'`. 2 real runtime gate controls PASS. Log `/persist/home/.local/state/pstack-t3/gre353-owner-mapping/pin-fix-20261014-172049/mapping-off.log`.
- `cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-core --test runtime_m0 --no-tests=fail --success-output=immediate -E 'test(protected_real_node_lifecycle)'`. 1 protected real Node lifecycle PASS. Log `/persist/home/.local/state/pstack-t3/gre353-owner-mapping/pin-fix-20261014-172049/lifecycle-off.log`.

`cargo fmt --manifest-path rust/Cargo.toml --all --check` passed through the same slot wrapper. `git diff --check` and the staged diff check passed. The full diff was inspected with the deslop skill. No new workaround comments, casts, suppressions, or generic wrappers were added. Independent design and comment-review delegation stayed with the parent under the explicit no-child constraint.

The runtime receipts are recorded in `/persist/home/.local/state/pstack-t3/gre353-owner-mapping/pin-fix-20261014-172049/runtime-receipts.json`. The post-shutdown readonly fixture audit is `/persist/home/.local/state/pstack-t3/gre353-owner-mapping/pin-fix-20261014-172049/fixture-audit.json`. Actual fixtures include the following.

- `fresh_store_stays_synthetic_when_enabled` at `/persist/tmp/pp-ticket-t-68-account-f720bc15ec7eb559`. Fixture exists and runtime owner marker is absent.
- `mapped_metadata_demotion_deletion_and_restore_refusal` at `/persist/tmp/pp-ticket-t-68-account-f552374131ea1733`. Fixture exists and runtime owner marker is absent.
- `database_replacement_including_alias_fails_closed` at `/persist/tmp/pp-ticket-t-68-account-168487767a6980cf`. Fixture exists and runtime owner marker is absent.
- `mapped_account_reads_writes_and_restarts_without_foreign_changes` at `/persist/tmp/pp-ticket-t-68-account-e3380daf940dbf71`. Fixture exists and runtime owner marker is absent.
- `gates_off_refuse_existing_accounts_even_with_child_env` at `/persist/tmp/pp-ticket-t-68-account-fc1ab79c2af0937e`. Fixture exists and runtime owner marker is absent.
- `present_mapping_pin_rejects_removal_after_crash` at `/persist/tmp/pp-ticket-t-68-account-82e7fccb1ef60211`. Fixture exists and runtime owner marker is absent.
- `missing_mapping_pin_rejects_later_account_after_crash` at `/persist/tmp/pp-ticket-t-68-account-ab60787b7ad08e6a`. Fixture exists and runtime owner marker is absent.
- `mapping_pin_survives_compat_crash_and_full_restart` at `/persist/tmp/pp-ticket-t-68-account-e4aaabca93a2440a`. Fixture exists and runtime owner marker is absent.
- `mapping_refusals_happen_before_product_writes` at `/persist/tmp/pp-ticket-t-68-account-e9201e3be017eaa3`. Fixture exists and runtime owner marker is absent.
- `gates_off_refuse_existing_accounts_even_with_child_env` at `/persist/tmp/pp-ticket-t-68-account-acb8950daf9b71f6`. Fixture exists and runtime owner marker is absent.
- `compile_gate_off_refuses_mapping_despite_runtime_opt_in` at `/persist/tmp/pp-ticket-t-68-account-3ba630f4777862a1`. Fixture exists and runtime owner marker is absent.

The changed-mapping crash at `/persist/tmp/pp-ticket-t-68-account-e4aaabca93a2440a` returned HTTP 503 with `Compatibility backend unavailable`. Assertions proved the old gateway session never became account B and could not read its Plan. A full runtime restart admitted account B and read `Foreign Plan`.
The initially missing mapping at `/persist/tmp/pp-ticket-t-68-account-ab60787b7ad08e6a` also returned HTTP 503 after a new account and mapping appeared in its disposable database. A full restart admitted account A. The removed mapping at `/persist/tmp/pp-ticket-t-68-account-82e7fccb1ef60211` returned HTTP 503 after its child crash.
The owned-tenant fixture at `/persist/tmp/pp-ticket-t-68-account-e3380daf940dbf71` contains Plan 101 as account A `Owned edited` and Plan 304 as account A `Mapped new Plan`. It retains Plan 202 as account B `Foreign Plan` and Plan 303 as default `Legacy Plan`. The runtime test compared every foreign/default tenant table snapshot, foreign user rows, printer queue sentinels, and foreign/default artifact files before and after normal startup, writes, shutdown, and full restart.
Nine invalid admission controls proved refusal before product writes. They cover no map, corrupt JSON, unknown field, unknown user, tenant mismatch, default account, symlink, public mode, and old schema. Unit controls additionally cover oversized files, FIFO, directory, foreign UID, hash mismatch, removed and appeared pins, strict account-mode schema, deletion, demotion, and database aliases.
The protected lifecycle receipt records `child_reaped=true`, `persisted_origin=true`, and build ID 1 at `/persist/tmp/pp-m0-92c7035f543cb1b7`. `/persist/home/.local/state/pstack-t3/gre353-owner-mapping/pin-fix-20261014-172049/process-cleanup.json` records no remaining process using this fresh staged child path.

Verification limits remain explicit. This is unsigned Linux headless proof through the real Rust gateway and staged Node product. Legacy default-tenant mapping, native handoffs, Mac, and signed acceptance remain open. Live external in-place database replacement remains unsupported. This does not complete all of GRE-353.
The stage manifest is stamped with precommit base `10eda6522ee595d44d32b79c09e7af422a282ea8`. The verified source hashes match all 17 files in committed head `968b35a3f5548433ba3e2f330a38a97ba4eada08`, recorded in `/persist/home/.local/state/pstack-t3/gre353-owner-mapping/pin-fix-20261014-172049/owner-proof.json`. This is source-equivalent precommit author proof, not the parent's independently rebuilt exact-head receipt. The parent must independently rebuild this exact head before review, PR, CI, and fresh Grok Build scoring.
The prior `runtime-feature.log` route/method expectation failures and `runtime-pin-repro.log` failing lifetime demonstration remain untouched. The prior provider flag reported in the task brief remains part of the parent record. This owner encountered no provider restriction or failed acceptance command and did not repeat the old pre-fix demonstration.

The changed paths are recorded below.

- `docs/desktop-rebuild.md`.
- `rust/crates/pp-compat/Cargo.toml`.
- `rust/crates/pp-compat/src/lib.rs`.
- `rust/crates/pp-compat/src/ticket_t_2.rs`.
- `rust/crates/pp-compat/tests/installed_bundle_lifecycle.rs`.
- `rust/crates/pp-core/Cargo.toml`.
- `rust/crates/pp-core/src/lib.rs`.
- `rust/crates/pp-core/tests/runtime_m0.rs`.
- `web/apps/server/src/adapters/self-host/index.ts`.
- `web/apps/server/src/app.ts`.
- `web/apps/server/src/db/client.ts`.
- `web/apps/server/src/desktop-context.ts`.
- `web/apps/server/src/desktop.ts`.
- `rust/crates/pp-compat/src/account_pin.rs`.
- `rust/crates/pp-core/tests/runtime_m0/ticket_t_68_desktop_account_mapping.rs`.
- `web/apps/server/src/desktop-account.test.ts`.
- `web/apps/server/src/desktop-account.ts`.
