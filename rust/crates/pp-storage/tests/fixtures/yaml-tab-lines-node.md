# YAML tab-line parity

`yaml-tab-lines-node.json` records the literal outputs of js-yaml 5.5.0 for 233 inputs that put a tab in an otherwise blank line or at the start of a comment line. A null expectation means js-yaml rejects the input.

## Whitespace-only lines in quoted scalars

js-yaml folds a line that holds only spaces and tabs inside a single- or double-quoted scalar as a blank line, so `a: "x` followed by a tab-only line and `  y"` loads as `x\ny`. saphyr rejects such a line when it contains a tab, in block and flow context. The shield pre-pass drops the whitespace of each whitespace-only line in a quoted scalar before parsing, which leaves the empty line saphyr folds the same way.

The quoted cases cover both quote styles with `\t`, `\t\t`, ` \t ` and `  \t` lines. The forms are block mapping values, nested mapping values, a value on the next line, sequence and nested sequence items, a root scalar, and flow sequences and mappings. Controls cover two blank lines, trailing tabs on content lines, a closing quote after the blank line, a `\uE000` escape next to a literal U+E000, and dedented content after the blank line, which js-yaml rejects. CR and CRLF variants cover the block, nested sequence and flow mapping forms. The dedent check from GRE-763 still applies to every non-blank continuation line.

## Tab-led comment lines

js-yaml ends a plain scalar at a comment line, so `a: x`, a comment line, then a deeper `  y` fails with "bad indentation of a mapping entry". saphyr ends the scalar at a comment led by spaces, but continues the scalar across one led by a tab. The shield pre-pass removes the indentation of each comment line outside quoted and block scalars, so saphyr ends the plain scalar there too.

js-yaml measures a block scalar from the indent of its parent node, the key, `-` or `?` it belongs to, not from the line the `|` or `>` header sits on. It ends the scalar at the first non-blank line that is no deeper than the parent, and an explicit indicator such as `|2` counts from the parent's indent. The shield tracks the block scalar the same way, so a header on its own line, as in `a:` then `  |`, keeps its content.

Before the first content line sets the indent of a block scalar with no indicator, js-yaml rejects a tab that sits no deeper than the parent, as in `a: |`, a blank line, then a tab-led comment. saphyr accepts some of these, so the shield rejects them before it touches the comment. A deeper tab is block content. At the document root, no tab is rejected this way.

The comment cases use `\t`, ` \t` and `\t\t` before `# c`. They cover deeper and sibling lines after plain values in mappings, nested mappings, sequences and flow collections, a `\uE000` escape in a deeper quoted line, a comment after a value comment, a comment after a quoted value, a comment inside a quoted scalar, a comment before a nested mapping, comments at the end of and inside a literal block, comments before the first content line of literal, folded, keep-chomped, explicit-indent, nested, sequence, root, and next-line block scalars, and a comment before the root node.

From the repository root, install the locked web dependencies, then regenerate and check the fixture:

```sh
npm --prefix web ci
node rust/crates/pp-storage/tests/fixtures/yaml-tab-lines-node.mjs > rust/crates/pp-storage/tests/fixtures/yaml-tab-lines-node.json
node rust/crates/pp-storage/tests/fixtures/yaml-tab-lines-node.mjs | cmp - rust/crates/pp-storage/tests/fixtures/yaml-tab-lines-node.json
```

`yaml_tab_lines_match_js_yaml` parses these inputs through `Document::parse` and compares the loaded value with js-yaml's as JSON. The test runs with `pp-storage`'s default-off `desktop_rebuild` feature.
