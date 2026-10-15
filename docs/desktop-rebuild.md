# Desktop rebuild flag

GRE-596 adds a build gate and a runtime opt-in for the desktop rebuild in GRE-595. Both default to off.

The `desktop_rebuild` Cargo feature is available on `pp-core`, `pp-contracts`, `pp-domain`, `pp-storage`, and `pp-desktop`. The desktop feature enables the core feature. The contracts feature exposes the new `build_identity`, `reconciliation`, `publication`, and `working_drafts` modules. Existing autosave contracts stay available in both builds.

GRE-498 adds the `pp-domain::features` registry and `pp-storage::features` tenant and Plan overrides behind `desktop_rebuild`. The storage client requires an explicit `AuthPolicy`. User choices are account preferences under the current one-account-per-tenant model. `SingleAccountDefault` maps sessions to the `default` tenant.

When `PP_DESKTOP_REBUILD` is exactly `1` or `true`, Node printer queue suggestions honor each queued item's Plan overrides. Plan choices override user choices, then default to false. Profileless items inherit user choices. The global `get_farm_status` operation through MCP and the assistant stays user-scoped. Authenticated `GET` and `PATCH /plans/:id/features` are available at the root, `/api/v1`, and `/api/v2` only with these exact flag values. A patch value of `null` clears the Plan override and restores inheritance. Optional modules gain Node admission guards in separate slices.

With these exact flag values, Bambu and Spoolman inspection at `GET /api/v1/integrations/:id/status`, `GET /api/v1/integrations/:id/devices`, and `POST /api/v1/integrations/:id/test` requires the current tenant's matching `bambu` or `spoolman` choice to be enabled. Default or explicit opt-out returns 403 `FEATURE_DISABLED`. Malformed stored choices return 500 `FEATURE_TOGGLES_INVALID`. Admission runs after authentication and before status execution or adapter calls, including cached status reads. These tenant-global routes ignore Plan overrides. Saved connector metadata and editing remain available. Other integration types and flag-off inspection retain their existing behavior.

With these exact flag values, `POST /printer-send-queue` and its `/api/v1` alias check Bambu feature access when the linked host is Bambu. The selected owned Plan override takes precedence over the tenant's Bambu choice, then defaults to off. Admission follows Plan ownership and fleet-host resolution. Default or explicit off returns 403 `FEATURE_DISABLED`; corrupt tenant or selected Plan choices return 500 `FEATURE_TOGGLES_INVALID` before enqueue. Enabled Bambu retains the existing 400 unsupported-host response. This adds no Bambu transport or worker, dispatch, drain, or suggestions enforcement. Moonraker, PrusaLink, and flag-off admission retain their existing behavior.

Multipart staging still precedes queue admission. Every refusal removes the staged artifact, including feature denial and enqueue failure. Successful enqueue transfers artifact ownership to the queue. Cancellation removes that artifact through the existing cleanup path.

Enabling one connector type does not admit the other. Non-Bambu and non-Spoolman inspection remains available without reading feature choices.

With `desktop_rebuild`, Rust library callers can open storage with `WriterOwner::open_with_job_feature_admission(directory, limits)`. Every worker from that owner checks `Feature::Spoolman` before admitting a new `SpoolmanDeduction`. Ordinary `open` and `open_at` retain legacy behavior. Repeat the opted-in constructor on each reopen. Storage reads no runtime environment flag.

Admission resolves the stored job tenant and `PrinterUpload.profile_id` through the existing feature API's owned `build_profiles` Plan. Plan choices override user choices, then default to false. Missing or foreign Plans and corrupt settings return errors. Disabled admission returns typed `JobFailure::FeatureDisabled` before changing the job or renewing its lease. Existing effects can still be confirmed or reconciled after a disable. `Finish(None)` still requires primary printer receipts. This is Rust library enforcement only. No production Spoolman driver or desktop bootstrap wiring is added.

`CoreRuntime::start` reads `PP_DESKTOP_REBUILD` once at startup and stores the effective setting. `CoreRuntime::desktop_rebuild().enabled()` returns that setting. Only the exact values `1` and `true` enable it, and only when `pp-core` was compiled with `desktop_rebuild`. Missing, non-Unicode, empty, false, and unrecognized values produce false. The setting is process-local and does not change `desktop.toml` or persisted data.

D1 adds no routes, storage migrations, UI, or rebuild execution. The existing gateway and Node compatibility runtime continue to run even when both gates are enabled. Future rebuild behavior must check the stored runtime setting and compile behind the Cargo feature.

