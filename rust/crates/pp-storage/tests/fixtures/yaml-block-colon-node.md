# YAML block-colon parity

`yaml-block-colon-node.json` records js-yaml 5.5.0 for a block colon after a flow value and the block plain scalars that start with `]`, `}`, or `,`. A null expectation means js-yaml rejects the input.

js-yaml 5.5.0 starts no plain scalar with a flow indicator, in block context or in a flow. So `a: ]`, `- ,`, `]: x`, and `a:`, a comment line, then `  ]` are all rejected, as is the null key with value `]` in `a:`, a flow list on the next line, a blank line, and `: ]`. js-yaml 5.4.3 read those as block plain scalars. The same block colon still loads a plain value, so `: x` there is a null key whose value is `"x"`. An indicator after the first character, as in `a: x]`, and a quoted `"]"` still load.

Regenerate from the repository root after `npm --prefix web ci`:

```sh
node rust/crates/pp-storage/tests/fixtures/yaml-block-colon-node.mjs > rust/crates/pp-storage/tests/fixtures/yaml-block-colon-node.json
node rust/crates/pp-storage/tests/fixtures/yaml-block-colon-node.mjs | cmp - rust/crates/pp-storage/tests/fixtures/yaml-block-colon-node.json
```

`yaml_block_colon_matches_js_yaml` parses each input through `Document::parse` and compares the result with the expectation as JSON. The test runs with `pp-storage`'s default-off `desktop_rebuild` feature.
