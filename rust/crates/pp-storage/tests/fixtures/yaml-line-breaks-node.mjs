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
];
const cases = [];
for (const [ending, separator] of [['cr', '\r'], ['crlf', '\r\n'], ['lf', '\n']]) {
  for (const [name, template] of templates) {
    const source = template.replaceAll('\n', separator);
    let expected;
    try {
      expected = load(source);
    } catch {
      expected = null;
    }
    cases.push({ name: `${ending}-${name}`, source, expected });
  }
}
process.stdout.write(`${JSON.stringify(cases, null, 2)}\n`);
