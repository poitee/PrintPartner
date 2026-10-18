import { createRequire } from 'node:module';

const require = createRequire(new URL('../../../../../web/package.json', import.meta.url));
const { version } = require('js-yaml/package.json');
if (version !== '5.4.3') throw new Error(`Expected js-yaml 5.4.3, got ${version}`);
const { load } = require('js-yaml');
const refusals = [
  ['block-literal-in-seq', 'project: [|]'],
  ['block-folded-in-seq', 'project: [>]'],
  ['tagged-literal-in-seq', 'project: [!!str |]'],
  ['tagged-folded-in-seq', 'project: [!!str >]'],
  ['tagged-folded-in-map', '{a: !!str >\n  hi}'],
  ['tagged-literal-in-map', '{a: !!str |\n  hi}'],
  ['literal-map-value', '{a: |}'],
  ['literal-quoted-key-value', '{"a":|}'],
  ['literal-explicit-key', '{? |}'],
  ['literal-after-comma', '[a, |b]'],
  ['folded-after-comma', '[a, >b]'],
  ['literal-after-anchor', '[&x |]'],
  ['literal-in-nested-seq', '[[|]]'],
  ['tab-tag-seq', 'project: !!seq\t[]'],
  ['tab-tag-map', 'project: !!map\t{}'],
  ['tab-tag-seq-entry', '- !!seq\t[]'],
  ['tab-anchor-seq', 'project: &x\t[]'],
  ['tab-after-colon', 'project:\t[]'],
  ['tab-after-dash', '-\t[x]'],
  ['tab-after-comma', 'project: [a,\tb]'],
  ['tab-after-open', 'project: [\ta]'],
  ['tab-after-entry-tag', 'project: [!!str\ta]'],
  ['tab-after-quoted', 'project: ["a"\t]'],
  ['tab-after-nested', 'project: [[]\t]'],
  ['tab-in-flow-map', 'project: {a:\tb}'],
  ['tab-in-compact-map', '- a: [x,\ty]'],
  ['break-tag-int', '[!!int\n1]'],
  ['break-tag-seq', '[!!seq\n[]]'],
  ['break-tag-map-value', '{a: !!str\nx}'],
  ['break-tag-nested', '[[!!int\n1]]'],
  ['break-tag-anchor', '[!!str &a\n1]'],
  ['break-tag-then-anchor', '[!!str\n&a x]'],
  ['break-tag-double-quoted', '[!!str\n"x"]'],
  ['break-tag-single-quoted', "[!!str\n'x']"],
  ['break-tag-crlf', '[!!int\r\n1]'],
  ['break-tag-seq-colon', '[!!str\n: x]'],
  ['break-tag-blank', 'project: [!!int\n\n 1]'],
  ['break-tag-comment', 'project: [!!int\n  # c\n 1]'],
  ['break-tag-map-shallow', 'project: [!!int\n 1]'],
  ['break-tag-flow-map-shallow', 'project: {a: !!str\n x}'],
  ['break-tag-seq-entry', '- [!!int\n 1]'],
  ['break-tag-nested-seq-entry', '- - [!!int\n   1]'],
  ['break-tag-indented-root', '# c\n  [!!int\n  1]'],
  ['break-tag-after-document-start', '---\n  [!!int\n  1]'],
  ['break-tag-inline-document-start', '--- [!!int\n1]'],
  ['break-anchor', '[&a\n1]'],
];
const accepted = [
  ['plain-pipe-inside', '[a |b]'],
  ['plain-pipe-suffix', '[a, b|]'],
  ['plain-pipe-map-value', '{a: b |}'],
  ['plain-colon-pipe', '{a:|}'],
  ['double-quoted-pipe', '["|"]'],
  ['single-quoted-folded', "['>']"],
  ['quoted-pipe-entry', '[a, "|b"]'],
  ['quoted-indicators-map', '{"|": ">"}'],
  ['tagged-quoted-pipe', 'project: [!!str "|"]'],
  ['block-literal-value', 'project: |\n  [x]\n'],
  ['block-folded-value', 'project: >\n  {a}\n'],
  ['space-tag-seq', 'project: !!seq []'],
  ['space-tag-map', 'project: !!map {}'],
  ['break-tag-seq-value', 'project: !!seq\n  []'],
  ['tab-root-tag-seq', '!!seq\t[]'],
  ['tab-root-comma', '[a,\tb]'],
  ['tab-root-nested-tag', '[!!seq\t[]]'],
  ['tab-tag-plain', 'project: !!str\tx'],
  ['tab-tag-quoted', "project: !!str\t'x'"],
  ['tab-plain-trailing', 'project: [a\t]'],
  ['tab-plain-inside', 'project: [a\tb]'],
  ['tab-double-quoted-inside', 'project: ["a\tb"]'],
  ['tab-after-close', 'project: [a, b]\t'],
  ['tab-before-comment', 'project: [a]\t# c'],
  ['tab-in-comment', 'project: [a, # c\t\n  b]'],
  ['tab-deeper-line-open', 'a:\n [\tx]'],
  ['tab-deeper-line-comma', 'a:\n  [x,\ty]'],
  ['tab-plain-key', 'project\t: [x]'],
  ['tab-quoted-key', '"project"\t: [x]'],
  ['tab-previous-line', 'a: 1\t# c\nb: [x]'],
  ['tab-after-multiline-quote', 'project: ["a\n b"\t]'],
  ['tab-before-break', 'project:\t[\n  a]'],
  ['tab-tag-before-break', 'project: !!seq\t[\n  ]'],
  ['tab-before-flow-comment', 'project: [a,\t# c\n  b]'],
  ['break-tag-deeper', '[!!int\n 1]'],
  ['break-anchor-deeper', '[&a\n 1]'],
  ['break-tag-anchor-deeper', '[!!str &a\n 1]'],
  ['break-tag-close', '[!!str\n]'],
  ['break-tag-comma', '[!!str\n, x]'],
  ['break-tag-map-key-colon', '{!!str\n: x}'],
  ['break-tag-map-value-close', '{a: !!str\n}'],
  ['break-tag-map-value-comma', '{a: !!str\n, b: c}'],
  ['break-tag-map-deep', 'project: [!!int\n  1]'],
  ['break-tag-value-line', 'project:\n  [!!int\n  1]'],
  ['break-tag-flow-map-deep', 'project: {a: !!str\n  x}'],
  ['break-tag-second-entry', 'project: [x, !!str\n  y]'],
  ['break-tag-indented-first-line', '  [!!int\n  1]'],
  ['break-tag-root-tag-line', '!!seq\n  [!!int\n  1]'],
  ['break-tag-after-comment', '[!!str\n# c\n x]'],
  ['break-tag-after-blank', '[!!str\n\n x]'],
  ['break-tag-indented-root-deeper', '# c\n  [!!int\n   1]'],
  ['break-tag-inline-document-start-deeper', '--- [!!int\n 1]'],
  ['break-tag-trailing-comment', 'project: [!!int # c\n  1]'],
  ['break-tag-trailing-space', '{a: !!str \n  x}'],
  ['break-tag-seq-entry-deep', '- [!!int\n  1]'],
  ['break-tag-nested-seq-entry-deep', '- - [!!int\n    1]'],
  ['break-tag-crlf-deeper', '[!!str\r\n 1]'],
  ['break-tag-cr-deeper', '[!!str\r 1]'],
  ['break-entry-comma', '[a\n, !!str\n b]'],
  ['verbatim-space-tag-seq', 'project: !<tag:yaml.org,2002:seq> []'],
  ['verbatim-tab-root-tag-seq', '!<tag:yaml.org,2002:seq>\t[]'],
  ['verbatim-tab-tag-plain', 'project: !<tag:yaml.org,2002:str>\tx'],
  ['verbatim-break-tag-deeper', '[!<tag:yaml.org,2002:int>\n 1]'],
  ['verbatim-break-tag-map-deep', 'project: [!<tag:yaml.org,2002:int>\n  1]'],
  ['verbatim-break-tag-close', '[!<tag:yaml.org,2002:str>\n]'],
];
const verbatim = (source) => source.replace(/!!(\w+)/g, '!<tag:yaml.org,2002:$1>');
const cases = [];
function add(name, source, refused) {
  let expected;
  try {
    expected = load(source);
  } catch {
    expected = null;
  }
  if ((expected === null) !== refused) {
    throw new Error(`${name}: js-yaml ${refused ? 'accepts' : 'rejects'} ${JSON.stringify(source)}`);
  }
  cases.push({ name, source, expected });
}
for (const [group, refused] of [[refusals, true], [accepted, false]]) {
  for (const [name, source] of group) {
    add(`${refused ? 'refuse' : 'accept'}-${name}`, source, refused);
    if (refused && source.includes('!!')) add(`refuse-${name}-verbatim`, verbatim(source), true);
  }
}
process.stdout.write(`[\n${cases.map((entry) => `  ${JSON.stringify(entry)}`).join(',\n')}\n]\n`);
