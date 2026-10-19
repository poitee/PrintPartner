import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";

const reference = new URL("../../../web/apps/server/src/services/manifest-apply.ts", import.meta.url);
const source = readFileSync(reference, "utf8");
const start = source.indexOf("export function matchKeyMatches(");
const end = source.indexOf("export type ManifestVariant", start);
assert(start >= 0 && end > start, "matchKeyMatches source boundaries");
const functions = stripTypeScriptTypes(source.slice(start, end).replace("export function", "function"));
const matchKeyMatches = runInNewContext(`${functions}\nmatchKeyMatches`);

const alphabet = ["a", "😀", "\n", "\r", "\u2028", "\u2029"];
const patternAlphabet = [...alphabet, "?", "*"];
function boundedStrings(symbols) {
  return ["", ...symbols, ...symbols.flatMap((a) => symbols.map((b) => a + b))];
}
const wrap = (text) => `probe-${text}-end.stl`;
const patterns = boundedStrings(patternAlphabet).map(wrap);
const keys = boundedStrings(alphabet).map(wrap);
const extraPatterns = [
  "s", "ſ", "S", "*s*", "*ſ*", "i", "ı", "*i*", "*ı*",
  "K", "*K*", "ß", "ss", "*ß*", "*SS*", "Σ", "σ", "ς", "*Σ*",
  "İ", "*İ*", "𐐀", "𐐀?", "𐐀*", "***", "a***", "***a", "?**?", "***?***",
];
const extraKeys = ["s", "ſ", "i", "ı", "k", "ß", "ss", "σ", "ς", "i\u0307", "𐐨", "𐐨a"];
patterns.push(...extraPatterns.map(wrap));
keys.push(...extraKeys.map(wrap));
assert.equal(new Set(patterns).size, patterns.length);
assert.equal(new Set(keys.map((key) => key.toLowerCase())).size, keys.length);
const expected = patterns.map((pattern) => keys.map((key) => matchKeyMatches(pattern, key)));
const at = (pattern, key) => expected[patterns.indexOf(wrap(pattern))][keys.indexOf(wrap(key))];
assert.equal(at("a", "a"), true, "literal accept anchor");
assert.equal(at("a", "😀"), false, "literal reject anchor");
assert.equal(at("?", "😀"), false, "one wildcard consumes one UTF-16 unit");
assert.equal(at("??", "😀"), true, "two wildcards consume the emoji surrogate pair");

const domain = {
  alphabet,
  patternAlphabet,
  minLength: 0,
  maxLength: 2,
  prefix: "probe-",
  suffix: "-end.stl",
  boundedPatternCount: 73,
  boundedKeyCount: 43,
  extraPatterns,
  extraKeys,
};
// Keep each boolean row on one line so the Cartesian fixture stays reviewable.
const output = `{\n  "domain": ${JSON.stringify(domain)},\n  "patterns": ${JSON.stringify(patterns)},\n  "keys": ${JSON.stringify(keys)},\n  "expected": [\n${expected.map((row) => "    " + JSON.stringify(row)).join(",\n")}\n  ]\n}\n`;
const fixture = new URL("node.json", import.meta.url);
const check = process.argv.includes("--check");
if (check) assert.equal(readFileSync(fixture, "utf8"), output);
else writeFileSync(fixture, output);
const accepted = expected.flat().filter(Boolean).length;
console.log(`${patterns.length} patterns x ${keys.length} keys = ${patterns.length * keys.length} Node matchKeyMatches outcomes ${check ? "verified" : "written"} (${accepted} accept, ${patterns.length * keys.length - accepted} reject)`);
