# Draft read and diff parity

`node.json` records complete response bodies for the public Rust `WorkingDraftClient::execute` requests. Each case contains its name, deterministic setup SQL, and named requests with literal JSON bodies. The Rust test compares bytes, including every field and array order.

The five cases cover draft 2 at open lifecycle 0, abandoned lifecycle 1, resumed lifecycle 2, and abandoned lifecycle 3. The ordering case adds an API-created draft dated before the original drafts. The original drafts share a timestamp, so their IDs break the tie.

Each case also covers consumed draft 1, missing IDs, foreign profile 2, an existing same-tenant draft belonging to another profile, and an existing foreign-tenant draft. Neither hidden draft appears in profile 1's list. Both owners successfully read their drafts in Node before the hiding checks.

The generator copies `rust/crates/pp-storage/tests/fixtures/required-units/unchanged.db` into disposable directories. It seeds ownership through `tenantStorage.run`, `repo.createSource`, `repo.createProfile`, and `repo.recomputePlanDraft`. Each new Source points to disposable `fake.stl` bytes. Recompute uses `applyManifest:false` and `preferAccepted:true`. Lifecycle changes use `service.abandon` and `repo.transitionPlanDraft` with `kind:'resume'`. A fixed clock supplies API timestamps.

The setup SQL exports those Node-created rows and each observed lifecycle transition for replay into Rust's separate copy. Exported new Sources have `local_path:null` because these reads use stored snapshots. The generator validates the SQL replay through the Node readers too. It never manufactures lifecycle or ownership state with SQL in the Node seed database, drops triggers, or calls ordinary Save.

List, Read, and Diff bodies come from the Node repository's camelCase values. Workspace bodies come from `PlanDraftWorkspaceService.read().workspace`. The public response envelopes preserve Rust's existing request contract. Missing and foreign ownership outcomes use the service's ownership checks.

Node and Rust compare observer `PRAGMA data_version` and every table's rows before and after repeated reads and reopening. This detects committed writes even if a later write restores the rows. The Rust negative check alters an actual runtime Read lifecycle version and removes an actual runtime Diff field. Both mutations must fail the same byte comparison used for parity.

The existing [`working_draft_core.rs`](../../../rust/crates/pp-storage/tests/working_draft_core.rs) already covers open draft 2, consumed Read, missing IDs, base identity, and richer diff cases. This fixture adds lifecycle and real foreign-ID evidence without changing production code or introducing a shared fixture framework.

## Regenerate and check

Run from the repository root with Node 22 and the installed `web` dependencies.

```sh
cd web
node --conditions=development --import tsx ../fixtures/parity/draft-read-diff/generate.mjs
node --conditions=development --import tsx ../fixtures/parity/draft-read-diff/generate.mjs --check
```

Generation prints `Generated 5 draft read/diff parity cases.` Checking prints `Checked 5 draft read/diff parity cases.` Review changes to `node.json` before accepting them.

## Run the focused Rust test

Run from the repository root on VM136. The existing Cargo wrapper takes one of the VM's two build slots.

```sh
set -a
. /persist/home/.config/t3/cargo-capacity.env
set +a
cd rust
CARGO_BUILD_JOBS=3 CARGO_TARGET_DIR=/persist/targets/gre-880-draft-read-diff-parity /persist/home/.local/bin/cargo test -p pp-storage --features desktop_rebuild --test draft_read_diff_parity
```
