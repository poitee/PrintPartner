# Node regression expectations

`gaps-node.mjs` calls the web server's `reconcileRequiredUnits` directly, as the
other Node fixture generators in the parent directory call their services. It
also opens a copy of `unchanged.db` with `PlanDraftWorkspaceService` to capture
the stale revision outcome. It does not regenerate the existing databases.

From the repository root, install the web dependencies first. Then generate or
check the literal results with Node 22.23.3 or 24.21.0. The `parity` job in
`.github/workflows/desktop-contracts.yml` runs `--check` on both versions.

```sh
umask 022
cd web
npm ci
TMPDIR=/persist/worktrees/laneD node --conditions=development --import tsx ../rust/crates/pp-storage/tests/fixtures/required-units/gaps-node.mjs
TMPDIR=/persist/worktrees/laneD node --conditions=development --import tsx ../rust/crates/pp-storage/tests/fixtures/required-units/gaps-node.mjs --check
```

`gaps-node.json` records Node's output. The `surplus`, `basis`, `nullSource`, and
`nullArtifact` results are copied literally into the matching model tests.
`tokenTie.selectionBasis` and `priorOrder.selectionBasis` are copied literally
into the existing shrink token-tie test. The operation test replays
`revisionBase.setup` and compares its full outcome with `revisionBase.result`.
Both the generator and the operation test check that the draft selection,
reconciliations, assignments, and decisions are unchanged after that request.

The sort cases deliberately put tokens or predecessor IDs in the opposite
order from traversal. The null cases put null on both sides of the comparison.
The revision case inserts a second accepted revision and sets the profile's
plan version to the draft's version, so only the revision ID differs.
