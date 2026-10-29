# YAML block-tab parity

`yaml-block-tabs-node.json` records js-yaml 5.5.0 for a tab used as block structure. A null expectation means js-yaml rejects the input.

js-yaml rejects a tab in the separation before a block indicator. The indicator is `-` or `?` followed by a space, or `:` after a key that began after the tab. `a:\n  \t- x` is a sequence indicator after a tab. `- \t:` is a colon after a tab. `- :\t!!str :\t` is a tagged key after a tab. The same tab before a plain value still loads, as in `a:\n  \tx`, `- \tx`, and `a:\tx`. A colon glued to that value, as in `a:\tx:y`, stays inside the scalar. A tab between a key and its colon, as in `a\t: b`, is part of that key's trailing space.

A block scalar, a flow value, a comment, or a tag with a plain value may follow a tab. A flow key or an anchor key that begins after the tab does not. A tab after `?` is outside this fixture.

Regenerate from the repository root after `npm --prefix web ci`:

```sh
node rust/crates/pp-storage/tests/fixtures/yaml-block-tabs-node.mjs > rust/crates/pp-storage/tests/fixtures/yaml-block-tabs-node.json
node rust/crates/pp-storage/tests/fixtures/yaml-block-tabs-node.mjs | cmp - rust/crates/pp-storage/tests/fixtures/yaml-block-tabs-node.json
```

`yaml_block_tabs_match_js_yaml` parses each input through `Document::parse` and compares the result with the expectation as JSON. The test runs with `pp-storage`'s default-off `desktop_rebuild` feature.
