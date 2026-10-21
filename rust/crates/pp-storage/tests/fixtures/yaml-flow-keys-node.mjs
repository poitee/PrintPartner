import { createRequire } from 'node:module';

const require = createRequire(new URL('../../../../../web/package.json', import.meta.url));
const { version } = require('js-yaml/package.json');
if (version !== '5.4.3') throw new Error(`Expected js-yaml 5.4.3, got ${version}`);
const { load } = require('js-yaml');
const tag = '!<tag:yaml.org,2002:str>';
const sources = [
  // An empty explicit key in a flow sequence.
  ['explicit-empty', '[? ]'],
  ['explicit-empty-padded', '[ ? ]'],
  ['explicit-empty-after-entry', '[a, ? ]'],
  ['explicit-empty-colon', '[? : x]'],
  ['explicit-empty-comma', '[? , x]'],
  ['explicit-empty-line-break', '[?\n]'],
  ['explicit-empty-comment', '[? # c\n]'],
  ['explicit-key', '[? x]'],
  ['explicit-tagged-empty', '[? !!str ]'],
  ['explicit-empty-map', '{? }'],
  // A flow `?` followed by a flow indicator.
  ['bare-question-seq', '[?]'],
  ['bare-question-comma', '[?,]'],
  ['bare-question-after-entry', '[x, ?]'],
  ['bare-question-map', '{?}'],
  ['bare-question-tagged', '[!!str ?]'],
  ['bare-question-verbatim', `[${tag}?]`],
  ['bare-question-anchored', '[&a ?]'],
  ['bare-question-plain', '[?x]'],
  ['bare-question-key', '{?: 1}'],
  ['bare-question-plain-key', '{?x: 1}'],
  // A flow `:` followed by a tab or a collection.
  ['empty-key-seq', '[:[]]'],
  ['empty-key-map', '{:[]}'],
  ['empty-key-tab', '{:\ta}'],
  ['empty-key-tab-line', '{:\ta\n }'],
  ['plain-key-seq', '[a:[]]'],
  ['plain-key-tab', '{a:\tx}'],
  ['plain-key-tab-seq', '[a:\tx]'],
  ['quoted-key-tab', '{"q":\tx}'],
  ['quoted-key-tab-nested', 'a:\n  {"a b":\ta\\}'],
  ['quoted-multiline-key-tab', 'a:\n  {"a\n b":\ta\\}'],
  ['empty-key-space', '[: x]'],
  ['colon-plain', '[:x]'],
  ['empty-key-empty-value', '{:}'],
  // A `#` right after a quoted key's colon.
  ['comment-quoted-key', '{"q":# c\n}'],
  ['comment-quoted-key-bare', '{"q":#c}'],
  ['comment-quoted-key-empty', '{"q":#\n}'],
  ['comment-quoted-key-seq', '["q":# c\n]'],
  ['comment-quoted-key-spaced', '{"q" :# c\n}'],
  ['comment-quoted-key-anchored', '{&a "q":# c\n}'],
  ['comment-quoted-key-block', '"q":# c'],
  ['comment-separated', '{"q": # c\n}'],
  ['comment-tab-separated', '{"q":\t# c\n}'],
  ['comment-plain-key', '{a:#c}'],
  ['comment-tagged-plain', '[!!str :# c\n]'],
];
const cases = sources.map(([name, source]) => {
  let expected;
  try {
    expected = load(source);
  } catch {
    expected = null;
  }
  return { name, source, expected };
});
process.stdout.write(`[\n${cases.map((entry) => `  ${JSON.stringify(entry)}`).join(',\n')}\n]\n`);
