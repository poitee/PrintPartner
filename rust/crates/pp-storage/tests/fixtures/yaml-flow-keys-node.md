# YAML flow-key parity

`yaml-flow-keys-node.json` records js-yaml 5.4.3 for the GRE-841 flow-key, flow-colon, and verbatim-tag forms that this slice matches. A null expectation means js-yaml rejects the input.

js-yaml reads an explicit empty flow key as a null key, so `[? ]` loads as `[{"null":null}]`. A flow `?` with no space before `,`, `]`, or `}` is not a key, and js-yaml rejects it. A colon with no space before a tab or a nested collection is a value separator at the root of a flow collection, as in `[:[]]` and `{a:\tx}`. The same tab after a block colon is a separator for a plain value, as in `a:\tx`, and is not a separator for a flow value, as in `a:\t[]`.

A comment with no space after a quoted key's colon is a missed comma. A space before `#` is a comment, and the value is null. A verbatim tag may touch the next scalar, so `!<tag:yaml.org,2002:str>b c1` loads as `"b c1"`.

A block tab before a flow value, as in `a:\t[]`, stays a refusal. A tag before an implicit key on its own line is a separate gap and is not in this fixture.

Regenerate from the repository root after `npm --prefix web ci`:

```sh
node rust/crates/pp-storage/tests/fixtures/yaml-flow-keys-node.mjs > rust/crates/pp-storage/tests/fixtures/yaml-flow-keys-node.json
node rust/crates/pp-storage/tests/fixtures/yaml-flow-keys-node.mjs | cmp - rust/crates/pp-storage/tests/fixtures/yaml-flow-keys-node.json
```

`yaml_flow_keys_match_js_yaml` parses each input through `Document::parse` and compares the result with the expectation as JSON. The test runs with `pp-storage`'s default-off `desktop_rebuild` feature.