Build the native shell with the core gate enabled using its existing staging prerequisites:

```sh
PP_DESKTOP_REBUILD=true cargo run --locked --manifest-path rust/Cargo.toml -p pp-desktop --features desktop_rebuild
```

The contracts and core gates can be tested without a native shell:

```sh
cargo test --locked --manifest-path rust/Cargo.toml -p pp-contracts
cargo test --locked --manifest-path rust/Cargo.toml -p pp-contracts --features desktop_rebuild
cargo test --locked --manifest-path rust/Cargo.toml -p pp-core --lib
cargo test --locked --manifest-path rust/Cargo.toml -p pp-core --lib --features desktop_rebuild
```

Core tests isolate environment changes in child processes. They cover absent, disabled, invalid, and enabled values with and without the Cargo feature. The existing autosave consumer tests run in both contract builds. The Rust runtime proof checks the existing authenticated endpoints, source creation, response shapes, and shutdown with the runtime opt-in absent or false.

## Slice plan

The rebuild ships as small PRs to `main`, each under about 1.5k lines and checkable on its own. New product code compiles behind the `desktop_rebuild` Cargo feature, and anything user-visible also checks the runtime setting. D4 records media already shipped in #131 and adds no product code. D31 and D32 add CI or documentation only. The default build stays unchanged. The old desktop stack (#135 to #168, `desktop/rust-core`, and the reference branch `desktop/source-sync-local-current-20261008`) is reference only. It is not merged, and it is not closed or deleted until the slices cover it.

Each slice is done when:

- the existing suites pass with the feature off and on, and the default build is unchanged;
- a reviewer engine other than the author's scores it above 8 on the exact head, with all checks green.

