# YAML line-break parity

`yaml-line-breaks-node.json` records the literal outputs of js-yaml 5.4.3 for 42 inputs. CR, CRLF, and LF each cover plain, single-quoted, double-quoted, literal block, and folded block scalars. The corpus also covers blank lines, comments, dedented nodes, and verbatim string tags. A null expectation means js-yaml rejects the input.

For `project: prefix`, indented content after blank lines continues the plain scalar. CRLF is one line break. Quotes in that continuation remain literal text, so `\uE000` must remain six characters. A blank line folds to a newline in the resulting value.

From the repository root, install the locked web dependencies, then regenerate and check the fixture:

```sh
npm --prefix web ci
node rust/crates/pp-storage/tests/fixtures/yaml-line-breaks-node.mjs > rust/crates/pp-storage/tests/fixtures/yaml-line-breaks-node.json
node rust/crates/pp-storage/tests/fixtures/yaml-line-breaks-node.mjs | cmp - rust/crates/pp-storage/tests/fixtures/yaml-line-breaks-node.json
```

`yaml_line_breaks_match_js_yaml` parses these inputs through `Document::parse` and compares the mapping values as UTF-16 units. The test runs with `pp-storage`'s default-off `desktop_rebuild` feature.
