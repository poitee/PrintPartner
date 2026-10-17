# Required-unit storage message fixtures

`messages-node.jsonl` records literal errors from Node's
`parseRequiredUnitReconciliationResult` and `parseRequiredUnitSelectionBasis`.
The generator imports the actual TypeScript services with a Node resolver hook.
It does not copy their validation logic. Rust error strings appear only in the
`rust` field described below.

Run from the repository root with Node 22.23.3 or 24.21.0. The `parity` job in
`.github/workflows/desktop-contracts.yml` runs `--check` on both versions.

```sh
node rust/crates/pp-storage/tests/fixtures/required-units/messages-node.mjs
node rust/crates/pp-storage/tests/fixtures/required-units/messages-node.mjs --check
```

Each line contains the stored column, case name, literal JSON input, and Node's
first error message. Cases cover malformed shapes, extra fields, numeric bounds,
duplicate slots and tokens, canonical ordering, selection progress, and inputs
with multiple faults that establish validation precedence.

Cases with a `rust` field expect that message from Rust instead of Node's:

- Valid cases have a `message` of `null` because Node accepts the input. Rust
  must parse it too. The storage test changes one column of a saved
  reconciliation, so Rust's read then stops at the digest or kind check that
  follows parsing. The `valid-stored` cases repeat the saved text, so the read
  succeeds and `rust` is empty.
- The `syntax-` cases pin a known divergence. serde_json refuses some text that
  `JSON.parse` accepts, so Rust reports the syntax error "Required-unit
  reconciliation result is invalid". Node refuses the same input later, with a
  field message:
  - `1e400` parses as `Infinity` in Node, which then fails the Part ID check.
    serde_json refuses the out-of-range number.
  - A lone surrogate escape, `"\ud800"`, is a string in Node, which then fails
    the token check. serde_json refuses the escape.
  - Arrays nested 200 deep parse in Node, which then fails the assignment
    check. serde_json stops at its recursion limit of 128.

  Both sides refuse each input. Matching Node's wording would mean replacing
  serde_json's parser, so the difference is recorded instead. The generator
  asserts that Node's message still differs from `rust`, and the storage test
  asserts Rust's message, so a change on either side fails a check.

The storage tests install each input in a saved reconciliation and compare the
read error with Node's literal message. Rust parses shapes and scalar fields
before checking duplicate rows and sorting, then compares the canonical JSON
with the stored text. This preserves Node's first failure when a row has more
than one fault. The behavior remains behind `desktop_rebuild`, which is off by
default.

```sh
cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild -E 'test(result_json_matches_node_messages) | test(selection_basis_matches_node_messages)'
```
