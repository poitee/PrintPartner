import { createRequire } from 'node:module';

const require = createRequire(new URL('../../../../../web/package.json', import.meta.url));
const { version } = require('js-yaml/package.json');
if (version !== '5.4.3') throw new Error(`Expected js-yaml 5.4.3, got ${version}`);
const { load } = require('js-yaml');
// `H` is the block scalar header and `@` the line under test.
const headers = [
  ['literal-1', '|1'],
  ['literal-2', '|2'],
  ['folded-2-strip', '>2-'],
  ['keep-2', '|+2'],
  ['folded-keep-2', '>+2'],
  ['folded-1', '>1'],
  ['literal-3', '|3'],
];
const templates = [
  ['map-eof', 'a: H\n@\n'],
  ['map-sibling', 'a: H\n@\nb: z\n'],
  ['map-blank-sibling', 'a: H\n\n@\nb: z\n'],
  ['map-two-lines', 'a: H\n@\n@\nb: z\n'],
  ['map-no-final-break', 'a: H\n@'],
  ['map-shallow-content', 'a: H\n  # x\n@\nb: z\n'],
  ['map-content-before', 'a: H\n    x\n@\nb: z\n'],
  ['map-content-after', 'a: H\n@\n    x\nb: z\n'],
  ['sequence', '- H\n@\n- z\n'],
  ['nested-map', 'outer:\n  a: H\n@\n  b: z\n'],
  ['next-line-header', 'a:\n  H\n@\nb: z\n'],
  ['root', 'H\n@\n'],
];
const lines = [
  ['comment-col0', '# c'],
  ['comment-1', ' # c'],
  ['comment-2', '  # c'],
  ['comment-3', '   # c'],
  ['tab', '\t'],
  ['tab-spaces', '\t    '],
  ['space-tab', ' \t'],
  ['spaces-tab', '    \t'],
  ['spaces-1', ' '],
  ['spaces-2', '  '],
  ['spaces-5', '     '],
  ['tab-comment', '\t# c'],
  ['tab-text', '\tx'],
];
// Block scalars with no indicator, and at the document root.
const plain = [
  ['map-tab-blank', 'a: |\n  x\n\t\n  y\n'],
  ['map-tab-before-content', 'a: |\n\t\n  x\n'],
  ['map-tab-deep-before-content', 'a: |\n  \t\n  x\n'],
  ['map-tab-content', 'a: |\n  x\n  \ty\n'],
  ['root-tab-comment', '|\n\t# c'],
  ['root-tab-text', '|\n\tx\n'],
  ['root-tab-blank', '|\n\t\nx\n'],
  ['root-space-tab-text', '|\n \tx\n'],
  ['root-content-tab-blank', '|\n x\n\t\n y\n'],
  ['root-folded-tab-text', '>\n\tx\n\ty\n'],
  ['root-keep-tab', '|+\n\t\n'],
  ['root-tab-after-blank', '|\n\n\tx\n'],
  // Explicit indentation at the root counts from column 0.
  ['root-explicit-1', '|1\n x\n'],
  ['root-explicit-1-deeper', '|1\n  x\n y\n'],
  ['root-explicit-2', '|2\n   x\n  y\n'],
  ['root-explicit-folded', '>1\n  x\n  y\n'],
  ['root-explicit-strip', '|1-\n x\n'],
  ['root-explicit-keep', '|+1\n x\n\n'],
  ['root-explicit-blank', '|1\n\n x\n'],
  ['root-explicit-shallow', '|2\n x\n'],
  ['root-explicit-zero-indent', '|1\nx\n'],
  ['root-explicit-document', '--- |1\n x\n'],
  ['root-indented-header', ' |\n x\n'],
  ['root-indented-explicit', ' |1\n  x\n'],
  ['root-later-indented-header', '\n  |\n  x\n'],
  ['root-later-indented-shallow', '\n  |\n x\n'],
  ['root-later-indented-tab', '\n  |\n\tx\n'],
  ['root-later-indented-deep-tab', '\n  |\n  \tx\n'],
  ['root-after-comment-indented-tab', '# c\n  |\n\tx\n'],
  ['root-after-tab-line-indented-tab', '\t\n  |\n\tx\n'],
  ['root-first-line-indented-tab', '  |\n\tx\n'],
  ['root-explicit-tag', '!!str |1\n x\n'],
  ['root-explicit-comment', '|1 # c\n x\n'],
  ['sequence-explicit-1', '- |1\n   x\n'],
  ['map-explicit-1', 'a: |1\n  x\n'],
  // A document marker at column 0 ends a root block scalar.
  ['root-document-start', '|\nx\n---\ny\n'],
  ['root-document-start-eof', '|\nx\n---\n'],
  ['root-document-start-value', '|\nx\n--- y\n'],
  ['root-document-end', '|\nx\n...\n'],
  ['root-document-end-content', '|\nx\n...\ny\n'],
  ['root-document-end-comment', '|\nx\n... # c\n'],
  ['root-indented-document-start', '|\n x\n---\n'],
  ['root-folded-document-start', '>\nx\n---\n'],
  ['root-explicit-document-start', '|1\n x\n---\n'],
  ['root-document-start-text', '|\nx\n---x\n'],
  ['root-document-end-text', '|\nx\n...x\n'],
  ['root-deeper-document-start', '|\n x\n ---\n'],
  ['root-deeper-document-end', '|\n x\n ...\n'],
  ['root-document-start-tab', '|\nx\n---\t\n'],
  ['root-after-start-document-start', '--- |\nx\n---\ny\n'],
  ['root-after-start-document-end', '--- |\nx\n...\n'],
  ['root-blank-document-end', '|\n\n...\n'],
  ['root-tab-document-end', '|\n\tx\n...\n'],
  ['map-document-start', 'a: |\n  x\n---\n'],
  // A root block scalar that ends before its first content line.
  ['root-later-comment-then-text', '\n  |\n # c\nx\n'],
  ['root-later-comment-then-document-start', '\n  |\n # c\n---\ny\n'],
  ['root-later-tab-blank-then-text', '\n  |\n \t\nx\n'],
  ['root-document-start-before-content', '|\n---\n'],
  ['root-explicit-comment-before-content', '|2\n# c\nx\n'],
  ['root-later-explicit-blank-comment', '\n |-1\n  \n# c'],
  ['root-later-keep-blank-comment', '\t\n |+1\n  \n# c'],
  ['root-later-tab-line-before-content', '\n |+3\n         \n    \n\t    \n'],
  ['root-document-end-nul', '|\n\tx\n...\u0000\n'],
  // A line that starts with a BOM.
  ['root-bom-document-start', '|1\n\uFEFF---\n'],
  ['root-content-bom-document-start', '|1\n x\n\uFEFF---\ny\n'],
  ['root-bom-blank-document-start', '|\nx\n\uFEFF\n---\n'],
  ['root-bom-comment-document-start', '|\nx\n\uFEFF # c\n---\n'],
  ['root-bom-directive', '|\nx\n\uFEFF%YAML 1.2\n'],
  ['root-bom-text', '|\nx\n\uFEFFy\n'],
  ['root-bom-document-end', '|\nx\n\uFEFF...\n'],
  ['root-bom-comment', '|\nx\n\uFEFF# c\n'],
  ['root-bom-spaced-directive', '|\nx\n\uFEFF %YAML 1.2\n'],
  ['root-bom-first-line', '|\n\uFEFFx\n'],
  // js-yaml rejects non-printable characters in a scalar.
  ['root-control', '|1\n\u0001\n'],
  ['root-nul', '|\n\tx\n\u0000\n'],
  ['root-delete', '|\nx\u007f\n'],
  ['root-c1-control', '|\nx\u0085y\u0086\n'],
  ['map-control', 'a: |\n  x\u001b\n'],
  ['map-noncharacter', 'a: >\n  x\uFFFE\n'],
  ['map-tab-content', 'a: |\n  x\ty\n'],
  ['map-document-end', 'a: |\n  x\n...\n'],
];
// Two saphyr gaps stay out of this fixture; the README lists them.
function saphyrGap(header, line, name) {
  const digit = Number(header.match(/[1-9]/)[0]);
  const indent = name === 'root' ? digit - 1 : digit;
  const lead = line.match(/^ */)[0].length;
  const spaces = /^ *$/.test(line);
  // A root block scalar that ends before its first content line.
  if (name === 'root' && !spaces && lead < indent && line !== '\tx') return true;
  // An empty block scalar at the end of the input.
  const ends = name === 'map-no-final-break' || (!header.includes('+') && (name === 'map-eof' || name === 'root'));
  return spaces && lead <= indent && ends;
}
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
for (const [ending, separator] of [['lf', '\n'], ['crlf', '\r\n']]) {
  for (const [headerName, header] of headers) {
    for (const [lineName, line] of lines) {
      for (const [name, template] of templates) {
        if (ending !== 'lf' && (headerName !== 'literal-2' || name !== 'map-sibling')) continue;
        if (saphyrGap(header, line, name)) continue;
        const source = template.replaceAll('H', header).replaceAll('@', line).replaceAll('\n', separator);
        add(`${ending}-${headerName}-${lineName}-${name}`, source);
      }
    }
  }
  for (const [name, source] of plain) {
    if (ending !== 'lf' && !name.startsWith('root-document')) continue;
    add(`${ending}-${name}`, source.replaceAll('\n', separator));
  }
}
process.stdout.write(`[\n${cases.map((entry) => `  ${JSON.stringify(entry)}`).join(',\n')}\n]\n`);
