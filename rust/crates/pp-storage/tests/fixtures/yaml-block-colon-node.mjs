import { createRequire } from "node:module";

const require = createRequire(new URL("../../../../../web/package.json", import.meta.url));
const { version } = require("js-yaml/package.json");
if (version !== "5.5.0") throw new Error(`Expected js-yaml 5.5.0, got ${version}`);
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
  // GRE-963 class 1: the indicator after a comment line, and its controls.
  ["comment-line-close", "a:\n# c\n  ]"],
  ["comment-indented-brace", "a:\n # c\n  }"],
  ["comment-line-comma", "a:\n# c\n  , y]"],
  ["comment-line-trailing", "a:\n# c\n  ] # d"],
  ["comment-line-open", "a:\n# c\n  ["],
  ["comment-line-plain", "a:\n# c\n  x]"],
  ["next-line", "a:\n  ]"],
  ["next-line-more", "a:\n  ]\n  x"],
  ["same-line-brace", "a: }"],
  ["same-line-comma", "a: , b"],
  ["sequence-comma", "- ,"],
  ["nested-sequence", "a:\n  - ]"],
  ["key-brace", "}: b"],
  ["key-comma", ",: b"],
  ["inner-close", "a: x]"],
  ["inner-brace-comma", "a: x,y}"],
  ["quoted-close", 'a: "]"'],
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
