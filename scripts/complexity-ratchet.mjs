#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, "..");
export const WEB_ROOT = join(REPO_ROOT, "web");
const BASELINE_PATH = join(SCRIPT_DIR, "complexity-baseline.json");
const requireWeb = createRequire(join(WEB_ROOT, "package.json"));

// Line-count rules (max-lines, max-lines-per-function) wait for the Prettier rollout to finish;
// reformatting changes line counts and would trip the ratchet on formatter-only PRs.
export const RULE_CONFIG = [
  {
    rules: {
      complexity: ["error", { max: 20 }],
      "max-depth": ["error", { max: 5 }],
      "max-params": ["error", { max: 5 }],
    },
  },
];

export const RULES = new Set(RULE_CONFIG.flatMap((block) => Object.keys(block.rules)));

export function createLinter() {
  const { ESLint } = requireWeb("eslint");
  return new ESLint({
    cwd: WEB_ROOT,
    overrideConfig: RULE_CONFIG,
    ruleFilter: ({ ruleId }) => RULES.has(ruleId),
  });
}

export function countFindings(results) {
  const counts = {};
  const fatal = [];
  for (const result of results) {
    const path = relative(WEB_ROOT, result.filePath).split(sep).join("/");
    for (const message of result.messages) {
      if (message.fatal) fatal.push(`${path}: ${message.message}`);
      if (!RULES.has(message.ruleId)) continue;
      counts[path] ??= {};
      counts[path][message.ruleId] = (counts[path][message.ruleId] ?? 0) + 1;
    }
  }
  return { counts: sortCounts(counts), fatal };
}

function sortCounts(counts) {
  return Object.fromEntries(
    Object.keys(counts)
      .sort()
      .map((path) => [path, Object.fromEntries(Object.entries(counts[path]).sort())]),
  );
}

export function compare(baseline, counts) {
  const increases = [];
  const decreases = [];
  const paths = new Set([...Object.keys(baseline), ...Object.keys(counts)]);
  for (const path of [...paths].sort()) {
    for (const rule of RULES) {
      const allowed = baseline[path]?.[rule] ?? 0;
      const actual = counts[path]?.[rule] ?? 0;
      if (actual > allowed) increases.push({ path, rule, allowed, actual });
      else if (actual < allowed) decreases.push({ path, rule, allowed, actual });
    }
  }
  return { increases, decreases };
}

function readBaseline() {
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
}

async function main(argv) {
  const update = argv.includes("--update");
  const results = await createLinter().lintFiles(["."]);
  const { counts, fatal } = countFindings(results);
  if (fatal.length) {
    console.error(`Complexity ratchet could not parse ${fatal.length} file(s):\n${fatal.join("\n")}`);
    return 1;
  }
  const baseline = readBaseline();
  const { increases, decreases } = compare(baseline, counts);
  if (increases.length) {
    console.error("Complexity ratchet: findings rose above the baseline.");
    for (const { path, rule, allowed, actual } of increases) {
      console.error(`  web/${path}: ${rule} ${allowed} -> ${actual}`);
    }
    console.error("Split the code, or lower complexity, until the count is back at or below the baseline.");
    console.error("scripts/complexity-baseline.json only records decreases; --update never raises it.");
    return 1;
  }
  if (update && decreases.length) {
    writeFileSync(BASELINE_PATH, `${JSON.stringify(counts, null, 2)}\n`);
    console.log(`Complexity ratchet: lowered ${decreases.length} baseline entr${decreases.length === 1 ? "y" : "ies"}.`);
    return 0;
  }
  if (decreases.length) {
    console.log(
      `Complexity ratchet: ${decreases.length} count(s) fell below the baseline. Run with --update to lock them in.`,
    );
  }
  const total = Object.values(counts).reduce((sum, rules) => sum + Object.values(rules).reduce((a, b) => a + b, 0), 0);
  console.log(`Complexity ratchet: ${total} findings, none above the baseline.`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
