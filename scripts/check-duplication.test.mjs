import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { AREAS, baselineAtRef, compare, jscpdArgs, main as runMain, METHOD, parseBaseline, readReport, scan } from "./check-duplication.mjs";

const main = (...args) => runMain(...args, () => null);

const zero = () => Object.fromEntries(Object.keys(AREAS).map((area) => [area, 0]));
const baseline = (counts, method = METHOD) => ({ method, counts });
const results = (counts) =>
  Object.fromEntries(Object.entries(counts).map(([area, duplicatedTokens]) => [area, { duplicatedTokens, clones: [] }]));

function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), "pp-dup-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function quiet(t) {
  for (const name of ["log", "error"]) t.mock.method(console, name, () => {});
}

test("baseline must list every area with a nonnegative integer", () => {
  assert.deepEqual(parseBaseline(JSON.stringify(zero())), { method: null, counts: zero() });
  assert.deepEqual(parseBaseline(JSON.stringify(baseline(zero()))), baseline(zero()));
  for (const bad of [{}, { ...zero(), extra: 0 }, { ...zero(), rust: -1 }, { ...zero(), rust: 1.5 }, { ...zero(), rust: "1" }]) {
    assert.throws(() => parseBaseline(JSON.stringify(bad)));
  }
  for (const bad of [{ method: "", counts: zero() }, { method: 1, counts: zero() }, { method: METHOD }]) {
    assert.throws(() => parseBaseline(JSON.stringify(bad)));
  }
});

test("an empty or malformed jscpd report never passes", () => {
  for (const bad of [{}, { statistics: { total: { duplicatedTokens: 0, sources: 0 } } }, { statistics: { total: { sources: 3 } } }]) {
    assert.throws(() => readReport(bad));
  }
  assert.deepEqual(readReport({ statistics: { total: { duplicatedTokens: 4, sources: 2 } }, duplicates: [] }), {
    duplicatedTokens: 4,
    clones: [],
  });
});

test("compare reports increases and decreases per area", () => {
  const current = { ...zero(), rust: 2, "web/packages": 0 };
  const baseline = { ...zero(), rust: 1, "web/packages": 3 };
  assert.deepEqual(compare(current, baseline), { increased: ["rust"], decreased: ["web/packages"] });
});

test("jscpd thresholds are pinned explicitly", () => {
  const args = jscpdArgs("rust/crates", "/out");
  for (const [flag, value] of [["--min-tokens", "50"], ["--min-lines", "0"], ["--mode", "mild"], ["--reporters", "json"]]) {
    assert.equal(args[args.indexOf(flag) + 1], value);
  }
  assert.match(args[args.indexOf("--ignore") + 1], /\*\*\/fixtures\/\*\*/);
});

test("main fails on a rise, passes on equal or lower counts, and update refuses a rise", (t) => {
  quiet(t);
  const root = scratch(t);
  const path = join(root, "baseline.json");
  writeFileSync(path, JSON.stringify(baseline({ ...zero(), rust: 5 })));
  assert.equal(main([], root, path, () => results({ ...zero(), rust: 6 })), 1);
  assert.equal(main([], root, path, () => results({ ...zero(), rust: 5 })), 0);
  assert.equal(main([], root, path, () => results({ ...zero(), rust: 4 })), 0);
  const before = readFileSync(path, "utf8");
  assert.equal(main(["--update"], root, path, () => results({ ...zero(), rust: 6 })), 1);
  assert.equal(readFileSync(path, "utf8"), before);
  assert.equal(main(["--update"], root, path, () => results({ ...zero(), rust: 4 })), 0);
  assert.equal(parseBaseline(readFileSync(path, "utf8")).counts.rust, 4);
});

test("a missing baseline is an error outside --update", (t) => {
  quiet(t);
  const root = scratch(t);
  assert.throws(() => main([], root, join(root, "missing.json"), () => results(zero())), /missing/);
});

test("checking and updating reject a hand-raised baseline over the base ref", (t) => {
  quiet(t);
  const root = scratch(t);
  const path = join(root, "baseline.json");
  writeFileSync(path, JSON.stringify(baseline({ ...zero(), rust: 6 })));
  for (const argv of [[], ["--update"]]) {
    assert.equal(runMain(argv, root, path, () => results({ ...zero(), rust: 6 }), () => baseline({ ...zero(), rust: 5 })), 1);
  }
  assert.equal(parseBaseline(readFileSync(path, "utf8")).counts.rust, 6);
  // Updating to the base's count can repair a hand-raised local baseline.
  assert.equal(runMain(["--update"], root, path, () => results({ ...zero(), rust: 5 }), () => baseline({ ...zero(), rust: 5 })), 0);
});

test("a method change permits migration to a new baseline", (t) => {
  quiet(t);
  const root = scratch(t);
  const path = join(root, "baseline.json");
  const oldMethod = baseline({ ...zero(), rust: 5 }, "revision 1");
  writeFileSync(path, JSON.stringify(oldMethod));
  assert.throws(() => runMain([], root, path, () => results({ ...zero(), rust: 6 }), () => oldMethod), /run with --update/);
  assert.equal(runMain(["--update"], root, path, () => results({ ...zero(), rust: 6 }), () => oldMethod), 0);
  assert.deepEqual(parseBaseline(readFileSync(path, "utf8")), baseline({ ...zero(), rust: 6 }));
});

