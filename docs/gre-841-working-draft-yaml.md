# GRE-841 working-draft YAML parity

[GRE-841](https://linear.app/greetz/issue/GRE-841/p2-working-draft-yaml-remaining-flow-key-and-verbatim-tag-parity-gaps) lists flow-key and verbatim-tag documents that `Document::parse` read differently from js-yaml 5.4.3. The parser sits behind the default-off `desktop_rebuild` feature. With the feature off, the module is not built and nothing changes.

## Ticket inputs

Earlier GRE-841 pull requests made each listed input load as js-yaml loads it:

| Input | js-yaml result |
| --- | --- |
| `[? ]` | `[{"null":null}]` |
| `!<tag:yaml.org,2002:str>b c1` | `"b c1"` |
| `[:[]]` | `[{"null":[]}]` |
| `{:\ta\n }` | `{"null":"a"}` |
| `a:\n  []\n\n: ]` | `{"a":[],"null":"]"}` |
| `a:\n  {"a\n b":\ta\\}` | `{"a":{"a b":"a\\"}}` |
| `{"q":# c\n}` | refused |

`yaml_flow_property_corpus_matches_js_yaml` replays all 31 cases in `fixtures/parity/yaml-flow-properties/node.json` through the Rust parser. That covers each input above with LF, CR, CRLF, and no final line break where the corpus has one. It also covers the `{"q":}` and `{"q": # c\n}` controls.

## Forms closed in this change

- A block value that starts on the line after its `:` or `?`, with two properties and then a key, as in `a:` then `  !!map &x : b`. js-yaml gives the first property to the mapping and the rest to the key. With `!!str` first, js-yaml refuses the document as an unknown mapping tag. The shield breaks the line after the first property, so saphyr reads the property the same way.
- A tab between a block `?` and its key, as in `? \ta`. js-yaml reads the tab as separation. The shield writes a space there. A flow collection after that tab is still refused, as in js-yaml.

`yaml_property_keys_match_js_yaml` checks 166 rows from `rust/crates/pp-storage/tests/fixtures/yaml-property-keys-node.json`.

## Still different

A random run of 4,000 documents built from these shapes found other differences. None of them is a form this ticket lists:

- A tab between a property and a key on the same line, as in `- !\t'k' : b`. js-yaml accepts it. Rust refuses it.
- A mapping on the same line as its parent key after a property, as in `a: ! :` or `a: !!str "k" : b`. js-yaml accepts it. Rust refuses it.
- An empty block scalar with a CRLF break, as in `a:\n  |\r\n`. js-yaml loads `""`. Rust loads `"\n"`.

The known-difference list in `docs/desktop-rebuild.md` still names forms that now match js-yaml, including the own-line property form closed here. It does not list the tab after a block `?`. That file is left to the pull requests that own it.
