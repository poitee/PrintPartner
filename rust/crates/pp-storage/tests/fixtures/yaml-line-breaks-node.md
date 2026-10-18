# YAML line-break parity

`yaml-line-breaks-node.json` records the literal outputs of js-yaml 5.4.3 for 359 inputs. CR, CRLF, and LF each cover plain, single-quoted, double-quoted, literal block, and folded block scalars. The corpus also covers blank lines, comments, dedented nodes, and verbatim string tags.

The five reviewer regressions are included unchanged. Eight tab/space combinations cover plain, flow, and block scalars with each line ending, including trailing whitespace at EOF. A null expectation means js-yaml rejects the input.

For `project: prefix`, indented content after blank lines continues the plain scalar. CRLF is one line break. Quotes in that continuation remain literal text, so `\uE000` must remain six characters. A blank line folds to a newline in the resulting value.

Plain and flow scalars treat a line containing only spaces and tabs before a break or EOF as blank. Block scalars count only spaces as indentation. A tab before the required indentation is rejected; a tab after sufficient indentation is scalar content. The leading, content, and explicit-indent block cases preserve this distinction.

From the repository root, install the locked web dependencies, then regenerate and check the fixture:

```sh
npm --prefix web ci
node rust/crates/pp-storage/tests/fixtures/yaml-line-breaks-node.mjs > rust/crates/pp-storage/tests/fixtures/yaml-line-breaks-node.json
node rust/crates/pp-storage/tests/fixtures/yaml-line-breaks-node.mjs | cmp - rust/crates/pp-storage/tests/fixtures/yaml-line-breaks-node.json
```

`yaml_line_breaks_match_js_yaml` parses these inputs through `Document::parse` and compares mapping values and sequence items as UTF-16 units. The test runs with `pp-storage`'s default-off `desktop_rebuild` feature.
