import { createRequire } from "node:module";

const require = createRequire(new URL("../../../../../web/package.json", import.meta.url));
const { version } = require("js-yaml/package.json");
if (version !== "5.4.3") throw new Error(`Expected js-yaml 5.4.3, got ${version}`);
const { load } = require("js-yaml");

const cases = [
  ["block-colon", "a:\n  []\n\n: ]"],
  ["block-colon-crlf", "a:\r\n  []\r\n\r\n: ]"],
  ["block-colon-cr", "a:\r  []\r\r: ]"],
  ["block-colon-map", "a:\n  {}\n\n: }"],
  ["block-colon-comma", "a:\n  []\n\n: ,"],
  ["block-colon-plain", "a:\n  []\n\n: x"],
  ["same-line", "a: ]"],
  ["empty-key", ": ]"],
  ["root", "]"],
  ["sequence", "- ]"],
  ["sequence-colon", "- ] : x"],
  ["key", "]: x"],
  ["comment", "a: ] # c"],
  ["hash-glued", "a: ]#c"],
  ["quote", 'a: ]"b'],
  ["backslash", "a: ]\\b"],
  ["sentinel", "a: ]\uE000"],
  ["multiline", "a: ]\n  more"],
  ["multiline-blank", "a: ]\n\n  more"],
  ["multiline-key", "a: ]\n  more\nb: 1"],
  ["folded-colon-text", "a: ]\n  more:x"],
  ["explicit", "? ]\n: x"],
  ["explicit-more", "? ]\n  more\n: x"],
  ["nested", "a:\n  b: ]\n    more\n  c: 1"],
  ["tab-after-colon", "a:\t]"],
  ["tag-str", "!!str ]"],
  ["flow-close", "{a: ]}"],
  ["bad-indent", "a:\n  []\n\n  : ]"],
  ["implicit-multiline-key", "]\n  more: x"],
  ["value-colon-continued", "a: ]\n  more: x"],
  ["same-line-colon", "a: ] : x"],
  ["tab-indent", "a: ]\n\tmore"],
  ["flow-extra", "a: []]"],
  ["second-document", "]\n---\n]"],
  ["tag-int", "!!int ]"],
  ["explicit-same-line", "? ] : x"],
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
