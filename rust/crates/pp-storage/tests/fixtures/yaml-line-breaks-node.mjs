import { createRequire } from 'node:module';

const require = createRequire(new URL('../../../../../web/package.json', import.meta.url));
const { version } = require('js-yaml/package.json');
if (version !== '5.4.3') throw new Error(`Expected js-yaml 5.4.3, got ${version}`);
const { load } = require('js-yaml');
const templates = [
  ['plain-continuation', 'project: prefix\n  "\\uE000"'],
  ['plain-blank', 'project: prefix\n\n  "\\uE000"'],
  ['plain-space-blanks', 'project: prefix\n  \n    \n  "\\uE000uD800\\uE000"'],
  ['plain-single-quote', "project: prefix\n\n  '\\uE000'"],
  ['plain-literal-sentinel', 'project: prefix\n\n  "\uE000uD800\uE000"'],
  ['single-quoted-blank', "project: 'prefix\n\n  \\uE000 \uE000'"],
  ['double-quoted-blank', 'project: "prefix\n\n  \\uE000 \uE000"'],
  ['double-quoted-following-node', 'project: "prefix\n\n  \\uE000"\nnext: "\\uE000"'],
  ['literal-block-blank', 'project: |\n  prefix\n\n  "\\uE000 \uE000"\n'],
  ['folded-block-blank', 'project: >\n  prefix\n\n  "\\uE000 \uE000"\n'],
  ['comment-after-blank', 'project: prefix\n\n# "\\uE000"\nnext: "\\uE000"'],
  ['comment-ends-plain', 'project: prefix\n\n  # comment\n  "\\uE000"'],
  ['dedented-quoted-node', 'project: prefix\n\nnext: "\\uE000"'],
  ['verbatim-tag-blank', 'project: !<tag:yaml.org,2002:str> prefix\n\n  "\\uE000"'],
  ['escaped-break', 'project: "prefix\\\n  tail"'],
  ['escaped-break-blank', 'project: "prefix\\\n\n  tail"'],
  ['escaped-break-blanks', 'project: "prefix\\\n\n\n  tail"'],
  ['escaped-break-space-blank', 'project: "prefix\\\n  \n  tail"'],
  ['escaped-break-tab-blank', 'project: "prefix\\\n\t\n  tail"'],
  ['escaped-break-space-before', 'project: "prefix \\\n\n  tail"'],
  ['escaped-break-repeated', 'project: "prefix\\\n\n  mid\\\n\n  tail"'],
  ['escaped-break-comment-lookalike', 'project: "prefix\\\n\n  # tail"'],
  ['escaped-break-escape', 'project: "prefix\\\n\n  \\ttail"'],
  ['escaped-break-sentinel', 'project: "prefix\\\n\n  \\uE000 \uE000"'],
  ['escaped-break-close', 'project: "prefix\\\n  \n  "\nnext: tail'],
  ['escaped-break-sequence', '- "prefix\\\n\n  tail"'],
  ['escaped-break-flow', '{project: "prefix\\\n\n  tail"}'],
  ['escaped-break-dedent', 'project: "prefix\\\n\ntail"'],
  ['escaped-break-flow-dedent', 'project: {next: "prefix\\\n\ntail"}'],
  ['escaped-break-close-dedent', 'project: "prefix\\\n"'],
  ['escaped-break-blank-close-dedent', 'project: "prefix\\\n\n"'],
  ['escaped-break-value-next-line', 'project:\n "prefix\\\n\n tail"'],
  ['escaped-break-sequence-indented', '- "prefix\\\n\n tail"'],
  ['escaped-break-sequence-dedent', '- "prefix\\\n\ntail"'],
  ['escaped-break-sequence-single-dedent', '- "prefix\\\ntail"'],
  ['escaped-break-nested-sequence-dedent', 'outer:\n  - "prefix\\\n  tail"'],
  ['escaped-break-nested-sequence-tab-blank-dedent', 'outer:\n  - "prefix\\\n\t\n  tail"'],
  ['double-quoted-nested-sequence-dedent', 'outer:\n  - "prefix\n\n  tail"'],
  ['single-quoted-nested-sequence-dedent', "outer:\n  - 'prefix\n  tail'"],
  ['escaped-backslash-blank', 'project: "prefix\\\\\n\n  tail"'],
  ['escaped-space-blank', 'project: "prefix\\ \n\n  tail"'],
  ['single-quoted-backslash-blank', "project: 'prefix\\\n\n  tail'"],
];
const tabLines = [
  ['tab', '\t'],
  ['tab-space', '\t '],
  ['space-tab', ' \t'],
  ['tab-spaces', '\t  '],
  ['spaces-tab', '  \t'],
  ['space-tab-space', ' \t '],
  ['tab-space-tab', '\t \t'],
  ['space-tab-space-tab-space', ' \t \t '],
];
const tabTemplates = [
  ['plain-map', 'a: x\n@\n  "\\uE000"'],
  ['plain-sequence', '- x\n@\n  "\\uE000"'],
  ['plain-blank-run', 'a: x\n  \n@\n    \n  "\\uE000"'],
  ['plain-following-node', 'a: x\n@\nb: "\\uE000"'],
  ['plain-eof', 'a: x\n@'],
  ['flow-map', '{a: x\n@\n  "\\uE000"}'],
  ['flow-sequence', '[x\n@\n  "\\uE000"]'],
  ['literal-leading', 'a: |\n@\n  "\\uE000"\n'],
  ['folded-leading', 'a: >\n@\n  "\\uE000"\n'],
  ['literal-content', 'a: |\n  x\n@\n  "\\uE000"\n'],
  ['folded-content', 'a: >\n  x\n@\n  "\\uE000"\n'],
  ['literal-explicit', 'a: |2\n@\n  "\\uE000"\n'],
  ['folded-explicit', 'a: >2\n@\n  "\\uE000"\n'],
];
const cases = [];
function add(name, source) {
  let expected;
  try {
    expected = load(source);
  } catch {
    expected = null;
  }
  cases.push({ name, source, expected });
}
for (const [name, source] of [
  ['tab-only-blank', 'a: x\n\t\n  "\\uE000"'],
  ['tab-space-blank', 'a: x\n\t  \n  "\\uE000"'],
  ['seq-tab-blank', '- x\n\t\n  "\\uE000"'],
  ['mixed-blank-run', 'a: x\n  \n\t\n    \n  "\\uE000"'],
  ['tab-only-blank-crlf', 'a: x\r\n\t\r\n  "\\uE000"'],
]) {
  add(name, source);
}
for (const [ending, separator] of [['cr', '\r'], ['crlf', '\r\n'], ['lf', '\n']]) {
  for (const [name, template] of templates) {
    const source = template.replaceAll('\n', separator);
    add(`${ending}-${name}`, source);
  }
  for (const [whitespaceName, whitespace] of tabLines) {
    for (const [name, template] of tabTemplates) {
      const source = template.replace('@', whitespace).replaceAll('\n', separator);
      add(`${ending}-${whitespaceName}-${name}`, source);
    }
  }
}
process.stdout.write(`[\n${cases.map((entry) => `  ${JSON.stringify(entry)}`).join(',\n')}\n]\n`);
