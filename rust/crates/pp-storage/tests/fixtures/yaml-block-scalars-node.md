# YAML block scalar parity

`yaml-block-scalars-node.json` records the literal outputs of js-yaml 5.4.3 for 1,151 inputs around block scalar boundaries. A null expectation means js-yaml rejects the input. 163 cases are rejections.

## Lines that end an explicit-indentation block scalar

js-yaml ends a block scalar with an indentation indicator at the first non-blank line that is shallower than the content indent, and skips that line when it is a comment or holds only spaces and tabs. So `a: |2`, then ` # c`, loads as `{"a":""}`, and so do `a: |2` then a tab-only line, and `a: >+2` then a tab at the end of the input. saphyr rejects some of these comments when they keep their indent, and it reads the tab as indentation. The shield pre-pass moves such a comment to column 0 and replaces such a whitespace-only line with `#` at column 0, which ends the scalar in saphyr too.

The matrix crosses the headers `|1`, `|2`, `>2-`, `|+2`, `>+2`, `>1` and `|3` with comment lines at columns 0 to 3, whitespace-only lines with tabs and with spaces only, and tab-led comment and text lines. The forms are a mapping value at the end of the input, before a sibling key, after a blank line, on two lines, without a final line break, after a shallow comment-like content line, before and after deeper content, a sequence item, a nested mapping value, a header on the next line, and the document root. A CRLF variant covers the `|2` sibling form.

## Root block scalars

js-yaml counts a root indentation indicator from column 0, so `|1` then ` x` loads as `" x\n"`. saphyr counts it from column 1. js-yaml also reads root content at column 0 that starts with a tab, as in `|` then a tab-led `# c`, which saphyr rejects. The shield indents each line of such a root block scalar one column deeper.

js-yaml indents a root node from the line it starts on, except on the first line of the input, where it counts no indent. So after a blank first line, `  |` then a tab-led `x` is rejected, and `  |` then ` x` is rejected because nothing but comments may follow the root node. The shield tracks such a root block scalar from that indent. saphyr reads a comment or `---` that ends a root block scalar with no indicator and no content yet as that content, so the shield rejects those inputs, as in a blank line, `  |`, ` # c`, then `x`. The root cases cover each header, strip and keep chomping, a leading blank line, content shallower than the indicator, a header after `---`, after a tag and before a comment, an indented header on the first and on a later line, and tab-led text, comments and blank lines.

## Document markers

js-yaml ends a block scalar at `---` or `...` at column 0, so `|`, `x`, `---`, `y` holds two documents and is rejected, while `|`, `x`, `...` loads as `"x\n"`. saphyr reads those lines as root block content. The shield ends the block scalar at the marker. Controls cover `---x`, `...x`, indented markers, a marker followed by a tab, a value or a comment, folded and explicit headers, a header after `---`, and markers after a mapping value. A CRLF variant covers each marker case.

## Byte order marks and non-printable characters

js-yaml reads a line that starts with a BOM as a document boundary when the separation space after the BOM reaches `%` or `---` at the start of a line, so `|1` then a BOM and `---` is rejected as two documents. A BOM line that reaches anything else is content. The shield ends a block scalar at such a boundary. js-yaml also rejects C0 and C1 control characters other than tab, line breaks and NEL, and U+FFFE and U+FFFF, inside a scalar, and rejects any input that contains NUL. The shield checks the same characters in block scalar content and rejects NUL anywhere. The cases cover each BOM form, control characters, a noncharacter and NUL.

## Out of scope

The generator leaves out two saphyr gaps that remain in the Rust boundary:

- An empty block scalar at the end of the input. js-yaml loads `a: |` as `{"a":""}`. saphyr loads it as `{"a":"\n"}`, including when only lines of spaces no deeper than the content indent follow the header.
- A root block scalar that ends before its first content line. js-yaml loads `|2` then `# c` as `""`, which saphyr rejects with "wrongly indented line in block scalar". js-yaml rejects `|`, `--- |`, `a: |` as two documents, but saphyr reads the marker line as the first scalar's content.

From the repository root, install the locked web dependencies, then regenerate and check the fixture:

```sh
npm --prefix web ci
node rust/crates/pp-storage/tests/fixtures/yaml-block-scalars-node.mjs > rust/crates/pp-storage/tests/fixtures/yaml-block-scalars-node.json
node rust/crates/pp-storage/tests/fixtures/yaml-block-scalars-node.mjs | cmp - rust/crates/pp-storage/tests/fixtures/yaml-block-scalars-node.json
```

`yaml_block_scalars_match_js_yaml` parses these inputs through `Document::parse` and compares the loaded value with js-yaml's as JSON. The test runs with `pp-storage`'s default-off `desktop_rebuild` feature.
