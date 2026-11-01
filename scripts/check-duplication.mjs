#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, "..");
const BASELINE_PATH = join(SCRIPT_DIR, "duplication-baseline.json");

// One entry per app the readiness audit counts. rust/crates holds pp-server,
// pp-desktop and the libraries they share.
export const AREAS = {
  "web/apps/server": "web/apps/server",
  "web/apps/web": "web/apps/web",
  "web/packages": "web/packages",
  rust: "rust/crates",
  "slicer-sidecar": "slicer-sidecar",
};

// Generated and recorded files repeat by design; their generators are the source of truth.
const IGNORED = [
  "**/node_modules/**",
  "**/target/**",
  "**/dist/**",
  "**/*.generated.ts",
  "**/fixtures/**",
  "**/snapshots/**",
  "**/__snapshots__/**",
];

// Pin jscpd's defaults so a release that changes them cannot move the counts.
export function jscpdArgs(path, output) {
  return [
    path,
    "--min-tokens", "50",
    "--min-lines", "0",
    "--mode", "mild",
    "--format", "javascript,typescript,tsx,rust,python",
    "--ignore", IGNORED.join(","),
    "--reporters", "json",
    "--output", output,
    "--silent",
  ];
}

function jscpdEntry() {
  const requireWeb = createRequire(join(REPO_ROOT, "web/package.json"));
  return join(dirname(requireWeb.resolve("jscpd/package.json")), "run-jscpd.js");
}

export function readReport(report) {
  const total = report?.statistics?.total;
  if (!Number.isInteger(total?.duplicatedTokens) || total.duplicatedTokens < 0 || !Number.isInteger(total?.sources) || total.sources < 1) {
    throw new Error("jscpd report has no source files or duplicated-token total");
  }
  return { duplicatedTokens: total.duplicatedTokens, clones: report.duplicates ?? [] };
}

export function scan(root = REPO_ROOT) {
  const entry = jscpdEntry();
  const results = {};
  for (const [area, path] of Object.entries(AREAS)) {
    const output = mkdtempSync(join(tmpdir(), "pp-jscpd-"));
    try {
      execFileSync(process.execPath, [entry, ...jscpdArgs(path, output)], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
      const result = readReport(JSON.parse(readFileSync(join(output, "jscpd-report.json"), "utf8")));
      // jscpd names files relative to the scanned path.
      for (const clone of result.clones) {
        for (const file of [clone.firstFile, clone.secondFile]) file.name = `${path}/${file.name}`;
      }
      results[area] = result;
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  }
  return results;
}

export function parseBaseline(text) {
  const baseline = JSON.parse(text);
  const keys = Object.keys(baseline ?? {}).sort();
  if (JSON.stringify(keys) !== JSON.stringify(Object.keys(AREAS).sort())) {
    throw new Error(`baseline must list exactly these areas: ${Object.keys(AREAS).join(", ")}`);
  }
  for (const [area, count] of Object.entries(baseline)) {
    if (!Number.isInteger(count) || count < 0) throw new Error(`baseline for ${area} must be a nonnegative integer`);
  }
  return baseline;
}

export function compare(current, baseline) {
  const increased = [];
  const decreased = [];
  for (const area of Object.keys(AREAS)) {
    if (current[area] > baseline[area]) increased.push(area);
    if (current[area] < baseline[area]) decreased.push(area);
  }
  return { increased, decreased };
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
    .split("\n")
    .filter(Boolean);
}

export function baselineAtRef(root, ref = process.env.PP_DUPLICATION_BASE || "origin/main", run = execFileSync) {
  const read = (args) => run("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  // A missing ref is an error, not permission to create a new baseline.
  read(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  const path = "scripts/duplication-baseline.json";
  if (!read(["ls-tree", "--name-only", ref, "--", path])) return null;
  return parseBaseline(read(["show", `${ref}:${path}`]));
}

// Committed, uncommitted and untracked changes since PP_DUPLICATION_BASE, or
// since the branch left origin/main.
function changedFiles(root) {
  try {
    const [base] = process.env.PP_DUPLICATION_BASE
      ? [process.env.PP_DUPLICATION_BASE]
      : git(root, ["merge-base", "origin/main", "HEAD"]);
    return new Set([...git(root, ["diff", "--name-only", base]), ...git(root, ["ls-files", "--others", "--exclude-standard"])]);
  } catch {
    return null;
  }
}

function reportClones(clones, changed) {
  const relevant = changed
    ? clones.filter((clone) => changed.has(clone.firstFile.name) || changed.has(clone.secondFile.name))
    : clones;
  for (const clone of relevant.slice(0, 30)) {
    const where = (file) => `${file.name}:${file.start}-${file.end}`;
    console.error(`  ${clone.tokens} tokens: ${where(clone.firstFile)} and ${where(clone.secondFile)}`);
  }
  if (changed) console.error(`  (${relevant.length} clones touch files changed since ${process.env.PP_DUPLICATION_BASE || "origin/main"})`);
}

export function main(argv = process.argv.slice(2), root = REPO_ROOT, baselinePath = BASELINE_PATH, runScan = scan, loadBase = baselineAtRef) {
  const base = loadBase(root);
  const results = runScan(root);
  const current = Object.fromEntries(Object.entries(results).map(([area, result]) => [area, result.duplicatedTokens]));
  const shownPath = relative(root, baselinePath);
  const previous = existsSync(baselinePath) ? parseBaseline(readFileSync(baselinePath, "utf8")) : null;
  const candidate = argv.includes("--update") ? current : previous;
  if (base && candidate) {
    const raised = compare(candidate, base).increased;
    if (raised.length > 0) {
      for (const area of raised) console.error(`${area}: baseline increase over the base ref (${base[area]} to ${candidate[area]}) is forbidden.`);
      return 1;
    }
  }
  if (argv.includes("--update")) {
    const increased = previous ? compare(current, previous).increased : [];
    if (increased.length > 0) {
      for (const area of increased) console.error(`${area}: ${current[area]} duplicated tokens, above the baseline of ${previous[area]}.`);
      console.error(`Refusing to raise ${shownPath}. Remove the new duplication instead.`);
      return 1;
    }
    writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`);
    console.log(`Wrote ${shownPath}: ${JSON.stringify(current)}`);
    return 0;
  }
  if (!previous) throw new Error(`${shownPath} is missing; run with --update to create it`);
  const { increased, decreased } = compare(current, previous);
  for (const area of Object.keys(AREAS)) console.log(`${area}: ${current[area]} duplicated tokens (baseline ${previous[area]})`);
  if (increased.length > 0) {
    const changed = changedFiles(root);
    for (const area of increased) {
      console.error(`Duplication check: ${area} rose to ${current[area]} duplicated tokens, above the baseline of ${previous[area]}.`);
      reportClones(results[area].clones, changed);
    }
    console.error("Extract the shared code instead of copying it.");
    return 1;
  }
  if (decreased.length > 0) console.log("Duplication dropped. Lower the baseline with: node scripts/check-duplication.mjs --update");
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main();
}
