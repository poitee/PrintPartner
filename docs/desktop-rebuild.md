# Desktop rebuild flag

GRE-596 adds a build gate and a runtime opt-in for the desktop rebuild in GRE-595. Both default to off.

The `desktop_rebuild` Cargo feature is available on `pp-core`, `pp-contracts`, `pp-domain`, `pp-storage`, and `pp-desktop`. The desktop feature enables the core feature. The contracts feature exposes the new `build_identity`, `reconciliation`, `publication`, and `working_drafts` modules. Existing autosave contracts stay available in both builds.

GRE-498 adds the `pp-domain::features` registry and `pp-storage::features` tenant and Plan overrides behind `desktop_rebuild`. The storage client requires an explicit `AuthPolicy`. User choices are account preferences under the current one-account-per-tenant model. `SingleAccountDefault` maps sessions to the `default` tenant.

With `PP_DESKTOP_REBUILD` exactly `1` or `true`, health advertises `tenant_feature_toggles` and Settings shows tenant controls for farm, orders, Bambu, and Spoolman. All four default to off. Authenticated `GET` and `PATCH /settings/features` use the existing tenant `feature_toggles` setting at the root and `/api/v1`. Boolean patches save tenant choices. A `null` patch clears a choice to its default. Writes preserve unknown stored values and retry concurrent changes. Corrupt choices fail closed. Plan overrides retain precedence. With the flag off, the capability and controls are absent and these endpoints return 404 before reading or writing feature choices.

Plan feature controls on the Plan page use the same capability gate. Each feature offers account inheritance, enabled, or disabled. The effective value and its source are shown. Clearing an override sends `null` and resumes live tenant inheritance. Controls and feature reads are absent when the capability is absent.

When `PP_DESKTOP_REBUILD` is exactly `1` or `true`, Node printer queue suggestions honor each queued item's Plan overrides. Plan choices override user choices, then default to false. Profileless items inherit user choices. The global `get_farm_status` operation through MCP and the assistant stays user-scoped. Authenticated `GET` and `PATCH /plans/:id/features` are available at the root, `/api/v1`, and `/api/v2` only with these exact flag values. A patch value of `null` clears the Plan override and restores inheritance. Optional modules gain Node admission guards in separate slices.

With these exact flag values, Bambu and Spoolman inspection at `GET /api/v1/integrations/:id/status`, `GET /api/v1/integrations/:id/devices`, and `POST /api/v1/integrations/:id/test` requires the current tenant's matching `bambu` or `spoolman` choice to be enabled. Default or explicit opt-out returns 403 `FEATURE_DISABLED`. Malformed stored choices return 500 `FEATURE_TOGGLES_INVALID`. Admission runs after authentication and before status execution or adapter calls, including cached status reads. These tenant-global routes ignore Plan overrides. Saved connector metadata and editing remain available. Other integration types and flag-off inspection retain their existing behavior.

With these exact flag values, `POST /printer-send-queue` and its `/api/v1` alias check Bambu feature access when the linked host is Bambu. The selected owned Plan override takes precedence over the tenant's Bambu choice, then defaults to off. Admission follows Plan ownership and fleet-host resolution. Default or explicit off returns 403 `FEATURE_DISABLED`; corrupt tenant or selected Plan choices return 500 `FEATURE_TOGGLES_INVALID` before enqueue. Enabled Bambu retains the existing 400 unsupported-host response. This adds no Bambu transport. Moonraker, PrusaLink, and flag-off admission retain their existing behavior.

Dispatch and drain at both aliases preflight Bambu access before live-job reconciliation, artifact checks, queue writes, status probes, or job starts. Admission uses each stored item's Plan, never a request-body Plan. Missing or unowned Plans fail closed. Drain preflights the selected queued batch, respecting its printer filter and eight-item cap, before dispatching any host. Both routes recheck admission after asynchronous live-job reconciliation so concurrent revocation or newly queued items cannot bypass the check. A refused request preserves the stored queue and staged files for an explicit retry. Enabled Bambu retains the existing unsupported-upload response. Non-Bambu hosts and flag-off behavior remain unchanged.

The Node `printer-upload` worker also checks admission at execution time with these exact flag values, including jobs created before a feature choice changed. For a queue-owned upload, the stored job payload must match its queue item's printer and Plan before fleet or host lookup. A mismatch fails with `Stored printer upload does not match its queue item`. For Bambu, the payload must name a positive safe-integer Plan owned by the job's tenant. The job runner accepts numeric string Plan IDs after normalization. A missing or malformed Plan fails with `Pick a plan to bind this send (profile_id required)`. A deleted, nonexistent, or foreign Plan fails with `Profile not found` before feature reads.

After resolving the Bambu host, the worker reads the current tenant and selected Plan choices before adapter access. The Plan override takes precedence, then the tenant choice, then off. Default or explicit off sets the terminal job's `error` to `FEATURE_DISABLED: Feature bambu is disabled.`. Corrupt tenant or selected Plan settings set it to `FEATURE_TOGGLES_INVALID: Stored feature toggles are invalid.`. Unrelated Plan settings do not affect admission. The job runner reconciles the linked queue item to `error` and copies the same text into its `error` field, capped at 500 characters.

A worker refusal retains the queue-owned artifact for an explicit retry. Direct-upload artifacts follow the existing cleanup path. Enabled Bambu still fails with the existing `Direct Bambu upload is not available.` message and handoff guidance. Moonraker and PrusaLink transfers keep their existing behavior without reading feature choices. With the flag absent or any value other than exactly `1` or `true`, the worker keeps legacy behavior without feature reads or these Plan and queue-payload checks. The worker guard adds no Bambu upload transport.

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

