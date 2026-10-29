# YAML flow-break parity

`yaml-flow-break-node.json` records js-yaml 5.5.0 for a flow tag or anchor at the end of a line. A null expectation means js-yaml rejects the input.

js-yaml reads `k:` then `[!!str` and `]` on the next line as `{"k":[""]}`. The same empty node is a key when the next line is `:x`, so `- - {a: "a` / `   b", !!str` / `:x}` loads as `[[{"a":"a b","":"x"}]]`. A block parent may leave that closer or colon above the collection. `!!seq` and `!!map` load as an empty collection. `!!int`, `!!bool`, and `!!float` do not. A quoted continuation one column short of the collection is rejected, and so is a colon that does not separate a mapping key.

Regenerate from the repository root after `npm --prefix web ci`:

```sh
node rust/crates/pp-storage/tests/fixtures/yaml-flow-break-node.mjs > rust/crates/pp-storage/tests/fixtures/yaml-flow-break-node.json
node rust/crates/pp-storage/tests/fixtures/yaml-flow-break-node.mjs | cmp - rust/crates/pp-storage/tests/fixtures/yaml-flow-break-node.json
```

`yaml_flow_break_matches_js_yaml` parses each input through `Document::parse` and compares the result with the expectation as JSON. The test runs with `pp-storage`'s default-off `desktop_rebuild` feature.
