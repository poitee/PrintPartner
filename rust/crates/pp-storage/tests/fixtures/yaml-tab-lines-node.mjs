import { createRequire } from 'node:module';

const require = createRequire(new URL('../../../../../web/package.json', import.meta.url));
const { version } = require('js-yaml/package.json');
if (version !== '5.4.3') throw new Error(`Expected js-yaml 5.4.3, got ${version}`);
const { load } = require('js-yaml');
// `Q` is the quote character and `@` the whitespace-only line.
const quotedTemplates = [
  ['map', 'a: Qx\n@\n  yQ'],
  ['map-sentinel', 'a: Qx\n@\n  \\uE000 \uE000Q'],
  ['map-two-lines', 'a: Qx\n@\n@\n  yQ'],
  ['map-trailing-tabs', 'a: Qx\t\n@\n  y\tQ'],
  ['map-close', 'a: Qx\n@\n  Q\nb: z'],
  ['map-dedent', 'a: Qx\n@\ny Q'],
  ['nested-map', 'outer:\n  a: Qx\n@\n    yQ'],
  ['value-next-line', 'a:\n  Qx\n@\n  yQ'],
  ['sequence', '- Qx\n@\n  yQ'],
  ['nested-sequence', '- - Qx\n@\n    yQ'],
  ['root', 'Qx\n@\n yQ'],
  ['flow-sequence', 'k: [Qa\n@\n bQ]'],
  ['flow-map', 'outer:\n  k: {a: Qa\n@\n   bQ}'],
  ['nested-flow-sequence', '- - [Qa\n@\n   bQ]'],
  ['flow-dedent', 'outer:\n  k: [Qa\n@\n b, c]'],
];
const quotedLines = [
  ['tab', '\t'],
  ['tab-tab', '\t\t'],
  ['space-tab-space', ' \t '],
  ['spaces-tab', '  \t'],
];
const lineEndingTemplates = new Set(['map', 'nested-sequence', 'flow-map']);
// `@` is the whitespace before a comment line.
const commentTemplates = [
  ['plain-deeper', 'a: x\n@# c\n  y'],
  ['plain-sentinel', 'a: x\n@# c\n  "\\uE000"'],
  ['plain-sibling', 'a: x\n@# c\nb: y'],
  ['plain-eof', 'a: x\n@# c'],
  ['plain-comment-deeper', 'a: x # c\n@# d\n  y'],
  ['nested-plain-deeper', 'outer:\n  a: x\n@# c\n    y'],
  ['nested-plain-sibling', 'outer:\n  a: x\n@# c\n  b: y'],
  ['sequence-deeper', '- x\n@# c\n  y'],
  ['sequence-sibling', '- x\n@# c\n- y'],
  ['quoted-deeper', 'a: "x"\n@# c\n  y'],
  ['inside-quoted', 'a: "x\n@# c\n  y"'],
  ['before-nested-map', 'a:\n@# c\n  b: 1'],
  ['literal-header', 'a: |\n@# c\n'],
  ['folded-header', 'a: >\n@# c\nb: 1'],
  ['keep-header-blank', 'a: |+\n\n@# c\n'],
  ['explicit-header', 'a: |2\n@# c\n'],
  ['literal-blank-header', 'a: |\n\n@# c\nb: z'],
  ['folded-space-blank-header', 'a: >\n    \n@# c\n'],
  ['sequence-literal-blank-header', '- |\n\n@# c\n'],
  ['explicit-blank-header', 'a: |2\n\n@# c\n'],
  ['nested-literal-header', 'outer:\n  a: |\n@# c\n'],
  ['literal-end', 'a: |\n  x\n@# c\n'],
  ['literal-deeper', 'a: |\n  x\n@# c\n  y\n'],
  ['flow-sequence', 'a: [x,\n@# c\n  y]'],
  ['flow-plain-deeper', 'k: [x\n@# c\n  y]'],
  ['flow-map-plain-deeper', 'k: {a: x\n@# c\n  y}'],
  ['root', '@# c\na: 1'],
];
const commentLines = [
  ['tab', '\t'],
  ['space-tab', ' \t'],
  ['tab-tab', '\t\t'],
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
for (const [ending, separator] of [['lf', '\n'], ['cr', '\r'], ['crlf', '\r\n']]) {
  for (const [quoteName, quote] of [['double', '"'], ['single', "'"]]) {
    for (const [lineName, line] of quotedLines) {
      for (const [name, template] of quotedTemplates) {
        if (ending !== 'lf' && (!lineEndingTemplates.has(name) || lineName !== 'tab')) continue;
        const source = template.replaceAll('Q', quote).replaceAll('@', line).replaceAll('\n', separator);
        add(`${ending}-${quoteName}-${lineName}-${name}`, source);
      }
    }
  }
  for (const [lineName, line] of commentLines) {
    for (const [name, template] of commentTemplates) {
      if (ending !== 'lf' && (name !== 'plain-deeper' || lineName !== 'tab')) continue;
      add(`${ending}-comment-${lineName}-${name}`, template.replaceAll('@', line).replaceAll('\n', separator));
    }
  }
}
process.stdout.write(`[\n${cases.map((entry) => `  ${JSON.stringify(entry)}`).join(',\n')}\n]\n`);
