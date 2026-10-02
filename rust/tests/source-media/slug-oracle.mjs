import { writeFileSync } from 'node:fs';
const mapped = {};
const context = {};
for (let n = 0; n <= 0x10ffff; n++) {
  if (n >= 0xd800 && n <= 0xdfff) continue;
  const value = String.fromCodePoint(n).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (value) mapped[n] = value;
  const wrapped = ('a' + String.fromCodePoint(n) + 'b').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (wrapped !== 'a-b') context[n] = wrapped;
}
writeFileSync(process.argv[2], JSON.stringify({unicode: process.versions.unicode, mapped, context}));
