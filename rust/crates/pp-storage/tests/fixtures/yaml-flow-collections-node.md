# YAML flow-collection parity

`yaml-flow-collections-node.json` records the literal outputs of js-yaml 5.4.3 for 138 inputs. A null expectation means js-yaml rejects the input.

The 73 refusals cover three forms that saphyr-parser accepts and js-yaml rejects:

- A block scalar indicator (`|` or `>`) where a flow node starts, as in `project: [|]` or `{a: !!str >\n  hi}`.
- A separating tab followed by a flow token on the same line, when that line is indented less than the collection. A flow that opens on its block parent's line, as in `project: !!seq\t[]` or `project: [a,\tb]`, is the common case.
- A flow node's tag or anchor followed by a line break and content that is not indented past the collection, as in `[!!int\n1]` or `project: [!!int\n 1]`.

Every refusal that uses a `!!` tag appears again with the verbatim spelling `!<tag:yaml.org,2002:*>`.

The 65 accepted near misses sit next to those forms: indicators inside plain or quoted scalars, tabs inside scalars or before a line break, a tab in a collection that opens on a deeper line, and a tag line break followed by deeper content, a comma, a closing bracket, or a mapping colon.

The generator fails if js-yaml accepts a refusal or rejects a near miss. From the repository root, install the locked web dependencies, then regenerate and check the fixture:

```sh
npm --prefix web ci
node rust/crates/pp-storage/tests/fixtures/yaml-flow-collections-node.mjs > rust/crates/pp-storage/tests/fixtures/yaml-flow-collections-node.json
node rust/crates/pp-storage/tests/fixtures/yaml-flow-collections-node.mjs | cmp - rust/crates/pp-storage/tests/fixtures/yaml-flow-collections-node.json
```

`yaml_flow_collections_match_js_yaml` parses these inputs through `Document::parse` and compares each result with the expectation as JSON. The test runs with `pp-storage`'s default-off `desktop_rebuild` feature.