Slices land in this order. Linear tracks each one under GRE-595. A slice is one Linear item and may ship as several PRs (D16 ships as four, D14 as five). Some modules already exist on main from earlier PRs (for example #129 to #131); a slice ports only the delta from the reference branch.

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
| D14 | GRE-610 | pp-storage uploads and capture_manifest (5 PRs) |
| D15 | GRE-611 | pp-storage jobs model and subscriptions |
| D16 | GRE-609 | pp-storage jobs engine (4 PRs) |
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

### D12 observation core pull-forward

GRE-607 starts with `pp-storage::working_drafts::observation`, compiled only with
`desktop_rebuild`. This unit ports the read contracts, cancellation, preparation
limits, and cumulative budgets from the reference branch. It adds no executor,
adapter, routes, storage writes, or runtime wiring. Default builds do not expose
the module. Future user-visible callers must also check `PP_DESKTOP_REBUILD`.

`PreparationBudget::new` is public and returns `ReadResult`, validating limits
before accepting charges. Parser accounting methods are public so adapters and
future parsers can share the same budget. Byte counters saturate or use checked
addition, so oversized charges return `LimitExceeded` instead of overflowing.
Callers must propagate failures and discard the budget after a refusal. Raw
document reads and parser expansion retain separate total-byte caps.
Depth checks precede node and visit charges, matching entry accounting.

Read requests retain storage-private fields. External adapters can inspect them
but cannot create grants. This unit does not itself admit or perform any reads.

The read-only executor below uses D11's `required_units`. The observation
contract alone does not unblock GRE-604 D10b. The YAML parser and builder manifest
helpers are separate D12 units described below. The remaining D12 units are the
mutating executor and preparation. Those stay open on GRE-607.

Run its boundary and accounting proofs with:

```sh
cargo test --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild --test working_draft_observation
cargo test --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild --doc
```

### D12 YAML parser

The second GRE-607 unit ports `pp-storage::working_drafts::yaml`, the manifest
YAML reader, compiled only with `desktop_rebuild`. The module is crate-private
and feeds the builder manifest helpers. The optional `saphyr-parser` dependency
(pinned `=0.1.0`, with `arraydeque`) is enabled only by the feature, so default builds do not compile
it.

`Document::parse` charges the shared `PreparationBudget` for nodes, depth,
visits, and expansion, and checks cancellation. Each parsed node is charged once,
array separators count as two UTF-16 bytes, and each mapping tracks seen keys
in a hash set. Each mapping key charges the UTF-16 bytes of its entry copy and
its seen-key copy. Text coercions, including primitives and mappings, charge their
UTF-16 output bytes. The float matcher is compiled once. It accepts one document with
core-schema tags, `!`, anchors, and aliases. Duplicate keys, extra documents,
other tags, and tag/value mismatches return `InvalidDocument`. Scalars keep
JavaScript UTF-16 semantics: lone surrogate escapes such as `"\uD800"` survive
parsing, the private-use sentinel `U+E000` round-trips in every scalar style,
and keys follow JavaScript property order. `text`, `optional_text`, and
`truthy` apply JavaScript string and truthiness coercion. As with JavaScript
`join`, an array that reaches itself through an alias contributes an empty
string, so `project: &a [*a]` coerces to `""`.

The remaining D12 units are the mutating executor and preparation.

```sh
cargo test --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild --lib working_drafts::yaml
```

### D12 builder manifest helpers

GRE-607 exposes five crate-private helpers through `working_drafts::observation`
for GRE-604 D10b. `parse_builder_manifest` reads part rules, option groups,
repository defaults, and their scalar or array shapes. `merge_builder_groups`
preserves earlier metadata, unions patterns, and preserves JavaScript property
order. `BuilderGlob` applies the Node glob and basename rules.
`parse_builder_hints` validates version 1 path hints and rejects unknown fields.
`infer_builder_siblings` delegates to the sibling inference already on main.

The model retains UTF-16 identifiers and the existing sibling group types.
Parsing uses the shared `PreparationBudget`, including rule and expansion
accounting. Both parsers check the document size before decoding. The sibling
wrapper takes the same budget and returns `ReadResult<BuilderGroups>`, matching
the landed inference rather than the reference branch's unbudgeted signature.
These helpers compile only with the default-off `desktop_rebuild` feature.
Draft application, the executor, and preparation remain separate
units. No user-visible behavior changes in this slice.

The contract is `loadManifestYaml`, `mergeOptionGroups`, and `matchKeyMatches` in
`web/apps/server/src/services/manifest-apply.ts`, hint validation in
`path-hints.ts`, and `inferSiblingFolderOptionGroups` in `repo-tree-summary.ts`.
Supplementary Unicode wildcard parity and lone surrogate patterns remain in
[GRE-641](https://linear.app/greetz/issue/GRE-641/align-builder-path-globs-with-node-utf-16-wildcard-semantics).
The current regex API matches UTF-8 input. That follow-up enables the maintained
UTF-16 matcher through Cargo configuration outside this helper slice.

Run the helper tests through the same imports D10b uses:

```sh
cargo test --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild --lib working_drafts::manifest_tests
```

### D12 working-draft read executor

GRE-607 adds `WriterOwner::working_drafts_with_policy` behind the default-off
`desktop_rebuild` feature. The factory takes an explicit `AuthPolicy` and
returns `WorkingDraftClient`. Its `execute` method accepts a credential, profile
`PositiveId`, typed `Request`, cancellation flag, and queue wait. The requests
are `List`, `Read`, `Diff`, and `Workspace`.
They use the existing writer queue and one deferred transaction. Authentication
observes the actor without updating usage timestamps.

`Read` returns a `DraftDocument` with a validated `DraftIdentity`. `List` orders
identities by creation time and then ID. A missing or unowned profile returns
`ProfileNotFound`, and a missing draft returns `DraftNotFound`, as Node's
`PlanDraftWorkspaceService.read` and draft list route do. Draft loading reuses
the required-units reader, including its snapshot digest and selected
reconciliation validation. Document, diff, and workspace reads reject
incomplete rebase origins. `Workspace` reuses the required-units workspace
builder. No required-units reader logic changes.

`Diff` returns the complete input and Part diff against the draft's base
revision. Both the revision ID and Plan version determine `baseIsCurrent`.
Part rows sort by serialized ID as Node does. `DraftDocument` and `DraftDiff`
retain manifest strings as UTF-16 and serialize lone surrogates as JSON escapes.
Use their `into_json_body().into_bytes()` methods. The complete outcome uses
`Outcome::into_json_body()?.into_bytes()`.

This first core unit ports the read-only seam. The writes section below covers
Part edits and abandon. Preparation and recompute have their own sections. Save
and rebase remain GRE-608. There is no HTTP route or default-feature change.

The operation tests call the public client against Node-written databases.
Their literal expected JSON comes from `getPlanDraft`, `listPlanDraftIdentities`,
`diffPlanDraft`, and `PlanDraftWorkspaceService.read`. The UTF-16 case uses
`digestPlanDraft` and `diffPlanDraftSnapshot` directly because Node's SQLite
adapter cannot read the Rust PPJS blob encoding. The generator records the SQL
setup for each temporary database. It changes immutable identity or lineage
fields only after dropping the corresponding trigger in that temporary copy.

Regenerate the fixtures from the repository root with Node 22 and installed web
dependencies. The generator writes databases in the system temporary directory
and removes them when it finishes.

```sh
node --conditions=development --import ./web/node_modules/tsx/dist/loader.mjs \
  rust/crates/pp-storage/tests/fixtures/working-drafts-node.mjs web/apps/server \
  > rust/crates/pp-storage/tests/fixtures/working-drafts-node.jsonl
cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild --test working_draft_core
```

### D12 working-draft writes

`WorkingDraftClient` has two write methods. Each one queues a `Write` command
on the existing single writer. The writer runs `abandon` in one immediate
transaction and `edit` in up to two. Each transaction has its own admission
deadline, and the writer checks cancellation before each transaction starts and
again before it commits.

- `edit` ports `PlanDraftWorkspaceService.editParts` and the repository's
  `editPlanDraftPartsBatch`. It returns the `required_units::Outcome` result.
  A changed edit clears the selected Required-unit reconciliation and writes
  the new snapshot digest and Part rows. An edit that changes no Part returns
  the current draft, even when the expected digest is stale. Both paths then
  select Required units with no decisions and the key `auto-<snapshot digest>`,
  as Node's `autoReconcile` does. The selection runs in a second transaction
  after the edit commits. A retry of the same edit finds the saved selection
  and writes nothing.
- `abandon` ports `PlanDraftWorkspaceService.abandon` and the repository's
  `transitionPlanDraft` for `abandon`. It returns `AbandonOutcome`. A retry
  with the same expected lifecycle version returns the abandoned draft and
  writes nothing.

Both methods return `profile_not_found` and `draft_not_found` as separate
outcomes. A stale snapshot digest or lifecycle version returns `draft_changed`
with the current workspace. A consumed or abandoned draft returns `not_open`.

`EditRequest` and `AbandonRequest` accept the JSON bodies that Node's
`parseEditPlanDraftPartsRequest` and `parseAbandonPlanDraftRequest` accept.
An edit body has either one `decision` or 1 to 10,000 `decisions`. Each
decision names at least one Part, and a batch edits each Part field at most
once. A quantity override is `null` or an integer from 1 to 10,000.

If the selection fails or is cancelled, the edit stays committed and `edit`
returns the error, as Node does. Node's route answers that error with HTTP 500
and `internal_error`. A retry of the same edit changes no Part, so it only runs
the selection again.

Resume has no Node route or service caller, so it is not ported.

The operation tests replay each Node case on a copy of the required-units
`unchanged` database. They restart the writer between calls and compare every
outcome and the draft, Part, reconciliation, and assignment rows with Node's.
Some cases run SQL between calls, for example to remove an injected selection
failure or to advance the accepted base.
The generator runs Node's service and contract parsers. Regenerate the
fixture from the repository root:

```sh
node --conditions=development --import ./web/node_modules/tsx/dist/loader.mjs \
  rust/crates/pp-storage/tests/fixtures/working-draft-writes-node.mjs web/apps/server \
  > rust/crates/pp-storage/tests/fixtures/working-draft-writes-node.jsonl
cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild --test working_draft_writes
```

`rust/crates/pp-storage/tests/fixtures/mutate-working-drafts.py` runs the
read and write mutants against both test files. It copies the Rust workspace
into a temporary directory under `rust/target`, links the real `web` directory
beside it for compile-time includes, and builds there with its own
`CARGO_TARGET_DIR`, so it never changes the build artifacts in `rust/target`.

### D12 preparation prerequisites

GRE-607 adds the remaining manifest helpers and the accepted-base reuse check
behind `desktop_rebuild`. `optional_document` ignores missing, skipped, and
invalid optional manifests, but it checks cancellation first, and after an
invalid parse, so a cancelled attempt never reads as an absent manifest. `kit` projects stored kit selections through the
existing `KitManifest` parser. Both propagate preparation budget and cancellation
failures. `apply` preserves Node's document order, project filtering, selection
defaults, explicit group membership, group bounds, and exclusion precedence.
It accepts the shared `PreparationBudget`, charges each Part as an entry, and
charges each pattern comparison as a visit. Option-group merging, in `apply` and
in preparation's repository, hinted and inferred groups, charges a visit for each
group, variant, and path it merges, plus the entries each is compared against as
`comparison_work`. Builder observation merges the same way without a charge. A comparison keeps no memory after it
returns, so it does not charge the document-byte cap. It charges the separate
`comparison_work` counter instead. Before a comparison it charges the raw
pattern UTF-16 units plus the key's UTF-8 bytes, because normalization scans
the raw text before trimming. Each comparison builds its own `Glob`, so after
the comparison it charges the normalized pattern and key UTF-16 units plus the
glob matcher steps that `Glob` counted. The default and maximum is 2^28 units, so
comparisons at the 100,000-visit limit can average about 2,680 units each. One
comparison costs O(P + K²) units for a pattern of P units and a key of K units,
with K at most 4,096. Only the post-comparison charge can pass the limit, so an
attempt can exceed it by one comparison's normalized and matcher work. Kit JSON
passes through the budgeted document reader before the stored-kit parser, so
UTF-16 selection text uses the existing codec.

`read_model::reusable_draft_base` checks current freshness before validating the
complete accepted snapshot with the existing bounded readers. It propagates
integrity errors and checks preparation cancellation around those reads.
`catalog::naming::get` is crate-visible for the next preparation port's
transactional effective naming profile and digest. Its behavior is unchanged.
The preparation module below consumes these helpers.

The committed Node generator covers manifest application, optional documents,
stored kit selections, freshness, and accepted-base integrity. Regenerate its
literal outputs twice and compare them before replacing the fixture:

```sh
node --import ./web/node_modules/tsx/dist/loader.mjs --conditions=development \
  rust/crates/pp-storage/tests/fixtures/preparation-prereqs-node.mjs web/apps/server \
  > rust/target/preparation-first.jsonl
node --import ./web/node_modules/tsx/dist/loader.mjs --conditions=development \
  rust/crates/pp-storage/tests/fixtures/preparation-prereqs-node.mjs web/apps/server \
  > rust/target/preparation-second.jsonl
cmp rust/target/preparation-first.jsonl rust/target/preparation-second.jsonl
cmp rust/target/preparation-first.jsonl rust/crates/pp-storage/tests/fixtures/preparation-prereqs-node.jsonl
cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild --lib -E 'test(preparation_tests)' --test-threads=2
python3 rust/crates/pp-storage/tests/fixtures/mutate-preparation-prereqs.py
```

The mutation runner copies the workspace and uses a separate `CARGO_TARGET_DIR`.
It requires a passing baseline and counts only executed test failures as kills.

### D12 working-draft preparation

`working_drafts::preparation` is crate-private behind default-off
`desktop_rebuild`. It captures Source inputs and fingerprints, scans and merges
STLs, preserves accepted decisions, applies scopes and manifests, and returns
Parts and a planning digest without writing rows. Validated current accepted
Parts can bypass scanning. Its options use storage-local types, and reads use
storage-issued observation requests with the shared preparation budget.
Naming rules charge their definitions and per-path comparisons. Spoolman
defaults follow user and Plan feature choices; disabled or invalid choices drop
Spoolman references from new Parts without changing accepted decisions.
Recompute consumes it. Save and rebase remain GRE-608. Existing GRE-668,
GRE-669 and GRE-670 follow-ups remain open.

Tests compare literal Node fingerprints, Parts and digests, propagate resource
refusals, and cancel at every budget checkpoint. Regenerate the fixtures twice:

```sh
node --import ./web/node_modules/tsx/dist/loader.mjs --conditions=development rust/crates/pp-storage/tests/fixtures/working-draft-preparation-node.mjs web/apps/server > /persist/tmp/preparation-first.jsonl
node --import ./web/node_modules/tsx/dist/loader.mjs --conditions=development rust/crates/pp-storage/tests/fixtures/working-draft-preparation-node.mjs web/apps/server > /persist/tmp/preparation-second.jsonl
cmp /persist/tmp/preparation-first.jsonl /persist/tmp/preparation-second.jsonl
cmp /persist/tmp/preparation-first.jsonl rust/crates/pp-storage/tests/fixtures/working-draft-preparation-node.jsonl
cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild --lib -E 'test(working_drafts::preparation_tests)' --test-threads=2
python3 rust/crates/pp-storage/tests/fixtures/mutate-working-draft-preparation.py
```

The mutation runner copies the workspace into `/persist/tmp` with its own target
directory. Only an executed failing test counts as a kill.

### D12 working-draft recompute

`WorkingDraftClient::recompute` ports Node's `recomputePlanDraft` behind
default-off `desktop_rebuild`. Build the client with
`WriterOwner::working_drafts_with_observations`, which takes the Source reads
and preparation limits. A client from `working_drafts_with_policy` refuses
recompute. `RecomputeRequest::new` takes the `Idempotency-Key` header and the
route's `apply_manifest` flag. It trims the key as JavaScript does, refuses a
blank key with Node's message, and refuses a key over 160 UTF-16 units as the
route does. When `apply_manifest` is false, preparation keeps the current
inclusion and prefers the accepted Parts, as Node's service asks.

A recompute runs in three steps on the writer thread:

1. A read transaction resolves the actor and Plan. It returns the saved draft
   for a repeated key, or `idempotency_conflict` when that key named a rebased
   draft. It refuses a Plan that needs an accepted baseline.
2. Preparation runs outside any transaction with a fresh budget. No layers and
   no STLs become `no_layers` and `no_stls`. A request cancelled before either
   step returns its outcome fails as cancelled, as the write transaction does.
3. An immediate transaction with its own admission deadline checks the
   principal and the key again. A hidden Plan or a moved accepted base is
   `base_changed`. A changed input fingerprint is `inputs_changed`. It then
   copies quantity overrides, and inclusion when the draft is kept, from open
   drafts, as Node's `carryOpenDraftEdits` does. Before it loads an open draft,
   it charges the preparation budget for everything the load reads. That is
   one visit per row of the draft, its inputs and Parts, and for a v2 draft
   its selected reconciliation, decisions and assignments. The bytes of every
   column the load parses, hashes or compares count as comparison work. An
   open draft with more than about 100,000 assignments therefore exceeds the
   default visit limit. A limit or cancellation refusal rolls the transaction back. It abandons
   every open draft, increments their lifecycle versions, inserts the draft,
   inputs and Parts, and returns `created` with the saved snapshot.

`RecomputeOutcome::into_json_body` writes Node's result kinds. Node's service
also selects Required units after a created or existing draft. This client does
not, so a caller that needs the workspace runs the Required-unit selection
itself. Node's `would_wipe` result has no Rust preparation counterpart yet.

The operation tests replay each Node case on a copy of the required-units
`unchanged` database and compare outcomes and the `plan_drafts`,
`plan_draft_inputs` and `plan_draft_parts` rows with Node's. Creation times are
compared by format. Cases that change the database between the transactions
run their SQL after Node's preparation returns. The Rust test reads run it when
the first STL scan starts. After that scan, preparation still reads settings,
Source rows, and whether the Plan exists. Only the hidden-Plan case changes one
of those, and it only turns off Spoolman defaults, which the fixture does not
set. Both sides therefore prepare the same Parts.
Rust-only tests cover cancellation, a budget refusal, open drafts whose Parts,
selected reconciliation or any loaded column exceed the budget when their edits
are carried, a cancelled or unauthenticated request, and a client without
observations. Regenerate the fixture twice:

```sh
node --import ./web/node_modules/tsx/dist/loader.mjs --conditions=development rust/crates/pp-storage/tests/fixtures/working-draft-recompute-node.mjs web/apps/server > /persist/tmp/recompute-first.jsonl
node --import ./web/node_modules/tsx/dist/loader.mjs --conditions=development rust/crates/pp-storage/tests/fixtures/working-draft-recompute-node.mjs web/apps/server > /persist/tmp/recompute-second.jsonl
cmp /persist/tmp/recompute-first.jsonl /persist/tmp/recompute-second.jsonl
cmp /persist/tmp/recompute-first.jsonl rust/crates/pp-storage/tests/fixtures/working-draft-recompute-node.jsonl
cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild --test working_draft_recompute --test-threads=2
python3 rust/crates/pp-storage/tests/fixtures/mutate-working-draft-recompute.py
```

The mutation runner copies the workspace into `/persist/tmp` with its own target
directory. Only an executed failing test counts as a kill.

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

### D8 naming error classification

GRE-601 classifies naming failures behind `pp-storage/desktop_rebuild` using
existing catalog requests. Invalid profiles submitted to `SaveNaming` or
`SaveGlobalNaming` return `CatalogFailure::Input` with the existing validation
message. `GetNaming` and `SaveNaming` return `CatalogFailure::NotFound` for
missing or foreign-tenant sources. Authentication still runs before source
lookup and profile validation.

`GetNaming` classifies errors projecting a stored override as
`CatalogFailure::InvalidStoredNaming`, retaining the original error as its cause.
Source lookup and global-setting reads happen outside that classification, so
SQL failures retain their original type. Invalid global settings still fall back
to defaults without repairing storage. `SaveNaming::UseDefaults` can replace a
corrupt source override while preserving unrelated metadata.

The catalog tests exercise validation, missing sources, corrupt stored overrides,
SQL abort rollback, normalization, digest equivalence, global fallback, tenant
isolation and persistence after restart. Default-build error text and naming
behavior stay unchanged. This unit adds no user-visible caller. Future callers
must also check `PP_DESKTOP_REBUILD`.

The remaining reference `catalog/tests.rs` cases need APIs absent from main:
issued-token retirement and incarnation proofs, repeated local-scan completion,
captured-claim activation, orphan-source-work reaping, and pending/resolved lease
release across expiry and cancellation. Those tests depend on the matching
source-work state and job capture/settlement APIs. Port them with those owners
when the APIs land; do not emulate them in D8 or start GRE-602/D9 here. GRE-601
remains In Progress until its final slice.

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

Writer admission keeps that descriptor through OS-lock acquisition and opens `printpartner.lock` relative to it before database preflight. After taking that lock, Rust reserves `.desktop-lease` with a regular file to exclude standalone Node. An existing Node lease directory refuses admission without owner-marker inspection or recovery. Rust rechecks directory identity and permissions before and after locking. An observed replacement fails with `Data directory was replaced`. A lock created during a replacement race belongs to the admitted directory; refusal closes the lock without path-based cleanup.

The standalone Rust writer acquires `printpartner.lock` before its first read-only database preflight and retains the same admitted directory descriptor through storage ownership. It rechecks identity and permissions immediately before preflight, refusing an observed replacement before database capture, temporary-copy creation or SQLite open. It checks resolved ancestor permissions before each lock acquisition. `PP_STORAGE_CORE_LOCK=1` tells the supervised Node child to validate its inherited descriptor against `printpartner.lock`. The standalone Node lease protocol remains unchanged. See [Storage](storage.md) for shutdown, crash recovery, and unsupported directory operations.

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
the feature, and the D16 jobs engine stores and revalidates them (see below).

### D15 jobs model and subscriptions

GRE-611 adds the reference job model behind `desktop_rebuild`. `CompletedResult` holds
each job kind's public result. A job document can carry `public_result`, and a checklist
export effect can carry a completion claim. Decoding checks each claim against the
payload, effect intent, tenant binding, accepted Plan basis and, once the job succeeds,
its confirmed receipt and public result. Empty fields are omitted, so existing documents
encode unchanged. Two deliberate differences from the reference follow Node: basis
identifiers must be positive safe integers, and the `extract-source-docs` result stores
an error count.

The job stream registry starts each stream with its job's snapshot and queues newer
committed versions for the same tenant and job. A stream closes when the job finishes,
its 16-frame mailbox overflows, its credential expires or is revoked, or the owner stops.
At most 128 streams are live. The snapshot changes that expose `public_result` landed
with D16 (b); the engine and auth revalidation calls landed with D16 (c).

`fixtures/parity/jobs-model/generate.mjs` records Node's parsed accepted-plate and
direct-3mf results and its verdict on accepted-basis seals. Node builds its other job
results inside `InProcessJobRunner`, which built-in type stripping cannot load, so Rust
tests check those shapes as literals. The generator imports zod:

```sh
npm --prefix web ci --ignore-scripts
node fixtures/parity/jobs-model/generate.mjs --check
cargo test --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild --lib jobs::
cargo test --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild --test jobs_model_parity
```

### D16 jobs engine: enqueue and claim

GRE-609's first PR wires original authority into the job engine behind
`desktop_rebuild`. With the feature off, the engine is unchanged. No runtime caller
uses it yet; future callers must also check `PP_DESKTOP_REBUILD`.

Enqueue records who asked. A session or routed-key job stores a sealed reference to
that credential as `_authority`: the session digest or key id and hash, the admitted
tenant and subject, and the policy. The raw secret is never stored. A physical-owner
job stores `_authority: null`. Documents written before this change have no
`_authority` field. They stay that way and are never upgraded.

Claims check that authority. `WriterOwner::job_worker_with_policy(policy, admission)`
returns a worker that revalidates each job's original credential under `policy`.
A revoked or expired credential, a changed policy, tenant or subject, or a missing
legacy authority fails the job with `_authority_refusal` (reason, phase `claim`,
time and generation). The refusal commits and the claim continues with the next job,
so a refused entry never blocks healthy work. A plain `job_worker` claims
physical-owner jobs. When it reaches a job with an original credential, it returns
`AuthorityFailure::PolicyRequired` after committing the refusals and expiry
recovery already done in that transaction. `claim_kind(kind)` claims only one
admitted kind. `authorize(lease)` returns the live attempt's revalidated tenant and
subject without changing the job. A queued job's snapshot reports progress `0`, and
another tenant's read returns `JobAccessFailure::NotFound`.

Claims reserve individual Sources with D16 (d), described below. Upload, local scan
and Source Sync paths arrive with D14, D17 and D18.

`fixtures/parity/jobs-engine/generate.mjs` starts jobs in Node's
`InProcessJobRunner` under web's tsx loader and records the enqueued snapshot and the
other-tenant read. The durable engine's queued message, "Waiting for a compatible
worker", deliberately differs from Node's "Queued". Node keeps no queue across restarts
and never revalidates the enqueuing credential, so the claim tests follow the reference
engine's `job_authority_recovery.rs`:

```sh
npm --prefix web ci --ignore-scripts
node fixtures/parity/jobs-engine/generate.mjs --check
cargo test --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild --test jobs_engine_parity --test job_authority_claims
```

### D16 jobs engine: recovery and public results

GRE-609's second PR revalidates authority on every worker operation, behind
`desktop_rebuild`. Heartbeat, progress, effect admission, effect confirmation, finish
and fail all check the attempt's original credential first, under the worker's policy.
A refusal records `_authority_refusal` with phase `worker_advance`, fences the
attempt, commits, and then returns the typed `AuthorityFailure`. An attempt with no
effects fails. An attempt with effects waits for reconciliation. Physical-owner
attempts are not checked, and an attempt whose document lost its `_authority` is
refused as a missing original.

A refused `ConfirmEffect` whose receipt matches the admitted effect keeps that
receipt as observed evidence. The effect stays unconfirmed, and a document may hold an
observed receipt only while the job is waiting for reconciliation after a refusal. A
receipt that does not match is rejected and nothing is written. Reconciliation can
confirm the observed receipt only with the same receipt. It cannot deny the effect, and
an observed receipt never proves an uploaded-only print or a resolved printer failure.
`ConfirmSucceeded` reconciliation and `Finish` refuse jobs that carry a checklist
completion claim, which only the checklist finalizer settles.

`WorkerOperation::FinishPublic { artifact, result }` finishes like `Finish` and stores
`result` as the job's `public_result`. The result kind must match the job's kind.
Snapshots now report `public_result` as `result`, never the internal receipt, and add
`created_at`. `AtomicJobClient::read_public` returns one snapshot.
`AtomicJobClient::list_retained` returns the tenant's retained snapshots with Node's
filters (`LegacyListFilter`: status, `since` in milliseconds against finish time or
else update time, and profile) and Node's newest-first order. Ties keep enqueue order.
Quarantined and unreadable rows are skipped. Turning HTTP query strings into
`LegacyListFilter` belongs to D25.

`fixtures/parity/jobs-engine/generate.mjs` now also runs Node jobs to the end and
records the finished snapshot and `listJobs` under each filter. The Rust test finishes
the update check with Node's literal result and asserts the public read and each list.
Stored times have whole-second precision, so the test waits one second between the two
finishes. Node's snapshots have no `created_at`. The worker-advance and
observed-evidence tests port the reference `job_authority_recovery.rs`, because Node
never revalidates a running job:

```sh
node fixtures/parity/jobs-engine/generate.mjs --check
cargo test --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild --test jobs_engine_parity --test job_authority_claims
cargo test --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild --lib jobs::
```

### D16 jobs engine: streams, shutdown and Source work

GRE-609's third PR wires the D15 stream registry into the engine and gives the catalog
the Source-work state that later slices settle, behind `desktop_rebuild`. With the
feature off, the engine and catalog behave as before.

`AtomicJobClient::subscribe(credential, job_id)` resolves the credential, reads the
tenant's job and, once that transaction commits, opens a stream that starts with the
job's snapshot. Another tenant's job returns `JobAccessFailure::NotFound`. Every job
save inside a jobs transaction is collected, and the last committed version of each
job is published after the commit. If the commit outcome is unknown, every live stream
closes. Each auth write, through either `auth_with_policy` or
`rebuild_auth_with_policy`, runs under the registry's admission gate and then
revalidates every live stream. A stream whose credential no longer resolves to the
same tenant and subject closes as revoked before it can deliver a queued frame. If
revalidation itself fails, every stream closes. `WriterOwner` shutdown stops the
registry first: live streams close as `OwnerStopped`, and a subscription that commits
during shutdown returns `JobAccessFailure::Stopped`.

The catalog's Source-work state now has a random incarnation and an issued high-water
mark, and each lease carries a `SourceWorkProof` (incarnation and token). A second
lease on a Source that already has live work fails with `SourceBusy`. A lease that is
dropped while the writer queue is full is recorded as orphaned, and the writer frees
its Source before the next envelope. `classify_issued` and `retire_issued` tell
active, retired, never-issued and other-incarnation tokens apart; D17 and D18 call
them when a scan or Sync settles its reservation. D16 (d) adds claim-time Source
reservation, described below.

`fixtures/parity/jobs-engine/generate.mjs` now also records the events a tenant
listener receives while each Node job runs. The Rust test subscribes before the claim
and asserts that the stream ends with Node's events. Node's running event says
"Running…" where the durable model says "Running". On failure, Node reports progress
100 and the handler's error, and the durable worker keeps the last progress and
reports "Job failed". Node never revalidates a listener, so the stream authority and
shutdown tests port the reference `job_transport.rs`:

```sh
node fixtures/parity/jobs-engine/generate.mjs --check
cargo test --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild --test jobs_engine_parity --test job_transport
cargo test --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild --lib catalog::
```

### D16 jobs engine: claim-time Source reservation

GRE-609's fourth PR reserves an individual Source when a worker claims its job,
behind `desktop_rebuild`. `claim`, `claim_kind`, `claim_import`, and
`PendingClaim::receive` return `ClaimedAttempt` with the job, attempt lease, and
optional Source-work lease.
The default build keeps the existing tuple return and behavior.

`source_binding` maps ImportScan, ExtractSourceDocs, and SuppliedSourceImport to
their stored Source, including targeted import claims and cancelled import cleanup
claims past the attempt limit.
A missing Source, including a Source in another tenant, fails the queued job with
"Source is unavailable for this job" and a `source_unavailable` history entry.
The claim does not increment attempt or generation. Untargeted claims continue to
healthy work, while `claim_import` returns `None` after failing the targeted job.
A busy Source leaves the queued job unchanged. `claim_import` returns `SourceBusy`
so its caller can retry, while untargeted claims skip the busy Source.

`ClaimPlan` carries a pending `SourceReservation` through the database commit.
Only `TransactionDecision::Claimed` activates its token and creates the Source-work
lease after commit. The lease remains live after cancellation or attempt expiry
until its holder releases or drops it. An abandoned claim reply drops its lease.
The existing orphan queue handles releases that cannot enter the writer queue.

CheckSourceUpdates claims have no initial Source-work lease. Their workers acquire
individual leases through `begin_source_work`. D18 (a) replaced Sync's scoped
Source bridge: Sync reserves each target's Source when it claims the target, and
`begin_source_work` refuses a Sync attempt. Import settlement belongs to
D14 (d), local scan settlement to D17, and Sync settlement to D18. Claim-time
import reservation and targeted `SourceBusy` errors follow the reference
`source_binding`, `claim`, and `claim_import` in
`desktop/source-sync-local-current-20261008` at `d73b6d8d`,
`rust/crates/pp-storage/src/jobs.rs:2431`, `:2588`, and `:3372`.

Node has no durable claims or Source reservation counterpart. These tests port the
reference `durable_jobs.rs` reservation cases. The committed Node generator and its
literal-result parity tests remain unchanged. The test-only `claimed_attempt!`
pattern retains the Source-work lease while matching either build's return type.
`rust/scripts/migrate-claimed-attempt.py` reruns the mechanical tuple migration.

```sh
cargo test --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild --test durable_jobs --test supplied_imports
node fixtures/parity/jobs-engine/generate.mjs --check
```

### D14 uploads: supplied-import job arms

GRE-610's first PR adds the job kind the upload journal will own, behind
`desktop_rebuild`. With the feature off, the engine is unchanged. The journal, its
schema arrives in D14 (b), and the journal and capture paths in (c) to (e).

`JobKind::SuppliedSourceImport` carries `Payload::SuppliedSourceImport { project_id,
operation_key, input_version }` and reserves `source:{project_id}`. Only the upload
journal enqueues it: `AtomicJobClient::submit` refuses the payload with "Supplied
imports require atomic domain admission". The public job API never shows one. A public
read or stream of an import returns `JobAccessFailure::NotFound`, the retained list
skips it, and its saves are never published to a stream. The internal `Get` still
reads it.

`ServerWorkerClient::claim_import(job_id)` claims that queued import and no other job.
If its original authority is refused, the refusal commits with phase `targeted_claim`
and the typed `AuthorityFailure` is returned, instead of moving on to the next job. An
import attempt advances only by heartbeat and progress; the journal owns its other
phases. Cancelling an import, or recovering a cancelled one after a restart, returns it
to the queue with `cancel_requested` set, so its owner can reclaim it and release its
input. As a deliberate difference from the reference, the 100-attempt limit does not
apply to these cleanup claims, and recovery never fails a cancelled import for its
attempt count; other import attempts and other job kinds keep the limit.

Node has no supplied-import kind. `fixtures/parity/jobs-engine/generate.mjs` records
that Node refuses to start one ("Unsupported job kind: supplied-source-import") and that
a job it never started cannot be read, streamed or listed. The Rust parity test asserts
that a durable import looks the same to its own tenant. The claim, advance and
cancellation cases port the reference engine:

```sh
node fixtures/parity/jobs-engine/generate.mjs --check
cargo test --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild --test jobs_engine_parity --test supplied_imports --test job_authority_claims
cargo test --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild --lib jobs::subscriptions::
```

### D14 uploads: import, Source revision and preclaim schema

GRE-610's second PR installs the upload journal's tables behind `desktop_rebuild`,
with no callers until D14 (c). The SQL is the reference's
`uploads/schema.sql`, `remote_sources/schema.sql` and
`remote_sources/preclaim39.sql`, unchanged. The reference's provenance columns move
from Rust into `remote_sources/columns38.sql`.

Main keeps the reference's numbering, so D17's Source scan can stay at 40:

| Step | Installs |
| --- | --- |
| 37 to 38 | the provenance columns on `projects`, `source_revisions` and `source_docs`, `source_import_operations`, `source_import_quota`, and the Source revision attempt, artifact and observation journal with its immutability triggers |
| 38 to 39 | `source_preclaim_refusals` and its cursor triggers |

The reference installed the import tables at 36. Main never used 36, so they arrive
with the 38 step and the validator threshold moved from 36 to 38. A database at 36
holding them is refused. Columns that already exist are kept, as in the reference,
and the validator then checks their definitions.

Opening a database below 39 runs in this order:

1. Back up the database as opened, before any write.
2. Restore missing common tables and objects and repair tenant mismatches. This
   pass seeds nothing.
3. Install each pending step.
4. Seed the starter profiles.

Repairs run before the steps because the 38 step's provenance triggers refuse the
repair's writes to `source_revisions`. Each step writes `backups/pre-schema{N}.db`,
where N is the step's target version, validates its objects and columns, and then
commits them with its version stamp in one transaction. For a database at 37 the
first backup, `pre-schema38.db`, is the untouched input. `pre-schema39.db` is taken
after step 2, so it can include that pass's repairs. An
interrupted step leaves its input version intact, so each attempt takes a fresh copy
rather than reusing an existing file. The legacy upgrade to 37 (35 without the
feature) still reuses an existing backup, because its earlier migrations do not
commit atomically. Upgrading from 35 therefore writes `pre-schema37.db`,
`pre-schema38.db` and `pre-schema39.db`, and `SchemaReady.backup` names the first. A
failed backup stops the upgrade before the step writes. Backups of a WAL database no
longer leave the temporary copy's `-wal` and `-shm` files behind.

Opening checks the installed objects against the SQL text for the stored version,
and refuses objects from a later step. It also refuses an orphaned quota row,
partial revision or document provenance, an invalid observation, an invalid preclaim
refusal, and a cursor shared by a refusal and an observation. D14 (c) adds the checks
of the journal documents against their durable jobs. Without the feature, storage
stays at schema 35 and refuses a schema-39 database.

Node's schema stops at 34 and has none of these tables, so there is no Node literal
to match. The parity target is the reference SQL. The Node schema-parity tests
compare Node's catalog with Rust's after omitting these objects and columns, the
same way they omit the Plan Apply admissions. The upgrade tests run the real owner
from 35, 37 and 38:

```sh
cargo test --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild --lib -- uploads:: tests::ticket_t_7_migrations
```

### D14 uploads: upload journal and admission

GRE-610's third PR adds the upload journal and admits supplied files and zips into
it, behind `desktop_rebuild`. Nothing claims or runs an admitted import yet; the
import phases arrive in D14 (d) and captured inputs in D14 (e).

`WriterOwner::imports(policy, quota)` returns an `ImportClient` for the owner's import
quota, at most 64 GiB. Every client of one owner must name the same quota.
`ImportClient::admit` takes a credential, an `Admission` (operation key, an existing
Source or one to create, `Input::Files` or `Input::Zip`, the reserved bytes and the
input and prepared limits), the expected input files, the bytes already on disk, and
the `accounting_epoch` read before measuring them. In one writer transaction it:

1. refuses a stale epoch ("Import accounting changed; retry admission");
2. checks the key, each file's relative path and digest, duplicates, at most 10,000
   files and the input limit;
3. returns the prior operation for a replay of the same request by the same actor,
   and refuses any other reuse of the key ("Import idempotency conflict");
4. checks the target, the limits (input at most 256 MiB, prepared at most 1 GiB, and a
   reservation of at least input + 3 × prepared + 16 MiB, within the quota), and that
   the bytes on disk plus every unsettled reservation plus this one fit the quota
   ("Owner import quota exceeded");
5. creates the Source if asked, enqueues the internal `SuppliedSourceImport` job with the
   admitting authority, and writes the journal entry and its reservation.

The entry is validated before it is written, so an entry whose input paths differ from
its files, or whose files are not of kind `input`, is refused rather than committed.
The reference wrote such an entry, and every later read of its key failed.
`ImportClient::get` returns an entry to the actor that admitted it. Each successful
admission advances the epoch.

Opening storage now checks each journal entry: its columns against its document, the
document's state and bindings, its job (live or archived) against its Source, key and
input version, a settled entry against a terminal job, and its quota row against its
reservation and retained bytes.

Node writes supplied files with `writeUploadedFiles` and has no journal, quota or
idempotency. `fixtures/parity/uploads/generate.mjs` records its limits and its results
for ten file sets. The journal matches Node's 256 MiB and 10,000-file limits and its
refusal of empty, oversized, escaping and duplicate inputs. It differs on purpose for
three: Node rewrites backslashes and a leading slash, and folds case when it looks for
duplicates. The journal stores exact canonical paths, so it refuses the first two and
admits names that differ only in case. The quota, idempotency, startup and codec cases
port the reference `source_import_codec.rs` and its serializer fixture:

```sh
node fixtures/parity/uploads/generate.mjs --check
cargo test --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild --test upload_journal
```

## D9 build graph receipt

GRE-602 adds the read-only first half of `pp_storage::build_graph` behind
`desktop_rebuild`. Authenticated `List`, `Read`, and `ListLayers` commands run
through the existing writer queue and return typed summaries and ordered layers.
`List` rejects more than 64 builds, shares one graph budget across summaries,
and checks cancellation between builds.
`ListLayers` caps results at 1,024 layers and checks cancellation during iteration.
Summary facts reuse the accepted graph reader and freshness calculation.
Corrupt freshness inputs return explicit unavailable freshness and integrity
progress for that build while retaining healthy builds in lists.
Summaries validate PPJS metadata losslessly. Existing scalar snapshot projections
report `manifest_text` integrity failures for non-scalar metadata; lossless public
snapshot serialization remains deferred.

GRE-602 also adds `Create`, `Touch`, `SetBase`, `AttachAddon`,
`ReplaceAttachment`, `Detach`, and `Delete` through the same authenticated queue.
Mutations use deadline-aware writer admission and immediate transactions. Typed outcomes distinguish missing builds,
sources, and layers from duplicate names and attachments. Names reuse the gated
`pp-domain::build_identity::BuildName`, also reexported by `pp-contracts`
through `pp-api-types`; IDs use `pp_domain::PositiveId`.
Create and Touch return boxed summaries. Attachment changes mark
`config_modified_at`, and returned layers retain the 1,024-layer cap. Delete
removes tenant-scoped production, filament, and plan feature settings and defers foreign keys
so accepted graph references can cascade together. Errors, cancellation, and
budget exhaustion roll back the transaction.

With `desktop_rebuild`, graph reads report `Failure::BudgetExhausted` separately
from stored integrity failures. `BudgetResource` identifies the shared
200,000-row or 64 MiB batch budget, or the 1,000,000 Plate overlap comparison cap.
The 64 KiB stored-row text cap remains an integrity check. Accepted reads also
propagate resource exhaustion instead of embedding it in context errors. The
feature-off reader retains its existing error classification.

D9 is complete with the [final coverage and integration audit](desktop-rebuild-d9-audit.md).
Required-unit planning integration belongs to GRE-606 D11. Manifest option observation is
GRE-604 D10b, described below.
No runtime caller is added. Future user-visible callers must also check
`PP_DESKTOP_REBUILD` for exactly `1` or `true`.

## D10a manifest model receipt

GRE-604 D10a adds `pp_storage::manifest_options::KitManifest` behind `desktop_rebuild`.
The pure model parses request and stored JSON, normalizes selection variant IDs,
projects typed selections, and emits JavaScript-compatible JSON with UTF-16 text
and ordered objects. Input errors emit lossless JSON detail bodies.
The codec enforces 8 MiB, 64 levels, and 100,000 nodes.
Focused codec unit tests and public model integration tests run in the desktop gates.

## D10b manifest observation receipt

GRE-604 D10b adds `pp_storage::manifest_options::observation` behind `desktop_rebuild`.
GRE-644 slice 1 wires its build graph manifest commands, described below. HTTP routes remain deferred.

`capture` reads the build, its stored kit, and its ordered source layers in one transaction.
`basis_matches` repeats the capture, so a later transaction can reject a stale observation.
`observe` builds the response of Node's `buildPlanManifestBuilder` in
`web/apps/server/src/services/plan-manifest-builder.ts` through storage-issued `DraftReads` requests:

- It reads each checkout manifest and STL inventory. It filters paths with the source's import rules and sorts them as `listStlRelativePaths` does.
- A source without declared option groups infers groups from shipped and custom path hints, then from sibling folders.
- Groups merge in layer order and keep JavaScript property order. Each variant names the sources whose scanned parts it matches.
- Stored kit selections take precedence. Repository and community manifest defaults fill the other groups in layer order.

As in Node, an unreadable or invalid manifest reports `exists: false` with the fallback YAML.
Invalid UTF-8 decodes with replacement characters. An invalid or unreadable custom hints file fails the observation.
A source without a checkout path is skipped. A source whose checkout root the adapter refuses is omitted.

Adapter reads, manifest and hint parsing, and STL scans charge the caller's `PreparationBudget`.
The stored kit and each source's import rules charge their bytes as documents.
Both also charge every JSON node and its depth to the same budget. Import rules charge one rule per accepted path.
Import rules over the JSON byte, depth, or node limit refuse the observation.
Malformed or non-array import rules give an empty rule set, as in Node.
A malformed stored kit falls back to an empty kit, as in Node.
A stored kit over the JSON byte, depth, or node limit refuses the observation.
Path filtering and pattern matching check cancellation.
Each source returns a SHA-256 stamp of its reads, so a caller can compare two observations.
`validate_known_selections` returns the `manifestSelectionsInputError` messages for a kit save.

The tests compare the response bytes with `rust/crates/pp-storage/tests/fixtures/manifest-builder-node.json`.
`manifest-builder-node.mts` in the same directory regenerates that file from the Node services.
Builder globs normalize backslashes to slashes, lowercase both inputs, and trim
ECMAScript whitespace. They check normalized equality, then match the entire path.
A pattern without a slash also matches against the basename.
Only `*` and `?` are wildcards. They consume zero or more UTF-16 code units and
exactly one unit, respectively, excluding LF, CR, U+2028 and U+2029.
Slashes have no special wildcard restrictions. All regex punctuation is literal.
Literal comparison follows ECMAScript non-Unicode `/i` canonicalization after
lowercasing. Uppercase expansions and non-ASCII-to-ASCII uppercase mappings do
not fold. Lowercasing still maps Kelvin sign to `k` before comparison.
Lone surrogate pattern units are preserved, and `?` consumes half a supplementary character.

The matcher uses two indices and one saved `*` retry point instead of a regex.
It has O(path units × pattern units) worst-case work and O(path units + pattern
units) normalization storage. `BuilderGlob::new` normalizes a pattern once for
all paths. The matcher has no `PreparationBudget` parameter; the observation
checks cancellation before each path, so cancellation waits for at most one
path's match.
This resolves the backtracking and UTF-16 parity defects in GRE-642 and GRE-641.

Regenerate or verify the Node differential corpus with
`node rust/crates/pp-storage/tests/fixtures/manifest-globs-node.mjs` or append `--check`.
The generator reads the actual `matchKeyMatches` and `globToRegExp` functions.
Run the ignored `builder_glob_backtracking_probe` test in an exclusive landing slot
with `--release -- --ignored --nocapture` to check the 10 ms release bound.

```sh
cargo test --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild --lib manifest_options
```

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

GRE-353 adds an offline copy command for legacy mutable Plans, accepted Plan/Source history, and supported exports. Stop the source server and desktop first. The command reserves the source with `acquireDataDirectory`, reads its current SQLite snapshot including committed WAL data, and leaves its product database and files unchanged. Ownership lease records can change during reservation and release.

Run this command on Linux with Python 3 available. Publication uses libc `renameat2` with `RENAME_NOREPLACE`. The destination must be new, its parent must already exist, and it must not overlap the source. Existing files, directories, empty directories, and symlinks at the destination all cause refusal. The tool builds a private staging directory beside the destination and publishes the complete copy atomically. Caught errors remove staging and publish nothing. Abrupt termination can leave a private `.ownership-copy-*` directory. Power-loss durability is not guaranteed.

From `web/apps/server`, inspect the stopped source with the exact runtime gate enabled:

```sh
PP_DESKTOP_REBUILD=1 npx tsx --conditions=development src/ownership-migration-cli.ts inspect /absolute/source > inventory.json
```

The inventory contains a deterministic full-database `source_digest`, table names, row identifiers, claim placeholders, and an `exports` list of artifact paths, SHA-256 digests, Plan IDs, and current tenant IDs. It contains no credentials, settings values, or document contents. Review every row identifier against your source data. Create a separate manifest with this shape:

```json
{
  "version": 1,
  "source_digest": "COPY_THE_64_CHARACTER_DIGEST_FROM_INVENTORY",
  "selected_user_id": "account-a",
  "claims": [
    { "table": "build_profiles", "rowid": 1, "user_id": "account-a" },
    { "table": "build_profiles", "rowid": 2, "user_id": "account-b" }
  ],
  "exports": [
    {
      "path": "tenant-default/profile-1-Plan/checklist/checklist-CONTENT_SHA256.html",
      "sha256": "COPY_THE_ARTIFACT_DIGEST_FROM_INVENTORY",
      "profile_id": 1,
      "user_id": "account-a"
    }
  ]
}
```

Include exactly one claim for every inventory row, including independent rows assigned to other users. Each owner and the selected user must already exist in `users` and must differ from `default`. The selected user identifies the desktop account to open. Claims can distribute unrelated Plans among multiple existing accounts. The tool does not infer ownership, clone shared dependencies, or change IDs. A Plan, its Source relationships, parts, and progress must have consistent owners. Conflicting assignments, dangling references, missing or extra claims, duplicate claims, and destination uniqueness collisions cause refusal. Machine and filament profile references from unchanged foreign assignment rows must also resolve to the same owner.

Apply the reviewed manifest to a new destination:

```sh
PP_DESKTOP_REBUILD=1 npx tsx --conditions=development src/ownership-migration-cli.ts apply /absolute/source /absolute/new-desktop /absolute/manifest.json
```

The copy contains a private `desktop-account.json` v1 mapping with `user_id` and `tenant_id` equal to `selected_user_id`. Existing desktop admission rules still apply. Rows outside the default tenant retain their content and owners. Stored `projects.local_path` values under each Source's own repository tree are rebased to the destination, including foreign rows, so the copy never depends on the original directory. The global `default` `app_settings.schema_version` stays at `default`. The tool compares every staged table against the expected source rows before committing so trigger side effects cannot silently change unrelated data.

The copy supports default rows in `build_profiles`, `projects`, `profile_layers`, `parts`, `print_progress`, `source_docs`, `source_notes`, `plan_decisions`, `printer_profiles`, `process_profiles`, and `filament_profiles`, plus `source_revisions`, `plan_revision_input_sets`, `plan_revision_inputs`, `plan_accepted_input_sets`, `plan_revisions`, `plan_revision_parts`, `required_units`, `plan_revision_required_units`, `plan_revision_required_unit_sets`, `accepted_plate_revisions`, `accepted_plate_heads`, `accepted_plates`, and `accepted_plate_units`. Every supported default row needs its own explicit claim. It discovers tenant tables from SQLite rather than assuming this list covers the schema. Any populated default tenant table outside that list causes refusal, except the global schema version. Bundled starter printer, process, and filament profiles are supported and require explicit claims. Their scalar fields and resolved configuration JSON retain their original bytes. Imported or externally backed profiles cause refusal when `source_path`, `raw_json`, `raw_ini`, or `compatible_printers` is nonempty. This is not a whole-application ownership migration. Do not remove product data merely to bypass refusal.

The tool refuses default settings other than `schema_version`, drafts, printer queues, opaque project metadata and imported-path lists, nonempty decision parameters other than `{}`, and populated decision result JSON. It also refuses stored sessions, password reset tokens, and Plan share capabilities. Share bundles contain ownership references outside the supported row graph. No startup path or HTTP endpoint invokes it.

Filesystem support covers regular files in `repos/<project id>` and `sources/<project id>` for known projects. Symlinks and special files cause refusal. A nonempty `projects.local_path` must be an absolute path inside `repos/<its project id>`; external paths are refused. Every Source revision must have a safe `<its project id>/revisions/...` locator and an existing regular snapshot tree. Relative part and document paths must contain no parent segments, empty segments, backslashes, or external locators. Unknown top-level artifacts and native storage cause refusal. Standard `uploads`, `upload-staging`, `staging`, `backups`, `thumbnails`, `previews`, `thumbs`, and `covers` directories are accepted only when empty. Exports support the existing `profile-<Plan id>-<slug>/checklist/checklist-<sha256>.html`, `profile-<Plan id>-<slug>/direct-3mf/direct-<16 hex digest>.3mf`, and `profile-<Plan id>-<slug>/kit/<slug>-<timestamp>-<sha256>.print-partner-kit.zip` layouts. Files can be directly under `exports` for legacy default data or under the existing tenant directory. Each file needs an `exports` manifest claim with its exact path, digest, Plan ID and named owner. The owner must agree with the Plan's explicit row claim or existing tenant; foreign exports cannot be reassigned. Omitting `exports` remains valid when no export files exist. Unmapped files, wrong scopes, unsupported layouts and target collisions fail closed. Default exports move into `tenantExportDirectory` for their mapped owner; foreign exports keep their tenant scope. There is no copied `tenant-default` fallback. The tool preserves bytes and validates content-addressed filenames, without rewriting embedded export content. Accepted STL and Plate export trees, older export layouts and temporary publications remain unsupported. Ownership markers, leases, `.desktop.lock`, `printpartner.lock`, and the source desktop mapping are excluded from the copy. Socket files outside those excluded ownership paths cause refusal.

The staged copy suspends ten known triggers inside its transaction after checking their definitions against the current migrations. These cover Part acceptance invalidation, immutable updates for Plan revisions, Plan revision Parts, Required units, Required-unit maps and map headers, plus immutable updates for Plate revisions, Plates and Plate units and Plate head ownership updates. It restores them before validation and verifies that the complete schema matches the source. All historical revision and input digests, existing Required-unit maps and owner relationships are checked. Every supported history row must fit the production operational limit of 64 KiB across its stored text columns, measured as UTF-8 bytes in SQLite. Builds with accepted history also receive the operational text budget check for their tenant ID, name, order number, special request and archive timestamp. Ordinary mutable Builds without accepted history retain their existing supported text values. These limits are checked again after owner reassignment in staging. Current revisions require complete Required-unit maps. Retained older revisions may lack maps only when no partial mapping or created-unit state exists. Current accepted Plans must pass the production operational reader and tracked Part byte verification in both source and stage. Valid format-1 input history retains its existing `uninitialized` operational result; it is not promoted to format 2. Plans whose working Part edits or deletions cleared the accepted revision pointer are also supported when their positive Plan version and validated history remain. The retained revision numbers must form the complete sequence from 1 through the Plan version, with each revision after the first pointing to its immediate predecessor and retaining tracked publication provenance with format-2 inputs. The inferred current revision must have a complete Required-unit map, positive unique projection IDs, valid stored Part booleans and consistent quantities between 1 and 10,000. Retained progress at inferred-current Part/unit coordinates must pass the production raw-boolean and assembly/completion checks. Other historical unit coordinates retain their existing ignored status. Historical projection IDs may refer to deleted working Parts for these dirty Plans; any surviving projection must still belong to the same Plan and owner. Their retained accepted-input pointer must match the latest historical revision, including its acceptance timestamp; legacy revisions must have no input pointer. The copy preserves their null pointer, working edits and `compatibility_dirty` operational result across restart. It does not select a historical revision or repair acceptance. A zero version with history or a positive version without history causes refusal. IDs, digests, tokens, actor identities and timestamps are preserved.

Accepted Plate database state is supported independently of export trees. Every retained Plate revision must have a valid historical Plan basis, a complete historical Required-unit map, and a valid layout digest, geometry, counts and associations. Raw placement values, pinned booleans and historical Part inclusion booleans must be valid. Plate revision numbers for each tenant and Build must be the complete sequence from 1 through the maximum retained number. An existing head must target that maximum revision. Headless history and stale Plan bases remain supported. Nonnull undo provenance must target the immediate predecessor on the same Plan basis. Null undo provenance remains valid. Source and staging must return equal results through the production Plate reader before publication. Tests verify supported Plate history through two reopens of both source and destination.

Plate admission also caps each history validation pass at 1,000,000 potential overlap comparisons across all retained revisions and owners. A Plate with `n` placed units charges `n * (n - 1)`, reserving both the legacy and current layout validation attempts even when the legacy digest matches. Unplaced units charge zero because neither attempt compares them for overlap. They still undergo the existing layout and history validation. The preflight scans stored unit identities and placement before full row materialization or layout reads. It stops at the first unit that pushes the cumulative charge above the limit and raises `OwnershipPlateComparisonBudgetError` with numeric `limit` and `charged` fields. The charge is a conservative bound, not a measurement of comparisons performed. There is no CLI or environment override.

Inspect runs one history validation pass and one set of production head reads, for at most 2,000,000 overlap comparisons. Apply runs three history validation passes, on the source, the source with owner claims, and the staged copy. It also reads production heads once on the source and once on the stage, for at most 5,000,000 overlap comparisons. Each head set is a subset of the validated history, so each contributes at most one additional history budget. These bounds cover the pairwise overlap loops, not total runtime, memory, row counts or other validation work. An oversized source fails before staging. A refusal leaves no published destination, removes any private stage and preserves source product bytes. Keep the source intact if it exceeds this limit; the ownership copy does not prune history or raise the budget.

The source digest is rechecked after reservation, after the SQLite backup and before publication. Product file hashes and export inventory are rechecked after copying. Any database change requires a new inventory and reviewed manifest. The command exits with status 1 on refusal and status 0 with a JSON receipt on success. Both inspect and apply require `PP_DESKTOP_REBUILD` to be exactly `1` or `true`.

## GRE-644 manifest commands, slice 1

`build_graph::ManifestOptionsCommand` adds `ReadKit`, `SaveKit`, and
`ReadBuilder` through `BuildCommand::Manifest`, behind `desktop_rebuild`.
`BuildOutcome::Manifest` returns typed outcomes. Use `into_success_body()` for
lossless JSON bytes, including UTF-16 selection IDs.

`WriterOwner::build_graph_with_observations` accepts the existing `DraftReads`
adapter and `PreparationLimits`. Capture authenticates and reads the graph in
a reader transaction, then releases that reader before adapter calls. Two
observations share one preparation budget and must have equal source stamps.
The queued command authenticates again and checks `basis_matches` inside its
immediate write transaction. Save validates selections in that transaction,
then writes the kit setting and configuration timestamp together. Cancellation
before commit rolls both back. Save refuses stale inputs without retrying;
builder reads retry once. Kit reads need no filesystem adapter.

This adapts the reference's command location to main's separate
`manifest_options` model. The builder outcome holds serialized bytes because
main keeps its builder model internal. Stored malformed kits read as empty,
missing Plans win over invalid save input, and omitted save fields reset to
empty defaults, as Node does. SQL read errors propagate instead of becoming
empty kits as in the reference.

Unlike the reference, selection validation runs inside the write transaction.
Unlike both Node and the reference, save rejects unknown group and variant IDs,
as required by this slice. D10b's validator continues to check cardinality;
the command adds unknown-ID checks without changing `observation.rs`.
Save observes attached checkouts even when selections are omitted, as the
reference does, so source failures and stale stamps still refuse that save.
Node only builds option groups when the update supplies selections.
Two observations share a budget instead of receiving separate budgets as in
the reference.

The public command tests cover Node response parity, save/read persistence,
stamp changes, database changes before writer admission, bounded builder retry,
unknown selections, cancellation, missing and foreign Plans, adapter failures,
and rollback when the freshness update fails. The Node fixture follows D10b's
JSON and generator pattern. Regenerate it from `web`:

```sh
npx tsx --conditions=development ../rust/crates/pp-storage/tests/fixtures/manifest-commands-node.mts apps/server > ../rust/crates/pp-storage/tests/fixtures/manifest-commands-node.json
```

No HTTP route or runtime caller is added. GRE-644 still needs its HTTP slice
with D25/GRE-620 build routes, including `PP_DESKTOP_REBUILD` admission.

## D11 required units (GRE-606)

`required_units` compiles only with `desktop_rebuild`. It has a model, readers,
and one write operation.

The model provides planning and selection digests, canonical decisions, exact
predecessor matching, required-unit assignments, conflicts, surplus tokens, and
selection basis rows. It keeps `DraftPart` manifest metadata separate from scalar
JSON. Planning hashes preserve UTF-16 ordering and lone surrogates in manifest
fields. Predecessor units are sorted by prior index before validation, as in Node.
Target, predecessor, token, and decision errors use Node's messages and order.

The readers verify stored data on every read, as Node's repository does:

- `storage::draft` loads a Plan draft and checks its snapshot digest. A selected
  reconciliation must exist for the same draft and be finalized, or the read
  fails with "Plan draft Required-unit selection is corrupt".
- `storage::saved` checks a finalized reconciliation's canonical JSON, digests,
  decision rows, and assignment rows.
- `storage::base` reads the accepted revision's Required-unit set and checks its
  coordinates, Object names, progress, orphan units, and mapping digest.
- `view::workspace` builds the draft workspace and its diff against the base
  revision. Diff rows sort by their serialized ID, as in Node.

Corrupt rows return Node's messages for the same checks, with two known gaps.
Selection basis rows share one message, "Required-unit selection basis is
invalid". Some malformed stored result JSON returns a different message than
Node, although both refuse the row. GRE-648 tracks both gaps.

The operation ports Node's `savePlanDraftRequiredUnitReconciliation` and the
`reconcile` path of `PlanDraftWorkspaceService`. Get a client with
`WriterOwner::required_units_with_policy`. `ReconciliationClient::reconcile`
queues one command on the single writer, as `build_graph` does. The writer runs
it in one immediate transaction. It checks cancellation before the transaction
starts and again before it commits, so a cancelled request writes nothing.

- `ReconciliationRequest` has the contract's snake-case fields. It rejects
  unknown fields, a snapshot digest that is not 64 lowercase hex characters,
  more than 10,000 decisions, and two decisions for the same draft Part.
- `ReconciliationCommand::new` trims the idempotency key as JavaScript `trim`
  does and requires 1 to 160 UTF-16 units, as the Node route does.
- A session records the user ID as the actor. An API key records `tenant:<id>`
  and updates the key's last use time.
- `Outcome` serializes with Node's `kind` values and workspace shape.
- A retry with the same actor, key, and payload returns the saved selection,
  including rows Node wrote. If the draft is still at the expected v1 digest
  with no selection, the retry selects the saved reconciliation again. A retry
  with a different payload returns `idempotency_conflict`.

The operation has no HTTP route. GRE-619 adds it. The local `Decision` and
request types exist because `pp-storage` has no dependency on `pp-contracts`.

Tests open Node-written databases in
`rust/crates/pp-storage/tests/fixtures/required-units/`. Each operation test
compares the outcome with the Node result in the matching JSON file, or with
literal digests from Node's service, and checks the stored rows. The
`required-unit-fixture` binary runs one request twice, with a restart between
runs, and prints both outcomes and the database before and after:

```sh
PP_RECONCILIATION_SESSION=required-unit-fixture-secret \
  cargo run --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild \
  --bin required-unit-fixture -- DIRECTORY PROFILE_ID DRAFT_ID IDEMPOTENCY_KEY REQUEST_JSON
```

Run the tests with:

```sh
cargo test --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild --lib required_units -- --test-threads=2
cargo test --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild --test required_unit_operations -- --test-threads=2
```

## D19 publication model and production links, GRE-612 PR 1

`pp-storage::plan_publication` is internal and requires `desktop_rebuild`.
The feature remains off by default. This slice ports publication assignments,
preparation, revision digests, accepted projection validation, production setting
validation, and Required-unit token remapping from the source-sync reference.
The optional `pp-contracts` dependency supplies `UnmappableLink`; the boundary
check rejects this dependency if it becomes required or reachable by default.

PR 2 adds the transaction entry described below. PR 3 adds `PublicationClient`,
authenticated admission, schema installation, and writer `Envelope` dispatch.
Temporary `expect(dead_code)` annotations now identify only PR 3 integration points.

`node fixtures/parity/plan-publication/generate.mjs` regenerates literal Node
results in `fixtures/parity/plan-publication/node.json`; `--check` detects drift.
It requires Node 22.18 or newer and `npm --prefix web ci --ignore-scripts`.
The module hooks transform TypeScript and select development package exports,
so the real database probe needs no server or package build.
The fixture header records the generating Node version. The generator imports
`preparePlanPublication`, `digestPlanRevisionParts`, `assessCheckoffRemap`, and
`requiredUnitObjectName`. It extracts and executes the repository's inline
accepted revision check, `projectionPlanningFieldsMatch`, and private
`applyCheckoffRemap` and `strictProductionState` methods with row and setting
adapters. It does not copy their implementations. The transaction cases below also import
the real repository and SQLite database layer.

Rust tests compare literal digests, progress, assignment coordinates, object
names, remap mappings, and persisted settings. Shared projection cases compare
acceptance and rejection. Production validation accepts Checkoff coordinates
owned by another profile, matching Node. Remapping treats an ownerless queue item
as related when any part belongs to the profile or no referenced parts still exist,
even when its state is `done`. Node's exact error messages are retained in the
fixture; tests separately assert the Rust reference's more specific diagnostics.
Node's inline projection check has no progress-validation counterpart. Both
implementations remap Checkoff and send-queue coordinates by Required-unit token
(GRE-677): a kept unit follows its token to its new index, and a dropped or
excluded unit refuses the remap. The Node transaction cases
`mapped-remap-index-change` and `mapped-remap-index-0` record this. Direct Rust
tests cover progress corruption, excluded or missing tokens, and changed indexes.


## D19 publication transaction and job conflicts, GRE-612 PR 2

`publish_in_transaction` mirrors Node `AppRepository.applyPlanChanges` and takes
an existing `&Transaction`. D13 save can call it inside its own transaction with
an authenticated tenant and actor, profile and draft IDs, admitted and execution
requests, an idempotency key, and a Required-unit token allocator. It returns a
publication `Outcome`. The caller commits success or rolls back errors.

The transaction verifies the accepted projection, selected reconciliation and
live selection basis before publishing immutable revisions, Parts, input sets,
Required-unit mappings, progress, accepted pointers, and a replayable receipt.
`plan_publication/schema.sql` supplies the admission table and immutability
triggers for PR 3's schema installation. PR 2 adds no startup migration or client.
The default build remains unchanged.

`jobs::publication_conflicts` and `printer_upload_conflicts` move here from D16
because publication must check execution jobs inside the same transaction.
Exports use their profile ID. Uploads and deferred starts also resolve Checkoff
coordinate ownership. All terminal jobs, including uploaded-only uploads, are
skipped. An active deferred start bound to an uploaded-only parent still blocks
publication and validates the parent upload binding. The supplied-source import
arm waits for GRE-610's payload variant.

The generator records fifteen real SQLite transactions covering receipt replay,
changed drafts, pinned Source inputs, reconciliation reasons, and Checkoff links,
resolved units, and ownerless queues. Rust restores each database on Node's
schema and compares literal outcomes and publication rows, normalizing only
publication time and receipt field casing.

Node `applyPlanChanges` does not check durable jobs, so its running-export case
publishes. Rust returns the exact job conflict list and leaves publication rows
unchanged. Both runtimes publish with a terminal uploaded-only upload.

Rust keeps Node's Checkoff remap refusal reasons for deleted Parts, missing match
keys, and indexes at or past the new quantity. After those checks, both runtimes
write coordinates by Required-unit token and refuse if the referenced token was
dropped or excluded (GRE-677).

This rule applies whenever a kept token's index changes. `Selection::PriorCompletion`
renumbers units with no quantity change. In the index-1 fixture both runtimes move
the coordinate to the kept token's new index. At index 0 both refuse the dropped
token and write nothing. Index 2 and a cross-Part filename rename refuse with
Node's quantity and match-key reasons. Fixtures record Node's literal outcomes,
and Rust compares them exactly.

## D19 publication client and writer admission, GRE-612 PR 3

With `desktop_rebuild`, `WriterOwner::publication` and
`publication_with_policy` construct a `PublicationClient`. `PublicationCommand`
trims keys with ECMAScript whitespace rules and admits 1 to 160 UTF-16 units.
`normalized_http` keeps the original admitted request separate from a request
normalized by a caller. The writer resolves the authenticated tenant and actor
inside the publication transaction. Request data cannot select either identity.

`PublicationClient::apply` uses the bounded writer queue. Before admission,
cancellation returns `required_units::AdmissionFailure::Cancelled`, a full queue
at its deadline returns `QueueFull`, and closed or poisoned admission returns
`Stopped`. After admission, the caller waits for the result even if cancelled;
a lost writer reply returns `OutcomeUnknown`. The writer uses its dequeue
transaction deadline and the shared bounded SQLite lock admission path. It
commits applied or replayed receipts and rolls back unsuccessful publication.
Its token allocator uses operating-system randomness.

The feature installs and validates the admission table and immutable triggers
at schema 37. Main never uses version 36: the reference's version 36 import
tables arrive with D14's version 38 step. Reopening checks schema text and
orphan admissions. Without the feature, storage remains at schema 35 and refuses
a newer database.

D13 save, GRE-608, can call `AuthenticatedPublicationContext::resolve` and
`publish_in_transaction` on its own transaction, using `PublicationRequests::new`
for admitted and execution requests. That caller owns commit or rollback. It
must not enqueue `PublicationClient::apply` while holding its transaction.
D13 integration remains GRE-608's caller work.

Eight literal fixtures run the actual Node Apply route and workspace service
against fresh SQLite databases. They cover missing, whitespace-only and
UTF-16-sized keys, embedded BOM preservation, identical replay receipts,
session actor attribution, tenant isolation and unexpected-error text. The
fixture supplies authenticated request context; authentication middleware
itself is covered by the auth tests. Rust compares these literals through its
client, queue and transaction executor with deterministic fixture tokens. A
separate owner test proves schema installation, random token generation,
writer dispatch, shutdown and replay after reopen.

GRE-665 item 1 applies because this public client can return errors. Invalid
keys now use Node's `Request is invalid`; unexpected publication errors use
Node's `Plan draft update failed`. The Node error fixture injects a SQLite
trigger failure through the real route. Internal transaction callers retain
the original diagnostic error. Authentication failures retain the auth module's
existing errors. Queue admission has no Node counterpart; direct Rust tests
check the supplied reference behavior, including cancellation after admission.

### D17 source scan: observation and settlement

D17 (a), GRE-613, ports `source_scan` document records, observations, and
settlement from `desktop/source-sync-local-current-20261008`. The
`desktop_rebuild` feature gates the module and the jobs commands
`ObserveLocalScan` and `SettleLocalScan`. Settlement rechecks the original
credential, Source reservation, configuration, activation, and path. It replaces
the document index and records a confirmed effect receipt in one transaction.
PDFs remain pending for extraction. Settlement does not finish the job or retire
its Source token. Callers must complete, reconcile, release or drop `source_work` promptly.

The three-PR slice plan assigns the complete D17 scope as follows:

| Slice | Work | Estimated added/changed lines |
| --- | --- | ---: |
| D17 (a) | Document types, observation/settlement, journal SQL, jobs commands/clients/outcomes, `classify_issued`/`proof` callers | 600 |
| D17 (a) | Settlement, authority and reservation tests; Node generator and golden; docs | 650–850 |
| D17 (b) | Complete, inspect, inspect-held and reconcile commands/clients/outcomes; both transaction decisions; `retire_issued`/`consume_retired` callers | 780 |
| D17 (b) | `revalidate_source_authority`, `commit_source_authority_refusal`, idempotent End/release, remaining reference catalog tests | 400–500 |
| D17 (c) | Schema 40, `backups/pre-schema40.db`, validation inside the migration transaction, migration tests and docs | 150–200 |

D14 (b), #553, supplies schema 39 and the Source configuration and document
provenance columns. D17 (c) installs the scan journal at schema 40 through the
production migration. The scan tests open `WriterOwner` and use that schema
without ad-hoc tables or column alterations. The default build stays at schema 35.
Source Sync remains D18, GRE-614.

`fixtures/parity/source-scan/generate.mjs` runs Node's
`services/source-docs-index.ts`, which calls `services/source-docs-scan.ts`.
Four cases cover empty input, markdown/PDF indexing, ignored directories and
Unicode paths. Rust tests assert the committed Node rows and counts. Node stores
24 hex characters of the content hash; the reference Rust journal uses full
SHA-256. The generator also records full Node crypto hashes for Rust input.
The probe sorts paths by JavaScript code units for the settlement contract and
records inventory/index digests from Node crypto. Durable settlement, Source
reservations and authority checks have no Node counterpart. The tests adapt the
observation/settlement portion of the reference catalog test
`repeated_local_scan_completion_adopts_the_exact_terminal_result` and its Source
lease lifetime checks. D17 (b) ports exact terminal-result adoption and release
acknowledgement. New tests exercise stale observations, revoked authority,
invalid documents and transaction rollback.

Regenerate or verify the Node results with:

```sh
node fixtures/parity/source-scan/generate.mjs
node fixtures/parity/source-scan/generate.mjs --check
```

D17 (b) adds `CompleteLocalScan`, `InspectLocalScan`, `InspectHeldLocalScan` and
`ReconcileLocalScan`. Completion commits the public result and journal digest
before retiring the Source token. A repeated completion adopts only the exact
terminal request and result. Held inspection recovers settlement evidence after
a lost reply. Reconciliation retains the effects and records the failure before
retiring the reservation. Release acknowledges already retired tokens and keeps
the proof if acknowledgement fails.

GRE-703 items 2–4 bind settlement to the journaled reservation incarnation and
token, test retired proofs and cancellation after observation, and replace the
raw UNIQUE error with `LocalScanFailure::AlreadyObserved`. D17 (c) addresses
GRE-703 item 1 by moving the test harness onto the real migration. It also removes
the client schema prerequisite notes for GRE-707 item 6.
`mark_local_failure`, `revalidate_source_authority` and
`commit_source_authority_refusal` retain their tests and integration annotations;
this schema slice adds no production callers for them. Their callers are the
D18 (b) Sync target failure (GRE-614) and the D14 import Phase path (GRE-610). The authority helper
reuses `AuthorityRefusalReason::of` and saves one refusal.

The Node generator now also executes the local `syncProjectById` completion and
failure paths. Rust compares four terminal document-index results and two
failure-metadata cases against Node. Durable completion, inspection and
reconciliation have no Node counterpart. Tests port the remaining reference
completion and release checks, and add refusal, rollback and lost-reply cases.

### D17 source scan: schema 40

D17 (c) completes GRE-613 behind `desktop_rebuild`. The 39 to 40 step installs
`source_scan_executions` and its receipt index from `source_scan/schema.sql`.
`IF NOT EXISTS` preserves the reference catalog text and lets the step validate
an existing table and refuse drift without replacing it.

The upgrade keeps D14 (b)'s order:

1. Back up the input before any write. From 39, this is `backups/pre-schema40.db`.
2. Restore common objects and repair tenants without starter seeding.
3. Back up each pending step, install and validate it inside one transaction, then
   stamp and commit its version. The scan validator runs before the 40 stamp.
4. Validate the installed schema, then seed starters.

Preflight validates the scan journal for the stored version. A database below 40
with scan objects is refused. Reopening at 40 validates the journal without a new
backup. A fresh install creates no backups. The default build refuses schema 40.

Upgrade tests cover 35, 37, 38 and 39 to 40, logical backup contents from 39,
a blocked backup with unchanged input, and a drifted existing journal. The direct
initializer test bypasses preflight to prove that step validation rolls back the
new index and leaves version 39 intact. The same drift is also refused through
`WriterOwner` preflight. Logical comparisons include the SQLite catalog and rows,
because SQLite's backup API can rewrite header counters.

### D18 source sync: batch open and target claim

D18 (a), GRE-614, ports the first part of `source_sync` from
`desktop/source-sync-local-current-20261008` behind `desktop_rebuild`. A Sync
attempt opens a batch, then claims its targets one at a time. The default build
is unchanged and stays at schema 35.

| Slice | Work | Estimated added/changed lines |
| --- | --- | ---: |
| D18 (a) | Schema 41; `open`, basis validation, target claim with Source reservation, ordinary failures, `halt_job`; Cancel and worker Fail halts; bridge removal; tests, Node probe, docs | 1,600 |
| D18 (b) | Target validation, `settle`, `fail` with `mark_local_failure`, `acknowledge`, `adopt`, `halt_after_error` and `HaltSourceSync`; recovery of retained evidence; tests and docs | 1,450 |
| D18 (c) | `finish`, `inspect`, `inspect_retained`, the recovery read types, the journal-owner guards for generic Finish, effects and reconciliation, claim and advance refusals, the prune guard; tests and docs | 1,200 |

`open_source_sync` seals the batch the first time. An explicit selection keeps
payload order. A selection of all Sources orders them by `last_synced_at`, then
id, as the reference does; Node's `listProjectIds` uses table order. A later open
revalidates the sealed basis and returns claims from earlier attempts to pending.

`claim_next_source_sync_target` claims the first target that is not settled, in
one writer transaction. A missing Source fails with Node's `Source not found`. A
non-Local Source fails as `unsupported_kind`. Neither failure takes a reservation.
A Local target records the attempt, the Source observation and a new reservation
token. The token is activated after the commit, as claim-time reservation does.
The reference uses three round trips for this: next, `BeginSyncTarget` and bind.
A busy Source returns `SourceBusy` and leaves the target pending. A claim before
open is refused. The returned `SyncTargetLease` holds the Source until it is
released or dropped, so callers must not keep it longer than the target's work.

Cancel, a worker `Fail` and a revoked original credential halt the batch. Pending
targets become not-run. A claimed target is kept for reconciliation, and the Job
becomes `reconciliation_required`. Otherwise the Job is cancelled or failed. A
revoked credential records a Source-writer refusal. Until D18 (b), a claimed
target cannot be settled. Until D18 (c), generic Finish and effects are still
accepted for Sync.

The reference schema numbers Source Sync 42 because its 41 validates manifest
columns, which main does not have. Here the 40 to 41 step installs
`source_sync_batches` and `source_sync_targets` from `source_sync/schema.sql`,
following D17 (c): back up to `backups/pre-schema41.db`, install and validate in
one transaction, then stamp 41. Preflight refuses Sync objects below 41.

`fixtures/parity/source-sync/generate.mjs` runs Node's `InProcessJobRunner` Sync
job over a missing id and a Local Source. The Rust test asserts the target order
and Node's literal failure. Node has no durable batch, Source reservation or
authority check. The claim-before-open, restart-recovery and ordinal tests adapt
the reference `pp-core/tests/source_sync_local.rs` cases. The halt, refusal,
busy-Source and bridge tests are new.

```sh
node fixtures/parity/source-sync/generate.mjs --check
cargo test --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild --lib source_sync::
cargo test --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild --lib uploads::tests
```

### D20 Checkoff progress

GRE-615 adds `pp-storage::checkoff_progress`, compiled only with
`desktop_rebuild`. `WriterOwner::checkoff_progress()` returns a client whose
`apply` runs one request in one immediate writer transaction. No routes call it
yet; D24 and D26 wire HTTP behind `PP_DESKTOP_REBUILD`.

The contract is `db/accepted-plan-progress.ts`, `setAcceptedPrintedCounts` in
`db/repository.ts`, the progress and assembly routes in `routes/parts.ts`, and
the import route in `routes/plan-drafts.ts`. `apply` returns the Node status
and JSON body for each outcome:

- Completion by Required-unit token marks that unit and every lower unit
  printed. Clearing it clears that unit and every higher unit, including their
  assembly.
- Assembly by token sets one unit. Assembling an unprinted unit changes nothing.
- Part coordinates (`/parts/:id/progress` and `/parts/:id/assembled` bodies)
  resolve to a token against the current accepted snapshot.
- Import sets each listed Part's printed prefix. It checks every row before it
  writes any, and reports how many Parts changed.

Every write first checks the expected accepted basis, then archival. Unit
completion and assembly then check that each Part has one progress row per
unit. Import skips that check, as Node does. Only a successful write commits,
so a refusal leaves the database unchanged, including API key usage. An import for a Plan the caller cannot see returns 404
`progress_target_not_found`. This differs from Node on purpose. Node throws a
plain error and returns 500, but its route already returns 404 for a Plan it
does not serve.

```sh
cargo test --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild --test checkoff_progress
```

### D21 accepted read JSON bodies, GRE-616 PR 1

With `desktop_rebuild`, `AcceptedRead`, `Snapshot` and `Batch` each have an
`into_json_body` method. It returns the same bytes as the derived `Serialize`
output, except for Part manifest metadata. Each accepted `Part` now carries its
`PartManifestMetadata`, and the body writes `requirement` and `optionGroupId`
from those UTF-16 units. Text that is not valid Unicode keeps each unpaired
surrogate as a `\uXXXX` escape, as `JSON.stringify` does. The derived output
writes `null` for that text. No routes call these methods yet; D23 to D26 wire
HTTP behind `PP_DESKTOP_REBUILD`.

D22, GRE-618, lifts the temporary snapshot refusal for non-scalar manifest
text by moving Review to the same lossless carrier, as described below.

```sh
cargo test --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild --lib read_model::json_body
```

### D21 published capture, GRE-616 PR 2

With `desktop_rebuild`, `read_model::capture_published` reads the Accepted Plan
and its Build context in one transaction after a committed Save. It fails when
the Build is missing, when the Accepted Plan is not ready, or when the snapshot
Plan version is older than the Save receipt. Integrity failures propagate
unchanged. The D13 Save port (GRE-608) is its first caller.

Two other reference differences are not ported, because main is already
correct:

- Accepted progress. The reference counts units inline. Main uses
  `views::progress`, which gives the same counts: units of included Parts, and
  the units not yet completed. A test pins these counts in both profile
  summaries.
- Naming folder rules. The reference omits `functional_class` when it is unset,
  which changes the effective naming digest. Node `digestEffectiveNaming` writes
  `"functional_class":null`, and main does the same. Porting the change would
  mark every Build with such a rule stale. A test pins the Node digest.

```sh
cargo test --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild --lib read_model::capture_published_tests
cargo test --locked --manifest-path rust/Cargo.toml -p pp-storage --test ticket_t_61_read_model
```


### D22 Review JSON and workflow

GRE-618 completes the workflow and views delta from
`desktop/source-sync-local-current-20261008`. Workflow already matches that
reference, so its resolver stays unchanged. Main retains its catalog and
collation fallbacks instead of the reference's panic behavior.

With `desktop_rebuild`, `views::review_json` returns `ProjectReviewJsonBody`.
Its `into_bytes` preserves `requirement` and `option_group_id` from each Part's
UTF-16 manifest metadata, including unpaired surrogates as JSON escapes.
`summary_json` returns an optional `ProjectReviewSummaryJsonBody` with its own
`into_bytes`. Ready and empty reads have summaries; unavailable reads do not.
The summary uses scalar fields and does not serialize Part metadata.
Accepted snapshot reads now admit valid non-scalar metadata. Invalid PPJS
encodings, projection mismatches and digest failures remain refusals.

Default builds retain `views::review` and `views::summarize_review`. The fixture
binary selects the matching API at compile time. No HTTP routes or runtime
callers are added. Future product callers must check `PP_DESKTOP_REBUILD` and
send these JSON bytes directly, without parsing them through `serde_json::Value`,
which cannot hold unpaired surrogates.

```sh
cargo test --locked --manifest-path rust/Cargo.toml -p pp-storage
cargo test --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild
```
