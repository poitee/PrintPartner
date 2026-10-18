import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

// Builder globs match through a non-unicode /i RegExp after toLowerCase (manifest-apply.ts).
// Both mappings come from ICU in Node and from std in Rust, so pin them per unit.
const rows = [];
const units = Array.from({ length: 0x10000 }, (_, unit) => String.fromCharCode(unit)).join("");
for (let unit = 0; unit < 0x10000; unit++) {
  const pattern = new RegExp(`\\u${unit.toString(16).padStart(4, "0")}`, "gi");
  let representative = unit;
  for (const match of units.matchAll(pattern)) representative = Math.min(representative, match.index);
  if (representative !== unit) rows.push(["ignore-case", unit, representative]);
}
for (let point = 0; point <= 0x10ffff; point++) {
  if (point >= 0xd800 && point <= 0xdfff) continue;
  const scalar = String.fromCodePoint(point);
  const lower = scalar.toLowerCase();
  if (lower !== scalar) {
    rows.push(["lowercase", point, Array.from({ length: lower.length }, (_, i) => lower.charCodeAt(i))]);
  }
}

// One line per kind and 256-unit block keeps the fixture small and drift diffs local.
const blocks = Map.groupBy(rows, ([kind, point]) => `${kind} ${point >> 8}`);
const output = [...blocks].map(([block, entries]) => JSON.stringify([block, entries.map(([, ...entry]) => entry)])).join("\n") + "\n";
const fixture = new URL("manifest-case-node.jsonl", import.meta.url);
if (process.argv.includes("--check")) assert.equal(readFileSync(fixture, "utf8"), output);
else writeFileSync(fixture, output);
console.log(`${rows.length} Node case mappings in ${blocks.size} blocks ${process.argv.includes("--check") ? "verified" : "written"}`);
