import assert from "node:assert/strict";
import { test } from "node:test";
import { compare, countFindings, createLinter } from "./complexity-ratchet.mjs";

const branches = (n) => Array.from({ length: n }, (_, i) => `  if (x === ${i}) return ${i};`).join("\n");
const complexSource = `export function probe(x: number) {\n${branches(21)}\n  return -1;\n}\n`;
const simpleSource = `export function probe(x: number) {\n${branches(3)}\n  return -1;\n}\n`;
const manyParams = "export function probe(a: number, b: number, c: number, d: number, e: number, f: number) {\n  return a + b + c + d + e + f;\n}\n";
const deep = "export function probe(x: number) {\n  if (x) { if (x) { if (x) { if (x) { if (x) { if (x) { return 1; } } } } } }\n  return 0;\n}\n";

async function countsFor(source, filePath) {
  return countFindings(await createLinter().lintText(source, { filePath })).counts;
}

test("counts a function above the complexity limit", async () => {
  const counts = await countsFor(complexSource, "apps/server/src/ratchet-probe.ts");
  assert.deepEqual(counts, { "apps/server/src/ratchet-probe.ts": { complexity: 1 } });
});

test("does not count a simple function", async () => {
  assert.deepEqual(await countsFor(simpleSource, "apps/server/src/ratchet-probe.ts"), {});
});

test("counts too many parameters", async () => {
  const counts = await countsFor(manyParams, "apps/web/src/ratchet-probe.ts");
  assert.equal(counts["apps/web/src/ratchet-probe.ts"]["max-params"], 1);
});

test("counts nesting deeper than the limit", async () => {
  const counts = await countsFor(deep, "apps/server/src/ratchet-probe.ts");
  assert.equal(counts["apps/server/src/ratchet-probe.ts"]["max-depth"], 1);
});

test("fails a new file and a file that rises above its baseline", () => {
  const baseline = { "a.ts": { complexity: 1 } };
  const { increases } = compare(baseline, { "a.ts": { complexity: 2 }, "b.ts": { "max-depth": 1 } });
  assert.deepEqual(increases, [
    { path: "a.ts", rule: "complexity", allowed: 1, actual: 2 },
    { path: "b.ts", rule: "max-depth", allowed: 0, actual: 1 },
  ]);
});

test("allows counts at or below the baseline", () => {
  const baseline = { "a.ts": { complexity: 2 } };
  const { increases, decreases } = compare(baseline, { "a.ts": { complexity: 1 } });
  assert.deepEqual(increases, []);
  assert.deepEqual(decreases, [{ path: "a.ts", rule: "complexity", allowed: 2, actual: 1 }]);
});

test("reports files the parser cannot read", async () => {
  const { fatal } = countFindings(await createLinter().lintText("export function (", { filePath: "apps/server/src/ratchet-probe.ts" }));
  assert.equal(fatal.length, 1);
});
