import { createRequire } from "node:module";

const require = createRequire(new URL("../../../../../web/package.json", import.meta.url));
const { version } = require("js-yaml/package.json");
if (version !== "5.5.0") throw new Error(`Expected js-yaml 5.5.0, got ${version}`);
const { load } = require("js-yaml");

// A tab that introduces a block indicator is not indentation. A tab before a
// plain value, or between a key and its colon, is separation and still loads.
const cases = [
  ["tab-before-sequence", "a:\n  \t- x"],
  ["tab-before-sequence-crlf", "a:\r\n  \t- x"],
  ["tab-before-sequence-cr", "a:\r  \t- x"],
  ["tab-between-dash-colon", "- \t:"],
  ["tab-between-dash-colon-crlf", "- \t:\r\n"],
  ["tab-before-tag-key", "- :\t!!str :\t"],
  ["tab-before-tag-key-crlf", "- :\t!!str :\t\r\n"],
  ["tab-before-explicit", "a:\n  \t? x"],
  ["tab-before-plain-key", "a:\n  \tb: 1"],
  ["tab-between-dash-colon-value", "- \t: x"],
  ["tab-between-dashes", "- \t- x"],
  ["tab-before-quoted-key", "a:\n  \t\"k\": v"],
  ["tab-before-nested-key", "- :\tx : y"],
  ["deeper-tab-sequence", "a:\n    \t- x"],
  ["sequence-tab-sequence", "-\n  \t- x"],
  ["empty-key-tab-sequence", ":\t- x"],
  ["tab-before-flow-key", "a:\n  \t[a]: b"],
  ["tab-before-anchor-key", "a:\n  \t&a b: 1"],
  ["tab-before-plain", "a:\n  \tx"],
  ["tab-before-dash-word", "a:\n  \t-x"],
  ["tab-before-flow-seq", "a:\n  \t[]"],
  ["tab-before-flow-map", "a:\n  \t{}"],
  ["tab-before-quoted", "a:\n  \t\"q\""],
  ["tab-before-block-scalar", "a:\n  \t|\n    x"],
  ["tab-before-tag-value", "a:\n  \t!!str x"],
  ["dash-tab-plain", "- \tx"],
  ["dash-tab-plain-tight", "-\tx"],
  ["dash-tab-break-plain", "- \t\n  x"],
  ["space-before-nested-tag", "- : !!str :\t"],
  ["tab-before-tagged-plain", "- :\t!!str x"],
  ["block-colon-tab-plain", "a:\tx"],
  ["block-colon-tab-plain-colon", "a:\tx:y"],
  ["tab-comment-then-sequence", "a:\n  \t# c\n  - x"],
  ["tab-between-key-and-colon", "a:\n  b\t: 1"],
  ["quoted-tab-colon-sequence", "\"k\"\t:\n  - x"],
  ["plain-tab-colon", "a\t: b"],
  ["compact-tab-colon", "- b\t: 1"],
  ["plain-continuation", "a:\n  \thello\n  world"],
  ["empty-key-tab-plain", ":\tx"],
  ["dash-colon-tab-plain", "- :\tx"],
  ["dash-tab-end", "- \t"],
  ["colon-tab-end", "a:\t"],
  ["dash-colon-tab-end", "- :\t"],
  ["colon-tab-break-sequence", "a: \t\n  - x"],
  ["dash-tab-block-scalar", "- \t|\n  x"],
  ["tab-before-anchor", "a:\n  \t&a x"],
  ["flow-colon-tab", "{a:\tx}"],
  ["ordinary-sequence", "a:\n  - x"],
  ["colon-in-plain", "a:\n  \thello:world"],
  ["spaces-tab-plain", "a:\n  \t  x"],
];

const encoded = cases.map(([name, source]) => {
  let expected = null;
  try {
    expected = load(source);
  } catch {
    expected = null;
  }
  return { name, source, expected };
});

process.stdout.write(`${JSON.stringify(encoded, null, 2)}\n`);
