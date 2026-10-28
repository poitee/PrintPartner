# YAML property-key parity

`yaml-property-keys-node.json` records js-yaml for two GRE-841 forms: properties before a key on its own line, and a tab after a block `?`. A null expectation means js-yaml rejects the input. js-yaml 5.4.3 and 5.5.0 give the same output for every case.

A block value that starts on the line after its `:` or `?` gives its first property to the mapping that a later property's key opens. `a:` then `  !!map &x : b` loads as `{"a":{"null":"b"}}`, with `!!map` on the mapping and `&x` on the empty key. With `!!str` in place of `!!map`, js-yaml rejects the document as an unknown mapping tag. `a: !!str` followed by `  &x : b` is the same refusal. A sequence entry and a root node keep both properties on the key.

A tab between a block `?` and its key is separation. `? \ta` loads as `{"a":null}`. A sequence, an explicit key, an implicit key, or a flow collection after that tab stays a refusal.

Regenerate from the repository root after `npm --prefix web ci`:

```sh
node rust/crates/pp-storage/tests/fixtures/yaml-property-keys-node.mjs > rust/crates/pp-storage/tests/fixtures/yaml-property-keys-node.json
node rust/crates/pp-storage/tests/fixtures/yaml-property-keys-node.mjs | cmp - rust/crates/pp-storage/tests/fixtures/yaml-property-keys-node.json
```

`yaml_property_keys_match_js_yaml` parses each input through `Document::parse` and compares the result with the expectation as JSON. The test runs with `pp-storage`'s default-off `desktop_rebuild` feature.
