# Required-unit storage message fixtures

`messages-node.jsonl` records literal errors from Node's
`parseRequiredUnitReconciliationResult` and `parseRequiredUnitSelectionBasis`.
The generator imports the actual TypeScript services with a Node resolver hook.
It does not copy their validation logic or substitute Rust error strings.

Run from the repository root with Node 24.21.0:

```sh
node rust/crates/pp-storage/tests/fixtures/required-units/messages-node.mjs
node rust/crates/pp-storage/tests/fixtures/required-units/messages-node.mjs --check
```

Each line contains the stored column, case name, literal JSON input, and Node's
first error message. Cases cover malformed shapes, extra fields, numeric bounds,
duplicate slots and tokens, canonical ordering, selection progress, and inputs
with multiple faults that establish validation precedence.

The storage tests install each input in a saved reconciliation and compare the
read error with Node's literal message. Rust parses shapes and scalar fields
before checking duplicate rows and sorting, then compares the canonical JSON
with the stored text. This preserves Node's first failure when a row has more
than one fault. The behavior remains behind `desktop_rebuild`, which is off by
default.

```sh
cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild -E 'test(result_json_matches_node_messages) | test(selection_basis_matches_node_messages)'
```