test("base lookup distinguishes first landing from missing refs and malformed baselines", () => {
  const calls = [];
  const fake = (listed, shown) => (_tool, args) => {
    calls.push(args);
    return args[0] === "rev-parse" ? "commit\n" : args[0] === "ls-tree" ? listed : shown;
  };
  assert.equal(baselineAtRef("/repo", "base", fake("", "")), null);
  assert.deepEqual(baselineAtRef("/repo", "base", fake("scripts/duplication-baseline.json\n", JSON.stringify(baseline(zero())))), baseline(zero()));
  assert.throws(() => baselineAtRef("/repo", "base", fake("scripts/duplication-baseline.json", "{}")));
  assert.throws(() => baselineAtRef("/repo", "missing", () => { throw new Error("missing ref"); }), /missing ref/);
  assert.deepEqual(calls[0], ["rev-parse", "--verify", "--end-of-options", "base^{commit}"]);
});

test("real jscpd finds a copied block and ignores fixtures", (t) => {
  const root = scratch(t);
  const body = Array.from({ length: 12 }, (_, i) => `  total = total + values[${i}] * weights[${i}] - offsets[${i}];`).join("\n");
  const fn = (name) => `export function ${name}(values: number[], weights: number[], offsets: number[]) {\n  let total = 0;\n${body}\n  return total;\n}\n`;
  for (const path of Object.values(AREAS)) {
    mkdirSync(join(root, path), { recursive: true });
    const name = path.includes("sidecar") ? "only.py" : path.includes("rust") ? "only.rs" : "only.ts";
    // jscpd skips files below its size thresholds, and an area with no analyzed files is an error.
    const lines = Array.from({ length: 12 }, (_, i) => (name.endsWith(".py") ? `v${i} = ${i} * ${i + 7}` : `const v${i} = ${i} * ${i + 7};`));
    writeFileSync(join(root, path, name), `${lines.join("\n")}\n`);
  }
  mkdirSync(join(root, "web/packages/fixtures"), { recursive: true });
  writeFileSync(join(root, "web/packages/fixtures/a.ts"), fn("first"));
  writeFileSync(join(root, "web/packages/fixtures/b.ts"), fn("second"));
  assert.equal(scan(root)["web/packages"].duplicatedTokens, 0);
  writeFileSync(join(root, "web/packages/a.ts"), fn("first"));
  writeFileSync(join(root, "web/packages/b.ts"), fn("second"));
  const found = scan(root)["web/packages"];
  assert.ok(found.duplicatedTokens >= 50, `expected the copied block, got ${found.duplicatedTokens}`);
  assert.equal(found.clones.length, 1);
  assert.deepEqual(new Set([found.clones[0].firstFile.name, found.clones[0].secondFile.name]), new Set(["web/packages/a.ts", "web/packages/b.ts"]));
  writeFileSync(join(root, "web/packages/a.ts"), `${fn("first").replace(/\s+/g, " ")}\n`);
  writeFileSync(join(root, "web/packages/b.ts"), `${fn("second").replace(/\s+/g, " ")}\n`);
  assert.equal(scan(root)["web/packages"].duplicatedTokens, found.duplicatedTokens, "line wrapping must not change the baseline");
  assert.equal(scan(root).rust.duplicatedTokens, 0);
  // UI tests live outside src/ and are often plain JavaScript.
  const before = scan(root)["web/apps/web"].duplicatedTokens;
  mkdirSync(join(root, "web/apps/web/test"), { recursive: true });
  const js = (name) => fn(name).replace(/: number\[\]/g, "");
  writeFileSync(join(root, "web/apps/web/test/a.browser.mjs"), js("first"));
  writeFileSync(join(root, "web/apps/web/test/b.browser.mjs"), js("second"));
  assert.ok(scan(root)["web/apps/web"].duplicatedTokens >= before + 50, "copied UI test JavaScript must count");
});

test("formatting a copied block with Prettier does not change the count", (t) => {
  const root = scratch(t);
  for (const path of Object.values(AREAS)) {
    mkdirSync(join(root, path), { recursive: true });
    const name = path.includes("sidecar") ? "only.py" : path.includes("rust") ? "only.rs" : "only.ts";
    const lines = Array.from({ length: 12 }, (_, i) => (name.endsWith(".py") ? `v${i} = ${i} * ${i + 7}` : `const v${i} = ${i} * ${i + 7};`));
    writeFileSync(join(root, path, name), `${lines.join("\n")}\n`);
  }
  // Prettier adds trailing commas and arrow parentheses here, which adds tokens.
  const fields = Array.from({ length: 10 }, (_, i) => `    field${i}: rows.map(row => row.values[${i}] * scale)`);
  const raw = (name) => `export function ${name}(rows: Row[], scale: number) {\n  return {\n${fields.join(",\n")}\n  };\n}\n`;
  const formatted = (name) => raw(name).replace(/row =>/g, "(row) =>").replace(/scale\)\n  \};/, "scale),\n  };");
  writeFileSync(join(root, "web/packages/a.ts"), raw("first"));
  writeFileSync(join(root, "web/packages/b.ts"), raw("second"));
  const before = scan(root)["web/packages"].duplicatedTokens;
  assert.ok(before >= 50, `expected the copied block, got ${before}`);
  writeFileSync(join(root, "web/packages/a.ts"), formatted("first"));
  assert.equal(scan(root)["web/packages"].duplicatedTokens, before);
});
