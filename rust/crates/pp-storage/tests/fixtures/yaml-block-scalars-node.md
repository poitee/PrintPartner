# YAML block scalar parity

`yaml-block-scalars-node.json` records the literal outputs of js-yaml 5.4.3 for 1,116 inputs around block scalar boundaries. A null expectation means js-yaml rejects the input. 140 cases are rejections.

## Lines that end an explicit-indentation block scalar

js-yaml ends a block scalar with an indentation indicator at the first non-blank line that is shallower than the content indent, and skips that line when it is a comment or holds only spaces and tabs. So `a: |2`, then ` # c`, loads as `{"a":""}`, and so do `a: |2` then a tab-only line, and `a: >+2` then a tab at the end of the input. saphyr rejects some of these comments when they keep their indent, and it reads the tab as indentation. The shield pre-pass moves such a comment to column 0 and replaces such a whitespace-only line with `#` at column 0, which ends the scalar in saphyr too.

The matrix crosses the headers `|1`, `|2`, `>2-`, `|+2`, `>+2`, `>1` and `|3` with comment lines at columns 0 to 3, whitespace-only lines with tabs and with spaces only, and tab-led comment and text lines. The forms are a mapping value at the end of the input, before a sibling key, after a blank line, on two lines, without a final line break, after a shallow comment-like content line, before and after deeper content, a sequence item, a nested mapping value, a header on the next line, and the document root. A CRLF variant covers the `|2` sibling form.

## Root block scalars

js-yaml counts a root indentation indicator from column 0, so `|1` then ` x` loads as `" x\n"`. saphyr counts it from column 1. js-yaml also reads root content at column 0 that starts with a tab, as in `|` then a tab-led `# c`, which saphyr rejects. The shield indents each line of a root block scalar one column deeper. The root cases cover each header, strip and keep chomping, a leading blank line, content shallower than the indicator, a header after `---`, after a tag and before a comment, an indented header, and tab-led text, comments and blank lines.

## Document markers

js-yaml ends a block scalar at `---` or `...` at column 0, so `|`, `x`, `---`, `y` holds two documents and is rejected, while `|`, `x`, `...` loads as `"x\n"`. saphyr reads those lines as root block content. The shield ends the block scalar at the marker. Controls cover `---x`, `...x`, indented markers, a marker followed by a tab, a value or a comment, folded and explicit headers, a header after `---`, and markers after a mapping value. A CRLF variant covers each marker case.

## Out of scope

The generator leaves out two saphyr gaps that remain in the Rust boundary:

- An empty block scalar at the end of the input. js-yaml loads `a: |` as `{"a":""}`. saphyr loads it as `{"a":"\n"}`, including when only lines of spaces no deeper than the content indent follow the header.
- A root block scalar with an indentation indicator that ends before its first content line. js-yaml loads `|2` then `# c` as `""`. saphyr rejects it with "wrongly indented line in block scalar".

From the repository root, install the locked web dependencies, then regenerate and check the fixture:

```sh
npm --prefix web ci
node rust/crates/pp-storage/tests/fixtures/yaml-block-scalars-node.mjs > rust/crates/pp-storage/tests/fixtures/yaml-block-scalars-node.json
node rust/crates/pp-storage/tests/fixtures/yaml-block-scalars-node.mjs | cmp - rust/crates/pp-storage/tests/fixtures/yaml-block-scalars-node.json
```

`yaml_block_scalars_match_js_yaml` parses these inputs through `Document::parse` and compares the loaded value with js-yaml's as JSON. The test runs with `pp-storage`'s default-off `desktop_rebuild` feature.
