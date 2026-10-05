#!/usr/bin/env node
// Fails CI when tracked source gains workaround markers. The committed baseline
// may only go down: lower it with --update after removing markers.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, "..");
const BASELINE_PATH = join(SCRIPT_DIR, "workaround-baseline.json");

const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".rs", ".py", ".sh", ".css", ".html",
]);

// The ratchet's own files mention every marker on purpose.
const EXCLUDED_PATHS = new Set([
  "scripts/workaround-ratchet.mjs",
  "scripts/workaround-ratchet.test.mjs",
]);

export const MARKERS = {
  todoComments: /(?:\/\/|\/\*|^\s*\*|#|<!--).*\b(?:TODO|FIXME|HACK)\b/,
  eslintDisable: /eslint-disable/,
  rustAllow: /#!?\[allow\(/,
};

export function isSourcePath(path) {
  if (EXCLUDED_PATHS.has(path)) return false;
  const dot = path.lastIndexOf(".");
  return dot > path.lastIndexOf("/") && SOURCE_EXTENSIONS.has(path.slice(dot));
}

export function countText(text) {
  const counts = Object.fromEntries(Object.keys(MARKERS).map((key) => [key, 0]));
  for (const line of text.split("\n")) {
    for (const [key, pattern] of Object.entries(MARKERS)) {
      if (pattern.test(line)) counts[key] += 1;
    }
  }
  return counts;
}

export function countFiles(root, paths) {
  const totals = countText("");
  for (const path of paths.filter(isSourcePath)) {
    const counts = countText(readFileSync(join(root, path), "utf8"));
    for (const key of Object.keys(totals)) totals[key] += counts[key];
  }
  return totals;
}

export function compare(current, baseline) {
  const increased = [];
  const decreased = [];
  for (const key of Object.keys(MARKERS)) {
    const allowed = baseline[key];
    if (!Number.isInteger(allowed)) throw new Error(`baseline is missing an integer for ${key}`);
    if (current[key] > allowed) increased.push({ key, current: current[key], allowed });
    if (current[key] < allowed) decreased.push({ key, current: current[key], allowed });
  }
  return { increased, decreased };
}

function trackedFiles(root) {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
}

export function main(argv = process.argv.slice(2), root = REPO_ROOT, baselinePath = BASELINE_PATH) {
  const current = countFiles(root, trackedFiles(root));
  const shownPath = relative(root, baselinePath);
  if (argv.includes("--update")) {
    writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`);
    console.log(`Wrote ${shownPath}: ${JSON.stringify(current)}`);
    return 0;
  }
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const { increased, decreased } = compare(current, baseline);
  for (const key of Object.keys(MARKERS)) {
    console.log(`${key}: ${current[key]} (baseline ${baseline[key]})`);
  }
  if (increased.length > 0) {
    for (const { key, current: now, allowed } of increased) {
      console.error(`Workaround ratchet: ${key} rose to ${now}, above the baseline of ${allowed}.`);
    }
    console.error("Fix the underlying issue instead of adding a workaround marker.");
    return 1;
  }
  if (decreased.length > 0) {
    console.log(`Counts dropped. Lower the baseline with: node scripts/workaround-ratchet.mjs --update`);
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main();
}
