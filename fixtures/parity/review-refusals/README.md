# Review refusals for malformed stored inputs (GRE-881)

`node.json` records how the Node accepted-Plan Review read refuses malformed stored inputs.
`rust/crates/pp-storage/tests/review_refusal_parity.rs` applies the same SQL to the same database and reads it through the public `plan-read-fixture` binary, with `desktop_rebuild` on.

Each case copies `rust/crates/pp-storage/tests/fixtures/accepted-plan-node.db`, writes a sentinel file under `repos/`, and runs one literal SQL mutation.
Node calls `readAcceptedPlanReview`, the function behind `GET /plans/:id/review`.

## Evidence kept apart

- **Node.** The raw thrown error (`name`, `code`, `message`) and `routeClass`. `routeClass` is `integrity_failure` when the error is an `AcceptedPlanOperationalIntegrityError`, the same `instanceof` test the route uses, and `unexpected` otherwise.
- **Rust.** The typed carrier. `AcceptedRead::IntegrityFailure` comes back per Build in the batch. Any other error fails the whole batch and the binary exits nonzero. The Rust literals live in the test, not in `node.json`.
- **Preserved state.** The `rowsQuery` result and the `repos/` files, before and after the read, must be unchanged and identical to `node.json`. Each runtime also compares every row of every table before and after its own read. That full snapshot is compared only within each runtime. Both encode each cell with the `cell` SQL in `node.json`, as its storage class plus exact hex bytes, because `quote()` stops TEXT at the first NUL.

The fixture makes no claim about HTTP status, because no Rust HTTP route serves Review yet.

## Cases

| Case | Node thrown | Rust carrier | Class |
| --- | --- | --- | --- |
| `malformed-parts-ppjs` | `projection` | `manifest_text` | Same |
| `malformed-plan-revision-parts-ppjs` | `revision_digest` | `manifest_text` | Same |
| `non-scalar-metadata-stale-digest` | `revision_digest` | `revision_digest` | Same |
| `non-scalar-projection-mismatch` | `projection` | `projection` | Same |
| `unrelated-renamed-column` | `SqliteError` | `revision_digest` | Differs |

Node has no PPJS decoder. It reads a PPJS BLOB as a `Buffer`, so a malformed BLOB reaches the projection or digest comparison. Rust decodes PPJS first and refuses with `manifest_text`.

The renamed-column case is a control for an unrelated failure. Node throws a raw `SqliteError`. Rust reads `SELECT *` without the column and refuses with `revision_digest`. The test asserts both literals and does not count this case as class parity.

A second Rust test reads with a wrong session. That generic batch error must not equal any expected refusal.

## Regenerate

Requires Node 22.x and `npm --prefix web ci --ignore-scripts`.

```sh
node --import ./web/node_modules/tsx/dist/loader.mjs --conditions=development \
  fixtures/parity/review-refusals/generate.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs --conditions=development \
  fixtures/parity/review-refusals/generate.mjs --check
cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-storage \
  --features desktop_rebuild --test review_refusal_parity
```
