import { createRequire } from 'node:module';

const require = createRequire(new URL('../../../../../web/package.json', import.meta.url));
const { version } = require('js-yaml/package.json');
if (version !== '5.5.0') throw new Error(`Expected js-yaml 5.5.0, got ${version}`);
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
  ['break-tag-seq-colon-plain', '[!!str\n:x]'],
  ['break-tag-map-value-colon', '{a: !!str\n:x}'],
  ['break-tag-shallow-second-break', 'k: [!!str\n,\nx]'],
  ['break-tag-shallow-tab', 'k: [!!str\n\t]'],
  ['break-tag-shallow-comma-tab', 'k: [!!str\n,\tx]'],
  ['tab-tag-quoted-entry', 'k: [!!str\t"a"]'],
  ['tab-tag-nested-flow', 'k: [!!seq\t[a,\n b]]'],
  ['shallow-close-after-comment', 'k: [a,\t#c\n]'],
  ['shallow-close', 'k: [a,\n]'],
  ['shallow-plain-continuation', 'k: [a\nb]'],
  ['shallow-double-quoted-continuation', 'k: ["a\nb"]'],
  ['shallow-indented-root-entry', '# c\n  [a,\n b]'],
  ['quoted-indent-nested-entry-map', '- - {a: "a\n  b", !!str\n}'],
  ['quoted-indent-nested-entry-seq-map-crlf', '- - [{a: "a\r\n  b", !!str\r\n}]'],
  ['quoted-indent-nested-entry-map-seq-crlf', '- - {a: ["a\r\n  b", !!str\r\n]}'],
  ['quoted-indent-value-map-single-anchor', "outer:\n  k: {a: 'a\n  b', &n\n}"],
  ['quoted-indent-value-seq-map-cr', 'outer:\n  k: [{a: "a\r  b", !!str\r}]'],
  ['quoted-indent-value-map-seq', 'outer:\n  k: {a: ["a\n  b", !!str\n]}'],
  ['quoted-indent-nested-entry-map-spaced', '- - {a: "a\n  b", !!str\n }'],
  ['quoted-indent-nested-entry-seq-map-spaced', '- - [{a: "a\n  b", !!str\n }]'],
  ['quoted-indent-nested-entry-map-seq-spaced-crlf', '- - {a: ["a\r\n  b", !!str\r\n ]}'],
  ['quoted-indent-value-map-spaced-crlf', 'outer:\n  k: {a: "a\r\n  b", !!str\r\n }'],
  ['quoted-indent-value-seq-map-spaced-cr', 'outer:\n  k: [{a: "a\r  b", !!str\r }]'],
  ['quoted-indent-value-map-seq-spaced-cr', 'outer:\n  k: {a: ["a\r  b", !!str\r ]}'],
  ['quoted-indent-explicit-key-seq', '? "a\nb"\n: [!!str\n]'],
  ['quoted-indent-explicit-key-map-colon', '? "a\nb"\n: {!!str\n:x}'],
  ['quoted-indent-nested-entry-map-tag-anchor-crlf', "- - {a: 'a\r\n  b', !!str &n\r\n}"],
  ['quoted-indent-value-map-tag-anchor-crlf', "outer:\r\n  k: {a: 'a\r\n  b', !!str &n\r\n}"],
  ['quoted-indent-nested-entry-map-tag-anchor-spaced-crlf', "- - {a: 'a\r\n  b', !!str &n\r\n }"],
  ['quoted-indent-value-map-tag-anchor-spaced-crlf', "outer:\r\n  k: {a: 'a\r\n  b', !!str &n\r\n }"],
  ['quoted-indent-nested-entry-map-null-crlf', '- - {a: "a\r\n  b", !!null\r\n}'],
  ['quoted-indent-value-map-anchor-cr', "outer:\r  k: {a: 'a\r  b', &n\r}"],
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
  ['escaped-cr-then-tab', 'project: ["a\\\r b"\t]'],
  ['escaped-crlf-then-tab', 'project: ["a\\\r\n b"\t]'],
  ['break-tag-key-colon-plain', '{!!str\n:x}'],
  ['verbatim-break-tag-key-colon-plain', '{!<tag:yaml.org,2002:str>\n:x}'],
  ['break-anchor-key-colon-plain', '{&a\n:x}'],
  ['break-tag-explicit-key-colon-plain', '{? !!str\n:x}'],
  ['tab-continuation-at-indent', 'k: [a,\n \tb]'],
  ['continuation-at-flow-indent', 'k:\n  [a,\n b]'],
  ['tab-tag-multiline-plain', 'k: [!!str\ta\n b]'],
  ['tab-tag-multiline-quoted', 'k: [!!str\t"a\n b"]'],
  ['tab-tag-anchor-break', 'k: [!!str\t&x\n ]'],
];
// Keep the quoted continuation shallow while varying the later empty key.
for (const [context, prefix, suffix] of [
  ['compact-map', '- - {a: ', '}'],
  ['compact-seq-map', '- - [{a: ', '}]'],
  ['block-map', 'outer:\n  k: {a: ', '}'],
  ['block-seq-map', 'outer:\n  k: [{a: ', '}]'],
]) {
  for (const [style, quote] of [['double', '"'], ['single', "'"]]) {
    for (const [ending, br] of [['lf', '\n'], ['cr', '\r'], ['crlf', '\r\n']]) {
      for (const [property, token] of [['tag', '!!str'], ['anchor', '&n']]) {
        for (const indent of [2, 3]) {
          const name = `${context}-${style}-${ending}-${property}-${indent}`;
          const source = (depth) => `${prefix}${quote}a${br}${' '.repeat(depth)}b${quote}, ${token}${br}${' '.repeat(indent)}:x${suffix}`;
          refusals.push([`quoted-indent-colon-${name}`, source(2)]);
          accepted.push([`quoted-indent-colon-${name}`, source(3)]);
        }
      }
    }
  }
}
// Ordinary quoted continuations: one column short of js-yaml's depth, then at it.
for (const [context, prefix, suffix, depth] of [
  ['block-map-seq', 'k: [', ']', 1],
  ['nested-map-seq', 'outer:\n  k: [', ']', 3],
  ['compact-seq', '- - [', ']', 3],
  ['nested-map-map', 'outer:\n  k: {a: ', '}', 3],
]) {
  for (const [style, quote] of [['double', '"'], ['single', "'"]]) {
    for (const [ending, br] of [['lf', '\n'], ['cr', '\r'], ['crlf', '\r\n']]) {
      const forms = [
        ['plain', (pad) => `a${br}${pad}b`],
        ['blank', (pad) => `a${br}${br}${pad}b`],
        ['tab-blank', (pad) => `a${br}\t${br}${pad}b`],
        ['spaces-tab', (pad) => `a${br}${pad}\tb`],
        ['closing', (pad) => `a${br}${pad}`],
      ];
      if (style === 'double') forms.push(['escaped-break', (pad) => `a\\${br}${pad}b`]);
      for (const [form, body] of forms) {
        const name = `quoted-continuation-${context}-${style}-${ending}-${form}`;
        const source = (indent) => `${prefix}${quote}${body(' '.repeat(indent))}${quote}${suffix}`;
        refusals.push([name, source(depth - 1)]);
        // saphyr rejects a column-0 tab-only line in a quoted scalar; GRE-765 owns that accept.
        if (form !== 'tab-blank') accepted.push([name, source(depth)]);
      }
    }
  }
}
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
