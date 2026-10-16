import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";

const reference = new URL("../../../../../web/apps/server/src/services/manifest-apply.ts", import.meta.url);
const source = readFileSync(reference, "utf8");
const start = source.indexOf("export function matchKeyMatches(");
const end = source.indexOf("export type ManifestVariant", start);
assert(start >= 0 && end > start, "matchKeyMatches source boundaries");
const functions = stripTypeScriptTypes(source.slice(start, end).replace("export function", "function"));
const matchKeyMatches = runInNewContext(`${functions}\nmatchKeyMatches`);
const rows = [];
function add(name, pattern, key) {
  const units = Array.from({ length: pattern.length }, (_, i) => pattern.charCodeAt(i));
  rows.push([name, units, key, matchKeyMatches(pattern, key)]);
}

for (const [pattern, key] of [
  ["parts/*.stl", "parts/bracket.stl"],
  ["bracket.stl", "parts/bracket.stl"],
  ["  PART?.STL ", "Folder\\Part1.stl"],
  ["folder/*.stl", "folder/deep/part.stl"],
  ["folder/*.stl", "other/part.stl"],
  ["part[1].stl", "a/part[1].stl"],
  ["part[1].stl", "a/part1.stl"],
  ["a+b.stl", "a+b.stl"],
  ["\ufeffa.stl\ufeff", "a.stl"],
  ["\u0085a.stl", "a.stl"],
  ["*.stl", "x\ny.stl"],
  ["part?.stl", "part12.stl"],
  ["a/b.stl", "deep/a/b.stl"],
]) add("existing", pattern, key);

for (const [pattern, key] of [
  ["part?.stl", "part😀.stl"],
  ["part??.stl", "part😀.stl"],
  ["part\ud83d?.stl", "part😀.stl"],
  ["part?\ude00.stl", "part😀.stl"],
  ["*\ude00*", "part😀.stl"],
  ["*\ud83d", "part😀"],
  ["\ud800*", "�.stl"],
  ["*ſ*", "partS.stl"],
  ["*S*", "partſ.stl"],
  ["kapı.stl", "kapi.stl"],
  ["*K*", "partK.stl"],
  ["*ß*", "SS.stl"],
  ["*ﬀ*", "FF.stl"],
  ["*σ*", "ς.stl"],
  ["ΟΣ*", "ος.stl"],
  ["*İ*", "i\u0307.stl"],
  ["𐐀?.stl", "𐐨a.stl"],
  ["a\ud800Σ*", "aΣ.stl"],
]) add("unicode", pattern, key);

for (const metacharacter of ".+^${}()|[]") {
  add("literal", `a${metacharacter}?.stl`, `a${metacharacter}1.stl`);
  add("literal", `a${metacharacter}?.stl`, "ax1.stl");
}
for (const terminator of ["\n", "\r", "\u2028", "\u2029"]) {
  for (const pattern of ["a*b", "a?b", `a*${terminator}*b`, `a${terminator}b`, "*b"]) {
    add("line-terminator", pattern, `a${terminator}b`);
    add("line-terminator-basename", pattern, `folder${terminator}/a${terminator}b`);
  }
}
for (const space of ["\t", "\n", "\r", " ", "\u00a0", "\u1680", "\u2000", "\u2028", "\u202f", "\u205f", "\u3000", "\ufeff", "\u0085", "\u180e"]) {
  add("trim", `${space}A?.STL${space}`, "a1.stl");
}
for (const pattern of ["", "*", "?", "**", "??", "*?", "?*", "a*", "*a", "a?", "?a", "*a*b", "a**b", "*?*?*", "a/b", "a\\b", "a*b"]) {
  for (const key of ["", "a", "A", "ab", "aaab", "a/b", "x/a", "😀", "a\nb", "a/", "*", "?"]) {
    add("wildcard", pattern, key);
  }
}

let seed = 642;
function pick(values) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return values[seed % values.length];
}
for (let i = 0; i < 256; i++) {
  let pattern = "";
  let key = "";
  for (let j = 0; j < 8; j++) {
    pattern += pick(["a", "B", "*", "?", "/", "😀", "ſ", "ı", ".", "\n", "\ud83d", "\ude00"]);
    key += pick(["a", "b", "/", "😀", "S", "I", ".", "\n"]);
  }
  add("generated", pattern, key);
}

const output = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
const fixture = new URL("manifest-globs-node.jsonl", import.meta.url);
if (process.argv.includes("--check")) assert.equal(readFileSync(fixture, "utf8"), output);
else writeFileSync(fixture, output);
console.log(`${rows.length} Node matchKeyMatches cases ${process.argv.includes("--check") ? "verified" : "written"}`);
