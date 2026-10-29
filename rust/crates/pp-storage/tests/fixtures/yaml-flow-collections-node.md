# YAML flow-collection parity

`yaml-flow-collections-node.json` records the literal outputs of js-yaml 5.5.0 for 686 inputs. A null expectation means js-yaml rejects the input.

92 refusals cover four forms that saphyr-parser accepts and js-yaml rejects:

- A block scalar indicator (`|` or `>`) where a flow node starts, as in `project: [|]` or `{a: !!str >\n  hi}`.
- A separating tab followed by a flow token on the same line, when that line is indented less than the collection. A flow that opens on its block parent's line, as in `project: !!seq\t[]` or `project: [a,\tb]`, is the common case. A tab after a node's tag or anchor counts only if the node ends on that line.
- A flow node's tag or anchor followed by a line break and content that is not indented past the collection, as in `[!!int\n1]` or `project: [!!int\n 1]`. A `:` on that line is refused unless it separates a mapping key, as in `[!!str\n:x]`.
- A flow continuation line indented less than the collection, as in `k: [a,\n]` or `k: [a\nb]`.

38 more refusals pin a quoted scalar continuation indented less than js-yaml allows, followed by a tagged or anchored empty flow node whose closing token sits on the next line, as in `- - {a: "a\n  b", !!str\n}`. saphyr rejects the closing line, so the pre-pass must leave that line where it is.

144 refusals cover a shallow quoted continuation followed by a line-broken empty key and a colon, including `- - {a: "a\n  b", !!str\n  :x}`. The matrix varies compact and block parents, nested flow collections, quote styles, line endings, tags, anchors, and colon indentation. The 96 adjacent controls indent the quoted continuation to the collection's required depth. The pre-pass checks that depth before colon normalization can hide saphyr's later refusal.

132 refusals pin an ordinary quoted continuation one column short of the depth js-yaml requires, with no property or colon after it, as in `outer:\n  k: ["a\n  b"]`. The matrix covers a block mapping, a nested block mapping, a compact sequence, and a nested flow mapping, with both quote styles and LF, CR, and CRLF endings. Each continuation is a plain line, a line after a blank line, a line after a tab-only line, spaces followed by a tab, a closing quote, or, for double quotes, the line after an escaped line break. The 108 adjacent controls move the continuation to the required depth. A control after a tab-only line is left out because saphyr rejects a column-0 tab in a quoted scalar; GRE-765 owns that accept.

Every refusal that uses a `!!` tag appears again with the verbatim spelling `!<tag:yaml.org,2002:*>`.

The other 172 accepted near misses sit next to those forms. They include indicators inside plain or quoted scalars, tabs inside scalars or before a line break, and a tab in a collection that opens on a deeper line. They also include an escaped CR or CRLF inside a double-quoted entry before a tab, and a tag line break followed by deeper content, a comma, a closing bracket, or a mapping colon.

The generator fails if js-yaml accepts a refusal or rejects a near miss. From the repository root, install the locked web dependencies, then regenerate and check the fixture:

```sh
npm --prefix web ci
node rust/crates/pp-storage/tests/fixtures/yaml-flow-collections-node.mjs > rust/crates/pp-storage/tests/fixtures/yaml-flow-collections-node.json
node rust/crates/pp-storage/tests/fixtures/yaml-flow-collections-node.mjs | cmp - rust/crates/pp-storage/tests/fixtures/yaml-flow-collections-node.json
```

`yaml_flow_collections_match_js_yaml` parses these inputs through `Document::parse` and compares each result with the expectation as JSON. The test runs with `pp-storage`'s default-off `desktop_rebuild` feature.
