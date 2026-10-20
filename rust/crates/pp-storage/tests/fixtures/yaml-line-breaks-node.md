# YAML line-break parity

`yaml-line-breaks-node.json` records the literal outputs of js-yaml 5.4.3 for 413 inputs. CR, CRLF, and LF each cover plain, single-quoted, double-quoted, literal block, and folded block scalars. The corpus also covers blank lines, comments, dedented nodes, and verbatim string tags.

The five reviewer regressions are included unchanged. Eight tab/space combinations cover plain, flow, and block scalars with each line ending, including trailing whitespace at EOF. A null expectation means js-yaml rejects the input.

For `project: prefix`, indented content after blank lines continues the plain scalar. CRLF is one line break. Quotes in that continuation remain literal text, so `\uE000` must remain six characters. A blank line folds to a newline in the resulting value.

In a double-quoted scalar, js-yaml drops an escaped line break together with every blank line after it, so `"prefix\` followed by blank lines and `tail"` loads as `prefixtail`. saphyr keeps each blank line as a newline, so the shield pre-pass removes those blank lines before parsing. The escaped-break cases cover blank, space-only, and tab-only lines, a repeated break, an escape and a sentinel after the break, the scalar closing after a blank line, sequence and flow values, and dedented content js-yaml rejects. The controls are an escaped backslash, an escaped space, and a single-quoted backslash before a blank line, which keep the newline.

Plain and flow scalars treat a line containing only spaces and tabs before a break or EOF as blank. Block scalars count only spaces as indentation. A tab before the required indentation is rejected; a tab after sufficient indentation is scalar content. The leading, content, and explicit-indent block cases preserve this distinction.

From the repository root, install the locked web dependencies, then regenerate and check the fixture:

```sh
npm --prefix web ci
node rust/crates/pp-storage/tests/fixtures/yaml-line-breaks-node.mjs > rust/crates/pp-storage/tests/fixtures/yaml-line-breaks-node.json
node rust/crates/pp-storage/tests/fixtures/yaml-line-breaks-node.mjs | cmp - rust/crates/pp-storage/tests/fixtures/yaml-line-breaks-node.json
```

`yaml_line_breaks_match_js_yaml` parses these inputs through `Document::parse` and compares mapping values and sequence items as UTF-16 units. The test runs with `pp-storage`'s default-off `desktop_rebuild` feature.
