import { createRequire } from "node:module";

const require = createRequire(new URL("../../../../../web/package.json", import.meta.url));
const { version } = require("js-yaml/package.json");
// Both versions give the same result for every case below.
if (!["5.4.3", "5.5.0"].includes(version)) throw new Error(`Expected js-yaml 5.4.3 or 5.5.0, got ${version}`);
const { load } = require("js-yaml");

// A block value on its own line gives its first property to the mapping that a
// later property's key opens. A tab after a block `?` is separation.
const cases = [
  ["own-line-verbatim-anchor-key", "a:\n  !<tag:yaml.org,2002:str> &x : "],
  ["own-line-str-anchor-key", "a:\n  !!str &x : "],
  ["own-line-str-key", "a:\n  !!str : "],
  ["own-line-anchor-key", "a:\n  &x : "],
  ["own-line-str-anchor-value", "a:\n  !!str &x : b"],
  ["own-line-str-anchor-plain-key", "a:\n  !!str &x k: b"],
  ["own-line-str-anchor-quoted-key", "a:\n  !!str &x \"k\": b"],
  ["own-line-str-anchor-scalar", "a:\n  !!str &x k"],
  ["own-line-map-anchor-key", "a:\n  !!map &x : b"],
  ["own-line-map-anchor-plain-key", "a:\n  !!map &x k: b"],
  ["own-line-map-second-entry", "a:\n  !!map &x k: b\n        l: c"],
  ["own-line-map-shallow-entry", "a:\n  !!map &x k: b\n  l: c"],
  ["own-line-map-shallow-value", "a:\n  !!map &x k:\n    l: m"],
  ["own-line-map-single-key", "a:\n  !!map &x 'k''s': b"],
  ["own-line-map-escaped-key", "a:\n  !!map &x \"k\\\"\": b"],
  ["own-line-map-comment-scalar", "a:\n  !!map &x k #c: b"],
  ["own-line-map-trailing-comment", "a:\n  !!map &x k: b # c"],
  ["own-line-map-anchor-tag-key", "a:\n  !!map &x !!str k: b"],
  ["own-line-map-two-tags", "a:\n  !!map !!str : b"],
  ["own-line-map-flow-key", "a:\n  !!map &x [k]: b"],
  ["own-line-map-alias-key", "a:\n  &x 1\nb:\n  !!map *x : c"],
  ["own-line-bare-tag", "a:\n  ! &x : b"],
  ["own-line-two-anchors", "a:\n  &x &y : b"],
  ["own-line-two-anchors-alias", "a:\n  &x &y k: b\nc: *x\nd: *y"],
  ["own-line-anchor-tag-alias", "a:\n  &x !!str : b\nc: *x"],
  ["own-line-verbatim-map", "a:\n  !<tag:yaml.org,2002:map> &x : b"],
  ["own-line-verbatim-map-adjacent", "a:\n  !<tag:yaml.org,2002:map>&x : b"],
  ["own-line-after-comment", "a:\n  # c\n  !!map &x : b"],
  ["own-line-after-blank", "a:\n\n  !!map &x : b"],
  ["own-line-deeper", "a:\n    !!map &x : b\nc: d"],
  ["own-line-tab-between", "a:\n  !!map\t&x : b"],
  ["property-then-break", "a: !!str\n  &x : b"],
  ["explicit-value-own-line", "? a\n:\n  !!str &x : b"],
  ["explicit-key-own-line", "?\n  !!map &x : b"],
  ["sequence-entry-same-line", "- !!str &x : b"],
  ["sequence-entry-own-line", "-\n  !!str &x : b"],
  ["root-same-line", "!!str &x : b"],
  ["root-after-break", "\n!!str &x k: b"],
  ["root-after-marker", "---\n!!str &x : b"],
  ["explicit-tab-plain", "? \ta"],
  ["explicit-tab-value", "? \ta\n: b"],
  ["explicit-tab-implicit-key", "?\ta: b"],
  ["explicit-tab-spaced-key", "? \ta: b"],
  ["explicit-tab-sequence-entry", "- ? \tx"],
  ["explicit-space-tab", "?  \tx"],
  ["explicit-two-tabs", "?\t\ta"],
  ["explicit-tab-space", "?\t a"],
  ["explicit-tab-single", "? \t'a'"],
  ["explicit-tab-double", "? \t\"a\""],
  ["explicit-tab-tag", "? \t!!str a\n: b"],
  ["explicit-tab-anchor", "? \t&x a"],
  ["explicit-tab-anchor-break", "? \t&x\n: b"],
  ["explicit-tab-literal", "? \t|\n  a"],
  ["explicit-tab-folded", "? \t>\n  a"],
  ["explicit-tab-comment", "? \t# c\n: b"],
  ["explicit-tab-empty", "? \t\n: b"],
  ["explicit-tab-multiline", "? \ta\n  b"],
  ["explicit-tab-twice", "? \ta\n? \tb"],
  ["explicit-tab-value-tab", "? \ta\n: \tb"],
  ["explicit-tab-alias", "a: &x 1\n? \t*x"],
  ["explicit-tab-nested", "a:\n  ? \tb\n  : c"],
  ["explicit-tab-glued-colon", "? \ta:b"],
  ["explicit-tab-spaced-colon", "? \ta :b"],
  ["explicit-tab-flow-sequence", "? \t[a]"],
  ["explicit-tab-flow-mapping", "? \t{a: 1}"],
  ["explicit-tab-tagged-flow", "? \t!!seq [a]"],
  ["explicit-tab-dash", "? \t- a"],
  ["explicit-tab-question", "? \t? a"],
];

const rows = [];
for (const [name, source] of cases) {
  rows.push([name, source]);
  if (source.includes("\n")) {
    rows.push([`${name}-crlf`, source.replaceAll("\n", "\r\n")]);
    rows.push([`${name}-cr`, source.replaceAll("\n", "\r")]);
  }
}

const encoded = rows.map(([name, source]) => {
  let expected = null;
  try {
    expected = load(source);
  } catch {
    expected = null;
  }
  return { name, source, expected };
});

process.stdout.write(`${JSON.stringify(encoded, null, 2)}\n`);
