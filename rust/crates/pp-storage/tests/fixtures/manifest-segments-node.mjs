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

// The `x` wrapper keeps trimming, lowercasing and the basename fallback inert,
// so each outcome is Node's `^pattern$` answer for the raw units, which is what
// `wildcard_matches` decides. The Rust generators mirror these step for step.
const text = (units) => String.fromCharCode(...units);
const matches = (pattern, key) => matchKeyMatches(`x${text(pattern)}x`, `x${text(key)}x`);
function digest() {
  let accepted = 0;
  let hash = 0x811c9dc5;
  return {
    add(outcome) {
      accepted += Number(outcome);
      hash = Math.imul(hash ^ Number(outcome), 0x01000193) >>> 0;
    },
    get value() {
      return { accepted, digest: hash };
    },
  };
}
function lcg(seed) {
  return (bound) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed >>> 8) % bound;
  };
}
function strings(alphabet, maxLength) {
  const all = [[]];
  let layer = [[]];
  for (let length = 0; length < maxLength; length++) {
    layer = layer.flatMap((prefix) => alphabet.map((unit) => [...prefix, unit]));
    all.push(...layer);
  }
  return all;
}
const dotMatches = (unit) => ![0x0a, 0x0d, 0x2028, 0x2029].includes(unit);

function exhaustive() {
  const patterns = strings([0x61, 0x62, 0x0a, 0x3f, 0x2a], 5);
  const keys = strings([0x61, 0x62, 0x0a], 6);
  const outcomes = digest();
  for (const pattern of patterns) for (const key of keys) outcomes.add(matches(pattern, key));
  return { patterns: patterns.length, keys: keys.length, ...outcomes.value };
}

function longKeys() {
  const next = lcg(748);
  const units = [0x61, 0x61, 0x61, 0x61, 0x61, 0x61, 0x62, 0x62, 0x62, 0x62, 0x62, 0x2028];
  const outcomes = digest();
  for (let c = 0; c < 4000; c++) {
    const key = Array.from({ length: c % 400 }, () => units[next(units.length)]);
    const pattern = [];
    let at = 0;
    while (at < key.length) {
      const choice = next(c % 4 < 2 ? 16 : 256);
      if (!dotMatches(key[at])) {
        pattern.push(key[at++]);
      } else if (choice === 0) {
        pattern.push(0x2a);
        const stop = Math.min(at + next(24), key.length);
        while (at < stop && dotMatches(key[at])) at++;
      } else if (choice <= 3) {
        pattern.push(0x3f);
        at++;
      } else {
        pattern.push(key[at++]);
      }
    }
    if (c % 2 === 1 && pattern.length > 0) {
      const at = next(pattern.length);
      pattern[at] = units[next(units.length)];
    }
    outcomes.add(matches(pattern, key));
  }
  return { cases: 4000, ...outcomes.value };
}

// Every pattern is `*` + a masked segment of 65 or more units + `*`, so each
// case takes the NTT search. Keys hold terminators only inside the copied
// window, because a star cannot cross one. Cases cycle through the copy as is,
// one changed literal, a `?` over a terminator, and a terminator added to the
// key.
function longMasked() {
  const next = lcg(1748);
  const outcomes = digest();
  for (let c = 0; c < 1000; c++) {
    const key = Array.from({ length: 130 + next(400) }, () => [0x61, 0x61, 0x61, 0x62][next(4)]);
    const from = next(key.length - 129);
    const length = 65 + next(key.length - from - 64);
    for (let count = next(4); count > 0; count--) key[from + next(length)] = 0x2028;
    const segment = key.slice(from, from + length);
    for (let count = 1 + next(length); count > 0; count--) {
      const at = next(length);
      if (dotMatches(segment[at])) segment[at] = 0x3f;
    }
    if (c % 4 === 1) segment[next(length)] = [0x61, 0x62][next(2)];
    if (c % 4 === 2 && segment.includes(0x2028)) segment[segment.indexOf(0x2028)] = 0x3f;
    if (c % 4 === 3) key[next(key.length)] = 0x2028;
    if (!segment.includes(0x3f)) segment[segment.findIndex(dotMatches)] = 0x3f;
    outcomes.add(matches([0x2a, ...segment, 0x2a], key));
  }
  return { cases: 1000, ...outcomes.value };
}

const result = { exhaustive: exhaustive(), longKeys: longKeys(), longMasked: longMasked() };
const output = `${JSON.stringify(result, null, 2)}\n`;
const fixture = new URL("manifest-segments-node.json", import.meta.url);
const check = process.argv.includes("--check");
if (check) assert.equal(readFileSync(fixture, "utf8"), output);
else writeFileSync(fixture, output);
console.log(`Node segment-search digests ${check ? "verified" : "written"}: ${JSON.stringify(result)}`);