Slices land in this order. Linear tracks each one under GRE-595. A slice is one Linear item and may ship as several PRs (D16 is planned as three). Some modules already exist on main from earlier PRs (for example #129 to #131); a slice ports only the delta from the reference branch.

| Slice | Linear | Scope |
| --- | --- | --- |
| D1 | GRE-596 | Flag scaffold and pp-contracts additions (merged, #316) |
| D2 | GRE-597 | pp-core profile_interpreter |
| D3 | GRE-598 | pp-core review_observations, source_acquisition and uploads |
| D4 | GRE-599 | pp-source media |
| D5 | GRE-603 | pp-source retained_capture |
| D6 | GRE-605 | pp-storage auth and native_secrets |
| D7 | GRE-600 | pp-storage catalog core |
| D8 | GRE-601 | pp-storage catalog naming and tests |
| D9 | GRE-602 | pp-storage manifest_text and build_graph |
| D10 | GRE-604 | pp-storage build_graph manifest_options |
| D11 | GRE-606 | pp-storage required_units |
| D12 | GRE-607 | pp-storage working_drafts core, yaml and preparation |
| D13 | GRE-608 | pp-storage working_drafts save, manifest, rebase and siblings |
| D14 | GRE-610 | pp-storage uploads and capture_manifest |
| D15 | GRE-611 | pp-storage jobs model and subscriptions |
| D16 | GRE-609 | pp-storage jobs engine (3 PRs) |
| D17 | GRE-613 | pp-storage source_scan |
| D18 | GRE-614 | pp-storage source_sync |
| D19 | GRE-612 | pp-storage plan_publication |
| D20 | GRE-615 | pp-storage checkoff_progress |
| D21 | GRE-616 | pp-storage read_model context and graph |
| D22 | GRE-618 | pp-storage read_model workflow and views |
| D23 | GRE-617 | pp-api auth HTTP |
| D24 | GRE-619 | pp-api drafts HTTP |
| D25 | GRE-620 | pp-api builds HTTP and jobs |
| D26 | GRE-621 | Web and server wiring behind the flag |

Gap slices added in triage on 2026-10-13 cover commits that are not in the reference branch. The flag rule applies to D27 to D30. D31 is CI-only and D32 is a docs-only audit, so neither needs the flag.

| Slice | Linear | Scope | Lands after |
| --- | --- | --- | --- |
| D27 | GRE-622 | Plate layout and STL geometry parity (#161) | D10 |
| D28 | GRE-623 | ZIP acquisition label policy and bundle-probe SQLite lifetime (#149) | D4 |
| D29 | GRE-624 | Failed-Save intent retry and draft lifecycle replay (#145, #148) | D13 |
| D30 | GRE-625 | Source catalog metadata through Rust HTTP (#144) | D8, D23 |
| D31 | GRE-626 | Reconcile CI ratchet commits from #155 with main | D1 |
| D32 | GRE-627 | Coverage audit mapping #133 and #135 patches to slices | none; runs early, re-checked before cutover |

Turning `desktop_rebuild` on by default is a separate decision for the maintainer after D26 and D32.

### D4 media reconciliation

GRE-599 reconciles media already shipped in #131. The `pp-source` media library, the `pp-source-media` CLI, and all unconditional #131 exports remain available in the default build. This slice adds a historical audit and documentation. It adds no feature behavior, host, runtime API, or dependency.

Run the read-only audit from the repository root:

```sh
python3 rust/scripts/audit-d4-media.py
```

The audit uses fixed revisions and does not follow the current `HEAD`:

- Landed #131 is `1beaa1cc09622611505b6470402027053db10d91`.
- The reference is `d73b6d8d250b84e22b37262a0c2720d4f777a0ca`.
- The audited snapshot is `2e3cac927a1a82cf2d1a276f9564772f6cd67ee4`.

Within `rust/crates/pp-source/`, the inventory covers `src/media.rs`, `src/bin/pp-source-media.rs`, `tests/media.rs`, `tests/direct_model_binding.rs`, `tests/support/process.rs`, and `src/archive.rs`. It also covers the union of paths under `rust/tests/source-media/` at all three revisions. Every audited file must equal its #131 blob. The shared media test and CLI equal the reference. All nine probe files equal the reference except `verify-zip64.py`.

The direct-model binding test and its process helper are intentional #131 additions absent from the reference. `archive.rs` is a dependency already reconciled in #131. Its reference version lacks `read_bound_entry`. The audit checks the landed archive blob identity without classifying the archive implementation as D4. The pinned `lib.rs` module prefix and Cargo feature section also confirm unconditional media and an empty `desktop_rebuild` feature.

On success, the audit prints the commit IDs, each file's blob identity and reference delta, and unified reference-to-audited diffs. The three media hunks and the probe changes have these reasons:

- Model reads use #131's `local_header_offset`, `inflated_bytes`, and `archive::read_bound_entry` to bind model bytes to the validated ZIP64 payload. `readBytes` includes the inflated model length. Preserve `direct_model_redirect_is_rejected_before_publish_and_valid_models_still_convert` in `tests/direct_model_binding.rs`, which rejects redirected reads before publication and still converts valid models.
- Grammar compilation reports `3MF grammar regex is invalid` instead of an unnamed unwrap panic. Missing attribute or entity captures return `MediaError::Invalid`. The regex patterns remain identical to the reference.
- `radix_number` returns `NaN` for a non-digit instead of unwrapping a failed digit conversion.
- `verify-zip64.py` sends the inflated budget through `archiveLimits` and asserts `archive-limit`. The reference sends that archive budget through media `limits` and does not assert the error code.

Exit 0 means all identity checks passed. Exit 1 reports a file, inventory, or gate mismatch. Exit 2 reports missing Git, missing historical objects, or a Git command failure. Failures go to stderr without a success summary. A checkout without the pinned history must fetch history containing those full commit IDs before rerunning. The audit never fetches, checks out files, writes files, or runs Cargo. Blob equality proves historical file identity, not a fresh probe execution. Later media changes do not invalidate this fixed audit.

The existing full source suites cover media, direct-model binding, and archive behavior with the feature off and on:

```sh
cargo test --locked --manifest-path rust/Cargo.toml -p pp-source
cargo test --locked --manifest-path rust/Cargo.toml -p pp-source --features desktop_rebuild
```

D5 retained capture and D28 ZIP acquisition label policy remain separate slices. The second D3 PR for source acquisition and uploads remains deferred. Local selection is outside this audit. This audit introduces no user-visible path and needs no runtime gate. Future rebuild callers must compile behind `desktop_rebuild` and check `PP_DESKTOP_REBUILD` for exactly `1` or `true`.

### D7 catalog core

GRE-600 adds explicit catalog requests behind `desktop_rebuild` to the existing
`SourceCatalogClient`, writer queue and transaction-owned catalog state.
`CreateCatalogSource` and `UpdateCatalogSource` normalize GitHub locations;
creation requires model URLs for Printables, MakerWorld and Thangs.
Legacy `Create` and `Update` retain their existing behavior in both builds.
`SourceActivity` reads tenant-scoped events with a limit between 1 and 100.
Category requests return typed categories and trees, and numeric category updates
retain each finite selector's success or failure after deduplication.
JSON numeric selectors and activity IDs retain their exact JSON numbers. Only
integer selectors represent mutable IDs. Native finite floats normalize to integer
selectors only within the JavaScript safe integer range; other floats retain their
failure echoes. GitHub owner and repository segments reject delimiters and dot
segments before normalization. Category validation returns typed input errors with
the feature enabled and retains legacy error messages with it disabled. These are
intentional safety corrections to the D7 reference. Storage errors stay distinct.
`catalog_access` and `catalog_key_access` bind an explicit authentication policy.

With the feature enabled, import-rule bodies have an 8 MiB limit; other requests
retain the 1 MiB limit. The default build retains its 1 MiB limit for all requests.
The existing schema, JSON validation, writer deadlines, work leases and protected
delete audit commits remain unchanged. Naming additions and broad catalog tests
belong to D8. Sync configuration versions, reservation proofs and upload guards
remain deferred to the slices that introduce their consumers.

No runtime, HTTP or UI caller selects these operations. Future user-visible callers
must compile behind `desktop_rebuild` and check the stored `PP_DESKTOP_REBUILD`
setting for exactly `1` or `true` before using them.

### D8 naming preview

GRE-601 adds `PreviewNaming` behind `pp-storage/desktop_rebuild`. The request
accepts a relative path and an optional typed partial profile. Missing override
fields inherit tenant global defaults. Explicit null fields and unknown fields
are rejected. Preview uses the existing catalog authentication policy and writer
transaction without saving naming settings or accessing files.

Folder rules take priority over markers. Markers use descending UTF-16 length
within each path segment. Slug stripping follows configured marker order and
restores the original name if stripping empties it. Quantity captures retain the
reference's numeric-prefix parsing, minimum of one, and nullable nonfinite result.
The default build excludes this request and retains existing naming behavior.

The rebuild CI gate runs the feature-on catalog suite. This storage unit adds no
runtime, HTTP or UI caller. Future user-visible callers must also check
`PP_DESKTOP_REBUILD`. Tests for later source-work and capture APIs remain deferred.

### D6 auth scheduling

GRE-605 adds `WriterOwner::rebuild_auth_with_policy(policy, lifetimes)` behind
`desktop_rebuild`. This explicit library constructor returns `RebuildAuthClient`.
The existing `auth` and `auth_with_policy` constructors retain their existing pool
and default session/key lifetimes with the feature off or on. No runtime caller
selects the rebuild client. D23/D26 must check the stored `PP_DESKTOP_REBUILD`
setting before selecting it.

The rebuild client admits at most 34 flows and sends only password hashing and
verification to two KDF workers. SQL stages run through the storage writer;
status, session resolution, logout and key operations can progress while both KDF
workers are occupied. Ready auth work has a separate queue and alternates with ordinary writer work,
so it cannot consume ordinary write capacity. Full KDF queues retry without
blocking that writer. A login that loses a credential comparison retries once
by reloading the same user and re-verifying the supplied password outside the writer. Shutdown rejects late KDF
results. Credential compare-and-swap checks remain in the shared SQL executor.
`AuthLifetimes::shorter` supports shorter sessions and optional key expiry.

The port preserves main's `User::has_password`, HMAC key hashing, hostile-cost
checks and legacy constructors. The reference's subscription revalidation calls
remain deferred to D15, where subscriptions are introduced. Native-secret and
durable-authority support is the other D6 PR. Neither PR completes GRE-605 until
both clear the coordinator's exact-head Grok Build gate.

### D5 retained capture

GRE-603 ports the full reference `pp-source::retained_capture` module behind `desktop_rebuild`, including its eight embedded tests. Deliberate fixes beyond the reference track allocation cleanup receipts, reject malformed frozen layouts, and validate inventory and transfer paths before I/O or staging. Minimal support adds `local_selection::InputFile`, inventory and capture helpers, pinned-identity directory operations, and optional `getrandom`. Transfer atomically refuses existing import operations and creates destination files exclusively. Failed transfers can leave staging. The separate 20-test reference suite passed locally and is excluded from this slice; a compact public test covers lifecycle, reopen, inventory, transfer, malformed reopen, entry limits, path collisions, and existing-operation sentinel preservation. Current root, ancestor, path, and ACL protections remain in place. No runtime callers, routes, or CLI commands use these APIs. Later integration remains deferred and must check `PP_DESKTOP_REBUILD` for exactly `1` or `true`. GRE-603 stays In Progress.

Final slot cleanup rechecks the pinned directory identity during allocation rollback, candidate abort, frozen removal, and deletion recovery. A slot replaced before that check returns an error and preserves the replacement. This is an identity check before unlink, not an atomic guarantee against concurrent replacement between the check and unlink.

## Directory layout resolver

GRE-344 adds `pp_core::layout` behind the default-off `desktop_rebuild` Cargo feature. `DirectoryLayout::resolve` takes a platform, home path, and `LayoutEnvironment` snapshot. It returns store, auxiliary app data, config, logs, and cache paths without filesystem access. `store` retains `~/.print-partner` outside portable mode, as required by [ADR 0005](adr/0005-desktop-product-identity.md). The existing database and `desktop.toml` belong to `store`. Outside portable mode, `app_data` holds auxiliary state. Portable mode places both `store` and `app_data` in `<root>/data`.

The desktop launcher selects the resolver's `store` only when its own `desktop_rebuild` Cargo feature is compiled and `PP_DESKTOP_REBUILD` is exactly `1` or `true`. With either gate off, it retains the legacy absolute-home check and `~/.print-partner` store. The debug-only `--data` override wins verbatim and skips environment and home lookup, including for a relative path. With both gates on, a present `PP_PORTABLE_DIR` skips home lookup even when the root is invalid. An invalid portable root returns the resolver error without a home fallback. Without a portable root, the enabled selector obtains home once and passes it to the resolver. The server continues to require `--data`. No data migration is included.

macOS auxiliary app data and config use `~/Library/Application Support/com.poitee.printpartner`. Logs use `~/Library/Logs/com.poitee.printpartner`, and cache uses `~/Library/Caches/com.poitee.printpartner`.

Linux auxiliary app data uses the `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, and `XDG_CACHE_HOME` roots. Missing or empty values default to `~/.local/share`, `~/.config`, `~/.local/state`, and `~/.cache`. Each path appends `com.poitee.printpartner`; logs also append `logs` under the state directory. A nonempty relative XDG value returns an error rather than choosing a directory relative to the process working directory.

`LayoutEnvironment::from_env` reads those variables, `APPDATA`, `LOCALAPPDATA`, and `PP_PORTABLE_DIR`. A supplied portable root takes precedence on every platform and appends `data`, `config`, `logs`, and `cache`. An empty portable root returns an error. Selected roots and the home path must be absolute and contain no parent traversal. The resolver preserves non-Unicode paths and does not canonicalize paths or follow links.

The launcher consumes only `store`. Preferences, origin state, the database, recovery, and service logs keep following that selected directory. Portable service logs remain `<root>/data/logs`. The resolver's sibling `<root>/logs` path is unused. Auxiliary directory integration, browser preference capture and restore, and installed artifact receipts remain open. The resolver stays independent of the runtime gate. The launcher selector uses `DesktopRebuild::from_env()`.

Unix store admission runs before runtime ownership cleanup or lock creation, and before standalone Rust writer database preflight. Public `pp_storage::lease::prepare_directory` callers use the same admission checks. New directories use mode 0700, restricted further by the process umask. Existing stores must belong to the effective user, grant that user read, write and search permissions, and deny group and other write permissions. Admission preserves existing modes, including legacy 0755 stores, and resolves data-directory aliases. It refuses unsafe stores without changing their permissions or contents. This shared runtime protection applies with the rebuild gate off and on, including `pp-server --data`.

Before recursive creation, admission checks existing input prefixes and their resolved ancestry, including the full working-directory ancestry for relative paths. It checks canonical ancestors again after creation. Ancestors must belong to root or the effective user and deny group and other write permissions unless they have the sticky bit. This permits trusted aliases and sticky temporary directories, including the macOS `/tmp` alias. The store itself keeps the stricter owner and mode requirements. Unsafe ancestors fail with `Unsafe data directory ancestor` before lock creation or database preflight.

Store admission checks permissions on an open directory descriptor and holds it while it resolves the canonical path. It compares that descriptor's device and inode with the canonical directory, then rechecks the canonical leaf's owner and permissions. Replacement at this checkpoint fails with `Data directory was replaced` before lock creation, ownership cleanup or database preflight. Existing aliases remain supported.

Lease acquisition keeps that descriptor through OS-lock acquisition and opens `.desktop.lock` relative to it. It rechecks directory identity and permissions before opening the lock, before locking, and after locking, before ownership marker access. An observed replacement fails with `Data directory was replaced`. A lock created during a replacement race belongs to the admitted directory; refusal closes the lock without path-based cleanup.

The standalone Rust writer retains the same admitted descriptor through its first read-only database preflight and into lease acquisition. It rechecks identity and permissions immediately before preflight, refusing an observed replacement before database capture, temporary-copy creation or SQLite open. It rechecks resolved ancestor permissions after preflight, before lock creation.

These Unix checks remain snapshots, not path confinement. Replacement during preflight capture or after the OS-lock checkpoints, transient replacement restored between checks, ancestor replacement, ACL policy, standalone Node admission, and Windows runtime permission policy remain open.

Windows auxiliary app data and config use `<APPDATA>/com.poitee.printpartner`. Cache uses `<LOCALAPPDATA>/com.poitee.printpartner`; logs append `logs` to that local directory. Missing or empty variables fall back independently to `~/AppData/Roaming` and `~/AppData/Local`. Nonempty relative or parent-traversing values return a named error. The legacy store remains `~/.print-partner`. Windows ignores XDG values; macOS and Linux ignore Windows values.

These are pure path mappings using the host's `Path` semantics. The Linux tests supply absolute Linux paths to exercise the Windows mapping policy. They do not parse Windows drive or UNC paths on Linux, resolve Windows Known Folders, or establish a Windows build or launcher receipt. Rust entry points still contain Unix-specific APIs.

Portable path tests run on Linux, including the macOS and Windows mappings:

```sh
cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-core --lib --features desktop_rebuild --no-tests=fail -E 'test(layout::tests::ticket_t_12)'
```

### Origin recovery and library preferences

CoreRuntime replaces a valid saved port only when binding returns `AddrInUse`. It holds the replacement listener while publishing a private same-directory file, syncing the file, checking the old file identity and content, renaming, and syncing the directory. Node starts only after publication succeeds. Missing configuration retains hard-link publication without clobbering an existing name. Corrupt and unsafe configuration still fails closed. `origin_change()` returns an optional immutable `OriginChange::PersistedPortInUse` with nonzero old and new ports. Its display notice contains no launch token or credentials.

`CoreHandle` offers typed per-field updates and reads for `BrowserPreferences` under the existing storage lease. The versioned `browser-preferences.json` sidecar is independent of the port. It stores optional sidebar collapse, theme, and supported printer poll interval values. Unknown fields, invalid values, unsupported versions, unsafe files, and oversized files fail without overwrite. Updates preserve other fields and unrelated portable-store bytes. Shutdown closes command admission and settles queued callers before releasing the lease.

This is a library contract. GRE-368 must wire browser capture and restore and show the origin-change notice. Existing origin-scoped localStorage and IndexedDB do not follow a changed port today. These operations do not relocate or rewrite product databases or transfer authentication data. A new runtime always bootstraps its gateway session, without adding a user login flow.

## Review observations

GRE-598 adds `pp_core::review_observations` behind `desktop_rebuild`. Library callers can observe an accepted storage snapshot for available input roots, missing STL artifacts, and accepted thumbnail signatures. Reads share entry, path, byte, and elapsed budgets and support cancellation. Source inventory reads use pinned directory handles. The small `pp-source::observation` helper is gated by the source crate's new feature, enabled by the core feature.

An optional filament provider reads bounded JSON over HTTP, confines redirects to its original origin, and resolves only its configured integration's filament identifiers. Provider reads reuse the checked `pp-net` address policy and pin DNS answers before connecting. Cloud metadata destinations are rejected. Provider failures fall back to catalog-only lookup. Cancellation returns an error. No application routes or startup paths call these library methods, so runtime behavior remains unchanged. Later drafts API integration must check the stored `PP_DESKTOP_REBUILD` setting.

The second D3 PR remains dependent on later source and storage work. The reference acquisition and upload modules require retained capture from D5, the upload journal from D14, and import job methods from D15. Those APIs are absent on main. This port does not claim acquisition or upload completion and does not advance those slices.

### D6 native-secret migration

GRE-605 ports the reference native-secret migration protocol behind `desktop_rebuild`.
The storage owner exposes an explicit `native_secret_migration()` library client.
Opening storage does not create its receipt table; the first admitted preparation
creates it transactionally. Preparation preserves the legacy `github_pat` setting
and returns secret material plus a stable native-store locator. The caller must
write and verify the native-store copy before confirming. Confirmation revalidates
the physical storage owner, receipt generation, row identity and value before
atomically deleting the legacy setting and recording completion. Reopening resumes
the same receipt. The receipt contains no token bytes.

This slice adds no native keychain provider or startup caller. Future user-visible
migration must check the stored `PP_DESKTOP_REBUILD` setting before requesting
preparation or confirmation. Auth scheduler and authority changes are a separate
D6 PR; GRE-605 remains In Progress until both parts pass the coordinator gate.

The same D6 foundation ports durable authority receipts for sessions and routed
API keys. Receipts retain credential digests, tenant, subject and authentication
policy, and revalidation rejects changed policy or revoked credentials. Physical
owner admission checks the storage identity. These internal APIs compile behind
the feature; D15/D16 will wire them into jobs. The current job engine is unchanged.

## D10a manifest model receipt

GRE-604 D10a adds `pp_storage::manifest_options::KitManifest` behind `desktop_rebuild`.
The pure model parses request and stored JSON, normalizes selection variant IDs,
projects typed selections, and emits JavaScript-compatible JSON with UTF-16 text
and ordered objects. Input errors emit lossless JSON detail bodies.
The codec enforces 8 MiB, 64 levels, and 100,000 nodes.
Focused codec unit tests and public model integration tests run in the desktop gates.

ManifestBuilder, graph observation, known-group validation, default selection
insertion, storage commands, and runtime wiring remain deferred.

## Map one existing account

Build with the `desktop_rebuild` Cargo feature and start with `PP_DESKTOP_REBUILD=1` or `PP_DESKTOP_REBUILD=true`.
Both gates must be enabled. Node receives the account mode through the verified parent setup pipe.
A child environment variable cannot enable mapping.

Stop every process that uses the data directory before configuring a mapping.
Upgrade the copy with the existing unmapped browser or server first.
Mapped startup requires the exact current `schema_version` in `app_settings` and performs no data or schema migration.

Create `desktop-account.json` in the data directory with this exact shape.
Replace both account IDs with the existing user's `users.id`.

```json
{"version":1,"kind":"existing-account","user_id":"account-a","tenant_id":"account-a"}
```

Set its permissions to `0600` and its owner to the user who runs the desktop process.
The file must be a regular file, at most 4096 bytes, with no symlink at its path.
Unknown fields, malformed JSON, missing users, and unequal user and tenant IDs fail startup before product database writes.
The mapping selects exactly one account. It never selects the first row or changes stored tenant ownership.
A self-hosted first account can have the stored ID `default`, which claims its legacy `default` tenant.
Select that account explicitly with this mapping, only when a matching `users.id = 'default'` row exists.

```json
{"version":1,"kind":"existing-account","user_id":"default","tenant_id":"default"}
```

A missing mapping still refuses populated account databases, including a claimed `default` account.
Mapping another user ID onto the shared `default` tenant remains unsupported and fails before product database writes.
For supported legacy data in shared single-user-auth copies, use the [offline ownership copy](#copy-legacy-default-ownership-into-an-account-mapped-desktop) below.

Core pins mapping presence and the SHA256 of its bytes under the storage lease for the full runtime lifetime.
Every compatibility child checks the same pin before product startup.
A changed, removed, or newly created file rejects compatibility restarts until you stop and restart the full runtime.
Edit the file while the full runtime is stopped, then restart to select a different account.
Each authenticated request reads the selected user's current email, display name, password presence, and administrator flag.
The session provider is `desktop`. A nonadmin account stays nonadmin, and deletion rejects subsequent authenticated requests.

Mapped mode uses the isolated Source filesystem policy and runs tenant workers only for the selected account.
It skips global starter seeding, Source ownership repair, legacy export and manifest migration, outcome conversion, Advisor backfill, and shared transfer artifact sweeping.
It does not modify product rows outside the selected tenant to make them accessible.
Backup routes, including restore, are unavailable while mapped.
Replacing the database file, including through a symlink alias, rejects subsequent authenticated requests and stops scheduling tenant work.
Stop the runtime before restoring or replacing a copy, then restart for fresh admission.
Live external in-place database replacement is unsupported. Use the existing storage lease rather than writing around it.

With both gates enabled, an empty copy without a mapping retains the synthetic desktop owner.
An existing copy with users requires a valid mapping.
With either gate disabled, existing users remain refused and the original synthetic setup protocol remains unchanged.

## Copy legacy default ownership into an account-mapped desktop

GRE-353 adds an offline copy command for legacy mutable Plans and Sources. Stop the source server and desktop first. The command reserves the source with `acquireDataDirectory`, reads its current SQLite snapshot including committed WAL data, and leaves its product database and files unchanged. Ownership lease records can change during reservation and release.

Run this command on Linux with Python 3 available. Publication uses libc `renameat2` with `RENAME_NOREPLACE`. The destination must be new, its parent must already exist, and it must not overlap the source. Existing files, directories, empty directories, and symlinks at the destination all cause refusal. The tool builds a private staging directory beside the destination and publishes the complete copy atomically. Caught errors remove staging and publish nothing. Abrupt termination can leave a private `.ownership-copy-*` directory. Power-loss durability is not guaranteed.

From `web/apps/server`, inspect the stopped source with the exact runtime gate enabled:

```sh
PP_DESKTOP_REBUILD=1 npx tsx --conditions=development src/ownership-migration-cli.ts inspect /absolute/source > inventory.json
```

The inventory contains a deterministic full-database `source_digest`, table names, row identifiers, and claim placeholders. It contains no credentials, settings values, or document contents. Review every row identifier against your source data. Create a separate manifest with this shape:

```json
{
  "version": 1,
  "source_digest": "COPY_THE_64_CHARACTER_DIGEST_FROM_INVENTORY",
  "selected_user_id": "account-a",
  "claims": [
    { "table": "build_profiles", "rowid": 1, "user_id": "account-a" },
    { "table": "build_profiles", "rowid": 2, "user_id": "account-b" }
  ]
}
```

Include exactly one claim for every inventory row, including independent rows assigned to other users. Each owner and the selected user must already exist in `users` and must differ from `default`. The selected user identifies the desktop account to open. Claims can distribute unrelated Plans among multiple existing accounts. The tool does not infer ownership, clone shared dependencies, or change IDs. A Plan, its Source relationships, parts, and progress must have consistent owners. Conflicting assignments, dangling references, missing or extra claims, duplicate claims, and destination uniqueness collisions cause refusal. Machine and filament profile references from unchanged foreign assignment rows must also resolve to the same owner.

Apply the reviewed manifest to a new destination:

```sh
PP_DESKTOP_REBUILD=1 npx tsx --conditions=development src/ownership-migration-cli.ts apply /absolute/source /absolute/new-desktop /absolute/manifest.json
```

The copy contains a private `desktop-account.json` v1 mapping with `user_id` and `tenant_id` equal to `selected_user_id`. Existing desktop admission rules still apply. All unclaimed rows, including foreign tenant rows, remain unchanged. The global `default` `app_settings.schema_version` stays at `default`. The tool compares every staged table against the expected source rows before committing so trigger side effects cannot silently change unrelated data.

This first unit supports default rows only in `build_profiles`, `projects`, `profile_layers`, `parts`, `print_progress`, `source_docs`, `source_notes`, `plan_decisions`, `printer_profiles`, `process_profiles`, and `filament_profiles`. It discovers tenant tables from SQLite rather than assuming this list covers the schema. Any populated default tenant table outside that list causes refusal, except the global schema version. Bundled starter printer, process, and filament profiles are supported and require explicit claims. Their scalar fields and resolved configuration JSON retain their original bytes. Imported or externally backed profiles cause refusal when `source_path`, `raw_json`, `raw_ini`, or `compatible_printers` is nonempty. This is not a whole-application ownership migration. Do not remove product data merely to bypass refusal.

The tool refuses default settings other than `schema_version`, accepted Plan or Source history, nonzero accepted Plan versions, opaque project metadata and imported-path lists, nonempty decision parameters other than `{}`, and populated decision result JSON. It also refuses stored sessions, password reset tokens, and Plan share capabilities. Share bundles contain ownership references outside the supported row graph. No startup path or HTTP endpoint invokes it.

Filesystem support covers regular files in `repos/<project id>` and `sources/<project id>` for known projects. Symlinks and special files cause refusal. Nonempty `projects.local_path` values cause refusal in this unit, including absolute paths under the source. Relative part and document paths must contain no parent segments, empty segments, backslashes, or external locators. Unknown top-level artifacts and native storage cause refusal. Standard `exports`, `uploads`, `upload-staging`, `staging`, `backups`, `thumbnails`, `previews`, `thumbs`, and `covers` directories are accepted only when empty. Nonempty exports are ambiguous and unsupported, including foreign exports. Ownership markers, leases, the desktop lock, and the source desktop mapping are excluded from the copy. Socket files outside those excluded ownership paths cause refusal.

The source digest is rechecked after reservation and after the SQLite backup. Any database change requires a new inventory and reviewed manifest. The command exits with status 1 on refusal and status 0 with a JSON receipt on success. Both inspect and apply require `PP_DESKTOP_REBUILD` to be exactly `1` or `true`.
