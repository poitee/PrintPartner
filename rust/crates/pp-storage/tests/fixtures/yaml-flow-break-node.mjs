import { createRequire } from "node:module";

const require = createRequire(new URL("../../../../../web/package.json", import.meta.url));
const { version } = require("js-yaml/package.json");
if (version !== "5.5.0") throw new Error(`Expected js-yaml 5.5.0, got ${version}`);
const { load } = require("js-yaml");

// A tag or anchor at the end of a flow line, then a closer or a key colon.
// js-yaml reads an empty node. The closer may sit above the block parent.
const accepted = [
  ["block-key", "k: [!!str\n]"],
  ["block-key-crlf", "k: [!!str\r\n]"],
  ["block-key-cr", "k: [!!str\r]"],
  ["nested-key", "a:\n  b: [!!str\n]"],
  ["value-line", "k:\n  [!!str\n]"],
  ["indented-open", "a:\n  [!!str\n]"],
  ["sequence", "- [!!str\n]"],
  ["sequence-next", "-\n  [!!str\n]"],
  ["compact", "- - {!!str\n}"],
  ["nested-seq-map", '- - {a: "a\n   b", !!str\n}'],
  ["property-colon", '- - {a: "a\n   b", !!str\n:x}'],
  ["property-colon-space", '- - {a: "a\n   b", !!str\n: x}'],
  ["property-colon-crlf", '- - {a: "a\r\n   b", !!str\r\n:x}'],
  ["block-colon", "k: {!!str\n:x}"],
  ["nested-colon", "a:\n  b: {!!str\n:x}"],
  ["colon-flow", "k: {!!str\n:[]}"],
  ["colon-empty", "k: {!!str\n:}"],
  ["comma", "k: [!!str\n, 1]"],
  ["map-comma", "k: {!!str\n, a: 1}"],
  ["map-value", "k: {a: !!str\n}"],
  ["seq-tag", "k: [!!seq\n]"],
  ["map-tag", "k: [!!map\n]"],
  ["null-tag", "k: [!!null\n]"],
  ["bare-tag", "k: [!\n]"],
  ["anchor", "k: [&a\n]"],
  ["tag-anchor", "k: [!!str &a\n]"],
  ["anchor-tag", "k: [&a !!str\n]"],
  ["anchor-colon", "k: {&a\n: x}"],
  ["explicit", "k: {? !!str\n: x}"],
  ["deep", "a:\n  b:\n    [!!str\n]"],
  ["nested-flow", "k: [[!!str\n]]"],
  ["comment", "k: [!!str\n# c\n]"],
  ["blank", "k: [!!str\n\n]"],
  ["already-indented", "k: [!!str\n ]"],
  ["root", "[!!str\n]"],
  ["root-colon", "{!!str\n:x}"],
  ["explicit-block", "? k\n: [!!str\n]"],
  ["single-quote-colon", "- - {a: 'a\n   b', !!str\n:x}"],
  ["colon-at-parent", '- - {a: "a\n   b", !!str\n  :x}'],
];

const refused = [
  ["short-quote", '- - {a: "a\n  b", !!str\n}'],
  ["short-quote-colon", '- - {a: "a\n  b", !!str\n:x}'],
  ["int", "k: [!!int\n]"],
  ["bool", "k: [!!bool\n]"],
  ["float", "k: [!!float\n]"],
  ["seq-colon", "k: [!!str\n:x]"],
  ["value-colon", "k: {a: !!str\n:x}"],
  ["plain", "k: [!!str\nx]"],
  ["tab", "k: [!!str\n\t]"],
  ["next-anchor", "k: [!!str\n&a\n]"],
  ["complex", "? [!!str\n]\n: 1"],
  ["short-explicit", '? "a\nb"\n: [!!str\n]'],
];

const verbatim = (source) => source.replaceAll(/!!(\w+)/g, "!<tag:yaml.org,2002:$1>");
const cases = [];

function add(name, source, refused) {
  let expected = null;
  try {
    expected = load(source);
  } catch {
    expected = null;
  }
  if ((expected === null) !== refused) {
    throw new Error(`${name}: js-yaml ${refused ? "accepts" : "rejects"} ${JSON.stringify(source)}`);
  }
  cases.push({ name, source, expected });
}

for (const [name, source] of accepted) {
  add(`accept-${name}`, source, false);
  if (source.includes("!!")) add(`accept-${name}-verbatim`, verbatim(source), false);
}
for (const [name, source] of refused) {
  add(`refuse-${name}`, source, true);
  if (source.includes("!!")) add(`refuse-${name}-verbatim`, verbatim(source), true);
}

process.stdout.write(`${JSON.stringify(cases, null, 2)}\n`);
