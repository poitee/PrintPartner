# YAML block-colon parity

`yaml-block-colon-node.json` records js-yaml 5.4.3 for a block colon after a flow value and the block plain scalars that start with `]`, `}`, or `,`. A null expectation means js-yaml rejects the input.

js-yaml reads `a:`, a flow list on the next line, a blank line, and `: ]` as the key `a` with an empty list and a null key whose value is `"]"`. The same colon reads `}`, `,`, and a longer plain scalar. A value can continue on a deeper line, so `a: ]` followed by `  more` loads as `"] more"`. A multiline scalar that stops at `:` on a later line is rejected. A flow `]` still closes the collection.

Regenerate from the repository root after `npm --prefix web ci`:

```sh
node rust/crates/pp-storage/tests/fixtures/yaml-block-colon-node.mjs > rust/crates/pp-storage/tests/fixtures/yaml-block-colon-node.json
node rust/crates/pp-storage/tests/fixtures/yaml-block-colon-node.mjs | cmp - rust/crates/pp-storage/tests/fixtures/yaml-block-colon-node.json
```

`yaml_block_colon_matches_js_yaml` parses each input through `Document::parse` and compares the result with the expectation as JSON. The test runs with `pp-storage`'s default-off `desktop_rebuild` feature.
