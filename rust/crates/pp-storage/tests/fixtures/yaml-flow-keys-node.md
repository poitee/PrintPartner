# YAML flow-key parity

`yaml-flow-keys-node.json` records the literal outputs of js-yaml 5.4.3 for 44 inputs from GRE-841. A null expectation means js-yaml rejects the input.

saphyr refuses four forms that js-yaml accepts. The shield pre-pass rewrites each one before parsing:

- An empty explicit key in a flow sequence, as in `[? ]`, `[? : x]` or `[a, ? ]`. saphyr drops the token after the empty key, so the shield writes the key as `~`. js-yaml reads the empty key as null, which becomes the key `"null"`.
- A flow `:` followed by a collection, as in `[:[]]` or `[a:[]]`. The shield adds a space after the colon.
- A flow `:` followed by a tab, as in `{:\ta}` or `{"q":\tx}`. This includes a multi-line quoted key, as in `a:` then `  {"a` and ` b":\ta\}`. The shield adds a space after the colon. The tab checks from GRE-713 still read the original text.

saphyr accepts two forms that js-yaml rejects. The shield refuses them:

- A `#` right after a quoted key's colon, as in `{"q":# c\n}`. js-yaml reads no comment there.
- A flow `?` followed by `,`, `]` or `}`, as in `[?]`, `{?}` or `[!!str ?]`. js-yaml reads no node from it.

Controls cover a non-empty explicit key, a tagged empty explicit key, an explicit empty key in a flow mapping, `?` and `:` at the start of a plain scalar, `[: x]`, `{:}`, a space or a tab before the comment, and `#` after a plain or tagged key.

From the repository root, install the locked web dependencies, then regenerate and check the fixture:

```sh
npm --prefix web ci
node rust/crates/pp-storage/tests/fixtures/yaml-flow-keys-node.mjs > rust/crates/pp-storage/tests/fixtures/yaml-flow-keys-node.json
node rust/crates/pp-storage/tests/fixtures/yaml-flow-keys-node.mjs | cmp - rust/crates/pp-storage/tests/fixtures/yaml-flow-keys-node.json
```

`yaml_flow_keys_match_js_yaml` parses these inputs through `Document::parse` and compares the loaded value with js-yaml's as JSON. The test runs with `pp-storage`'s default-off `desktop_rebuild` feature.
