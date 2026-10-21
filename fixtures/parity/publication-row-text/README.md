# Publication row-text fixture

Regenerate with Node 22.18 or later after installing the web dependencies:

```sh
npm --prefix web ci --ignore-scripts
node fixtures/parity/publication-row-text/generate.mjs
node fixtures/parity/publication-row-text/generate.mjs --check
```

The generator calls the real `AppRepository.publishPlanRevisionInputs` method,
including `validatePlanRevisionInputs` and the stored-row checks. Only the storage
adapter and unrelated profile/source existence lookups are fake. No database,
network service, or user data is used. Accepted rows must equal the rows captured
by the adapter. Rejections must be the actual Node row-text error.

Eight cases cover ASCII and multibyte UTF-8 at and above 65,536 counted bytes.
Input-set timestamps count twice, so adding one ASCII character exceeds that
boundary by two bytes. Input rows exceed it by one byte. The adapter adds a
65,540-byte `fixtureExtraText` column to exercise Node's stored-row checks with
unrelated text. It is a synthetic column, not a production schema addition.

`node.json` represents long strings as `{ "repeat": "text", "count": 123,
"suffix": "optional" }`. Rust expands these strings and calls the real SQLite
insert function with the literal Node outcomes. The fixture does not read Rust's
field mapping. The existing direct field-by-field tests remain in place.

```sh
cd rust
cargo test -p pp-storage --features desktop_rebuild inserted_rows_
```
