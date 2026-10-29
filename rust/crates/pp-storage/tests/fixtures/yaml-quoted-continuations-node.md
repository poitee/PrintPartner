# YAML quoted-continuation differential

`yaml-quoted-continuations-node.jsonl` records js-yaml 5.5.0 outputs for 3,648 quoted flow scalars that continue onto a later line. Each line holds one block: a name, the source before the scalar body, the source after it, and `[body, expected]` cases. A null expectation means js-yaml rejects the input.

The generator enumerates every combination of:

- 8 parents: a flow sequence or flow mapping under a block mapping, a nested block mapping, or a compact sequence, plus a flow sequence in a sequence entry and at the root (`k: [`, `k: {a: `, `outer:\n  k: [`, `outer:\n  k: {a: `, `- - [`, `- - {a: `, `- [`, `[`).
- 2 quote styles and LF, CR, and CRLF endings. The line breaks in the parent use the same ending.
- 8 shared continuation forms: a plain line, two lines, a trailing space before the break, a blank line, a spaces-only blank line, a tab-only blank line, spaces followed by a tab, and a closing quote. Double quotes add an escaped line break and an escaped quote before the break. Single quotes add a doubled quote before the break.
- Continuation indents of 0 through 7 spaces, which reach past the depth js-yaml requires for every parent.

js-yaml refuses 855 of these and accepts 2,793. The original 12,600-case probe from the PR #620 review was lost. This bounded version covers the forms pinned by `yaml-flow-collections-node.mjs` and keeps the fixture near 110 KB.

294 accepted cases are parked with `"GRE-765"`. They continue after a column-0 tab-only line, as in `k: ["a\n\t\n b"]`. saphyr refuses 204 of them because it rejects a column-0 tab on a whitespace-only line inside a quoted scalar; the other 90 already match. The test lets Rust refuse a parked case, but it must never read a different value. When GRE-765 lands, remove the `parked` rule in the generator and regenerate.

From the repository root, install the locked web dependencies, then regenerate and check the fixture with Node 22:

```sh
npm --prefix web ci
node rust/crates/pp-storage/tests/fixtures/yaml-quoted-continuations-node.mjs
node rust/crates/pp-storage/tests/fixtures/yaml-quoted-continuations-node.mjs --check
```

`yaml_quoted_continuations_match_js_yaml` parses each input through `Document::parse` and compares the result with the expectation as JSON. The test runs with `pp-storage`'s default-off `desktop_rebuild` feature.
