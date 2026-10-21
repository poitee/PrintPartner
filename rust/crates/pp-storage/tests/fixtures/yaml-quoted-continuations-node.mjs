import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../../../../web/package.json', import.meta.url));
const { version } = require('js-yaml/package.json');
if (version !== '5.4.3') throw new Error(`Expected js-yaml 5.4.3, got ${version}`);
const { load } = require('js-yaml');

// Every quoted continuation form at every indent from column 0 to past the required depth.
const parents = [
  ['block-map-seq', 'k: [', ']'],
  ['block-map-map', 'k: {a: ', '}'],
  ['nested-map-seq', 'outer:\n  k: [', ']'],
  ['nested-map-map', 'outer:\n  k: {a: ', '}'],
  ['compact-seq', '- - [', ']'],
  ['compact-map', '- - {a: ', '}'],
  ['seq-entry-seq', '- [', ']'],
  ['root-seq', '[', ']'],
];
const forms = (quote, br) => [
  ['plain', (pad) => `a${br}${pad}b`],
  ['two-lines', (pad) => `a${br}${pad}b${br}${pad}c`],
  ['trailing-space', (pad) => `a ${br}${pad}b`],
  ['blank', (pad) => `a${br}${br}${pad}b`],
  ['space-blank', (pad) => `a${br}${pad}${br}${pad}b`],
  ['tab-blank', (pad) => `a${br}\t${br}${pad}b`],
  ['spaces-tab', (pad) => `a${br}${pad}\tb`],
  ['closing', (pad) => `a${br}${pad}`],
  ...(quote === '"'
    ? [
        ['escaped-break', (pad) => `a\\${br}${pad}b`],
        ['escaped-quote', (pad) => `a\\"${br}${pad}b`],
      ]
    : [['doubled-quote', (pad) => `a''${br}${pad}b`]]),
];
const indents = 8;

const lines = [];
const counts = { refused: 0, accepted: 0, parked: 0 };
for (const [parent, open, close] of parents) {
  for (const [style, quote] of [['double', '"'], ['single', "'"]]) {
    for (const [ending, br] of [['lf', '\n'], ['cr', '\r'], ['crlf', '\r\n']]) {
      const prefix = open.replaceAll('\n', br) + quote;
      const suffix = quote + close;
      const cases = [];
      for (const [form, body] of forms(quote, br)) {
        for (let indent = 0; indent < indents; indent++) {
          const text = body(' '.repeat(indent));
          let expected;
          try {
            expected = load(prefix + text + suffix);
          } catch {
            expected = null;
          }
          // saphyr rejects a column-0 tab-only line in a quoted scalar; GRE-765 owns that accept.
          const parked = form === 'tab-blank' && expected !== null;
          cases.push(parked ? [text, expected, 'GRE-765'] : [text, expected]);
          counts[parked ? 'parked' : expected === null ? 'refused' : 'accepted']++;
        }
      }
      lines.push(JSON.stringify([`${parent}-${style}-${ending}`, prefix, suffix, cases]));
    }
  }
}

// One line per parent, quote style and line ending keeps the fixture small and drift diffs local.
const output = lines.join('\n') + '\n';
const fixture = new URL('yaml-quoted-continuations-node.jsonl', import.meta.url);
const check = process.argv.includes('--check');
if (check) assert.equal(readFileSync(fixture, 'utf8'), output);
else writeFileSync(fixture, output);
const total = counts.refused + counts.accepted + counts.parked;
console.log(
  `${total} quoted continuations (${counts.refused} refused, ${counts.accepted} accepted, ${counts.parked} parked) ${check ? 'verified' : 'written'}`,
);
