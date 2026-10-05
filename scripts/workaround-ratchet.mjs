#!/usr/bin/env node
// Fails CI when tracked source gains workaround markers. The committed baseline
// may only go down: lower it with --update after removing markers.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

const TODO_WORD = /\b(?:TODO|FIXME|HACK)\b/;

// Languages with /* */ block comments, and HTML with <!-- -->.
const SLASH_STAR_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".rs", ".css"]);

function extensionOf(path) {
  const dot = path.lastIndexOf(".");
  return dot > path.lastIndexOf("/") ? path.slice(dot) : "";
}

export function isSourcePath(path) {
  if (EXCLUDED_PATHS.has(path)) return false;
  return SOURCE_EXTENSIONS.has(extensionOf(path));
}

// Returns whether a block comment is still open at the end of `line`. Quoted
// strings and `//` line comments are skipped so `"src/**/*.ts"` does not open
// a comment. Rust lifetimes ('a) are not strings, so `'` is ignored there.
function blockStateAfter(line, inBlock, { open, close, slashLineComments, singleQuoteStrings }) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    if (inBlock) {
      if (line.startsWith(close, i)) {
        inBlock = false;
        i += close.length - 1;
      }
      continue;
    }
    const ch = line[i];
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "`" || (ch === "'" && singleQuoteStrings)) {
      quote = ch;
    } else if (slashLineComments && line.startsWith("//", i)) {
      return false;
    } else if (line.startsWith(open, i)) {
      inBlock = true;
      i += open.length - 1;
    }
  }
  return inBlock;
}

function blockSyntaxFor(path) {
  const ext = extensionOf(path);
  if (ext === ".html") return { open: "<!--", close: "-->", slashLineComments: false, singleQuoteStrings: true };
  if (SLASH_STAR_EXTENSIONS.has(ext)) {
    return { open: "/*", close: "*/", slashLineComments: ext !== ".css", singleQuoteStrings: ext !== ".rs" };
  }
  // Unknown or no path: assume C-style comments, the common case in this repo.
  if (ext === "") return { open: "/*", close: "*/", slashLineComments: true, singleQuoteStrings: true };
  return null;
}

export function countText(text, path = "") {
  const counts = Object.fromEntries(Object.keys(MARKERS).map((key) => [key, 0]));
  const syntax = blockSyntaxFor(path);
  let inBlock = false;
  for (const line of text.split("\n")) {
    for (const [key, pattern] of Object.entries(MARKERS)) {
      const inBlockTodo = key === "todoComments" && inBlock && TODO_WORD.test(line);
      if (inBlockTodo || pattern.test(line)) counts[key] += 1;
    }
    if (syntax) inBlock = blockStateAfter(line, inBlock, syntax);
  }
  return counts;
}

export function countFiles(root, paths) {
  const totals = countText("");
  for (const path of paths.filter(isSourcePath)) {
    const counts = countText(readFileSync(join(root, path), "utf8"), path);
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

function reportIncreases(increased) {
  for (const { key, current: now, allowed } of increased) {
    console.error(`Workaround ratchet: ${key} rose to ${now}, above the baseline of ${allowed}.`);
  }
}

export function main(argv = process.argv.slice(2), root = REPO_ROOT, baselinePath = BASELINE_PATH) {
  const current = countFiles(root, trackedFiles(root));
  const shownPath = relative(root, baselinePath);
  if (argv.includes("--update")) {
    // An existing baseline may only go down. Only a missing baseline is
    // written from scratch.
    if (existsSync(baselinePath)) {
      const { increased } = compare(current, JSON.parse(readFileSync(baselinePath, "utf8")));
      if (increased.length > 0) {
        reportIncreases(increased);
        console.error(`Refusing to raise ${shownPath}. Remove the new markers instead.`);
        return 1;
      }
    }
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
    reportIncreases(increased);
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
