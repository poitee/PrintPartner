import { createRequire } from "node:module";

const require = createRequire(new URL("../../../../../web/package.json", import.meta.url));
const { version } = require("js-yaml/package.json");
if (version !== "5.5.0") throw new Error(`Expected js-yaml 5.5.0, got ${version}`);
const { load } = require("js-yaml");

const cases = [
  ["seq-empty-explicit-key", "[? ]"],
  ["seq-empty-explicit-key-value", "[? : x]"],
  ["seq-empty-explicit-key-then-item", "[? , x]"],
  ["seq-item-then-empty-explicit-key", "[a, ? ]"],
  ["seq-two-empty-explicit-keys", "[? : x, ? ]"],
  ["seq-empty-explicit-key-empty-value", "[? :]"],
  ["seq-empty-explicit-key-break", "[? \n]"],
  ["seq-empty-explicit-key-leading-break", "[\n? ]"],
  ["seq-empty-explicit-key-comma", "[? ,]"],
  ["seq-explicit-key-plain", "[? x]"],
  ["seq-explicit-key-list", "[? :[]]"],
  ["map-explicit-null", "{? : x}"],
  ["map-explicit-null-break", "{? \n}"],
  ["seq-colon-list", "[:[]]"],
  ["map-colon-list", "{:[]}"],
  ["map-plain-tab", "{a:\tx}"],
  ["map-quoted-tab", '{"q":\tx}'],
  ["seq-nested-list", "[a:[]]"],
  ["map-tab-null-key", "{:\tx}"],
  ["map-colon-null", "{: }"],
  ["map-colon-map", "{:{}}"],
  ["map-plain-colon-list", "{a:[]}"],
  ["map-tab-list", "{a:\t[]}"],
  ["seq-tab-list", "[:\t[]]"],
  ["seq-colon-map", "[:{a:1}]"],
  ["block-tab-plain", "a:\tx"],
  ["block-tab-nested", "a:\n  b:\tx"],
  ["block-tab-null", "a:\t"],
  ["block-tab-comment", "a:\t# c"],
  ["block-key-tab", "project:\tx"],
  ["multiline-quoted-key-tab", 'a:\n  {"a\n b":\tx}'],
  ["verbatim-root", "!<tag:yaml.org,2002:str>b c1"],
  ["verbatim-char", "!<tag:yaml.org,2002:str>b"],
  ["verbatim-value", "v: !<tag:yaml.org,2002:str>b"],
  ["verbatim-int", "!<tag:yaml.org,2002:int>123"],
  ["verbatim-seq", "!<tag:yaml.org,2002:seq>[a]"],
  ["verbatim-map", "!<tag:yaml.org,2002:map>{a: 1}"],
  ["verbatim-quoted", '!<tag:yaml.org,2002:str>"b"'],
  ["verbatim-spaced", "!<tag:yaml.org,2002:str> b"],
  ["comment-with-space", '{"q": # c\n}'],
  ["plain-question", "[?x]"],
  ["map-plain-question", "{?x}"],
  ["dash-tab-plain", "- \tx"],
  ["comment-after-colon", '{"q":# c\n}'],
  ["comment-space-before-colon", '{"q" :# c\n}'],
  ["comment-no-break", '{"q":#c}'],
  ["comment-in-seq", '["q":# c\n]'],
  ["flow-question-close", "[?]"],
  ["flow-question-map", "{?}"],
  ["flow-question-after-item", "[x, ?]"],
  ["flow-question-after-tag", "[!!str ?]"],
  ["flow-question-comma", "[ ?, ]"],
  ["flow-question-question", "[? ? ]"],
  ["block-tab-flow", "a:\t[]"],
  ["complex-explicit-key", "[? {a: 1}]"],
];

const rows = [];
for (const [name, source] of cases) {
  rows.push([name, source]);
  if (source.includes("\n")) rows.push([`${name}-crlf`, source.replaceAll("\n", "\r\n")]);
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
