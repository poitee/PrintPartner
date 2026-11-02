#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
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

const requireWeb = createRequire(join(REPO_ROOT, "web/package.json"));

function jscpdEntry() {
  return join(dirname(requireWeb.resolve("jscpd/package.json")), "run-jscpd.js");
}

const version = (name) => JSON.parse(readFileSync(requireWeb.resolve(`${name}/package.json`), "utf8")).version;

export function hashPrettierInputs(config, ignore) {
  const normalizeLineEndings = (text) => text.replace(/\r\n?/g, "\n");
  return createHash("sha256")
    .update(normalizeLineEndings(config))
    .update("\0")
    .update(normalizeLineEndings(ignore))
    .digest("hex");
}

// Counts are comparable only when measured the same way. Bump the revision when
// the scanner arguments or the normalization change.
const prettierInputsHash = hashPrettierInputs(
  readFileSync(join(REPO_ROOT, ".prettierrc.json"), "utf8"),
  readFileSync(join(REPO_ROOT, ".prettierignore"), "utf8"),
);
export const METHOD = `revision 2; jscpd ${version("jscpd")}; prettier ${version("prettier")}; config ${prettierInputsHash}`;

const SKIPPED_DIRS = new Set(
  IGNORED.filter((glob) => glob.startsWith("**/") && glob.endsWith("/**")).map((glob) => glob.slice(3, -3)),
);
const FORMATTED = ["web/**/*.{ts,tsx,mts,cts,js,mjs,cjs,jsx}", ...IGNORED.map((glob) => `!${glob}`)];

// Token counts depend on formatting: Prettier adds trailing commas and
// parentheses and moves clone boundaries. Scanning a Prettier-formatted copy of
// the web areas keeps formatter-only changes from moving the counts.
export function formattedWebCopy(root) {
  const copy = mkdtempSync(join(tmpdir(), "pp-dup-src-"));
  try {
    for (const path of Object.values(AREAS).filter((path) => path.startsWith("web/"))) {
      cpSync(join(root, path), join(copy, path), {
        recursive: true,
        filter: (source) => !SKIPPED_DIRS.has(basename(source)),
      });
    }
    const prettier = join(dirname(requireWeb.resolve("prettier/package.json")), "bin/prettier.cjs");
    const run = (mode, files) => {
      const args = [prettier, mode, "--config", join(REPO_ROOT, ".prettierrc.json"), "--ignore-path", join(REPO_ROOT, ".prettierignore")];
      if (mode !== "--list-different") args.push("--log-level", "warn");
      args.push("--no-error-on-unmatched-pattern", ...files);
      return execFileSync(process.execPath, args, { cwd: copy, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
    };
    run("--write", FORMATTED);
    // Prettier needs a second pass on a few files; format those until stable.
    for (let pass = 0; ; pass += 1) {
      try {
        run("--list-different", FORMATTED);
        break;
      } catch (error) {
        if (error.status !== 1 || pass === 2) throw error;
        run("--write", error.stdout.split("\n").filter(Boolean));
      }
    }
    return copy;
  } catch (error) {
    rmSync(copy, { recursive: true, force: true });
    throw error;
  }
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
  const formatted = formattedWebCopy(root);
  const results = {};
  try {
    for (const [area, path] of Object.entries(AREAS)) {
      const output = mkdtempSync(join(tmpdir(), "pp-jscpd-"));
      const cwd = path.startsWith("web/") ? formatted : root;
      try {
        execFileSync(process.execPath, [entry, ...jscpdArgs(path, output)], { cwd, stdio: ["ignore", "ignore", "inherit"] });
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
  } finally {
    rmSync(formatted, { recursive: true, force: true });
  }
  return results;
}

// Returns { method, counts }. The first baseline had only counts; its method is null.
export function parseBaseline(text) {
  const parsed = JSON.parse(text);
  const legacy = parsed !== null && typeof parsed === "object" && !("counts" in parsed);
  const { method = null, counts } = legacy ? { counts: parsed } : (parsed ?? {});
  if (!legacy && (typeof method !== "string" || method === "")) throw new Error("baseline method must be a nonempty string");
  const keys = Object.keys(counts ?? {}).sort();
  if (JSON.stringify(keys) !== JSON.stringify(Object.keys(AREAS).sort())) {
    throw new Error(`baseline must list exactly these areas: ${Object.keys(AREAS).join(", ")}`);
  }
  for (const [area, count] of Object.entries(counts)) {
    if (!Number.isInteger(count) || count < 0) throw new Error(`baseline for ${area} must be a nonnegative integer`);
  }
  return { method, counts };
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
  console.error("  Line numbers in web/ refer to the Prettier-formatted source.");
}

export function main(argv = process.argv.slice(2), root = REPO_ROOT, baselinePath = BASELINE_PATH, runScan = scan, loadBase = baselineAtRef) {
  const update = argv.includes("--update");
  const loaded = loadBase(root);
  // A base measured another way cannot cap these counts. The method change shows
  // in the owner-reviewed baseline diff instead.
  const base = loaded?.method === METHOD ? loaded.counts : null;
  if (loaded && !base) console.log(`The base ref's baseline used another method (${loaded.method ?? "revision 1"}); not comparing with it.`);
  const results = runScan(root);
  const current = Object.fromEntries(Object.entries(results).map(([area, result]) => [area, result.duplicatedTokens]));
  const shownPath = relative(root, baselinePath);
  const stored = existsSync(baselinePath) ? parseBaseline(readFileSync(baselinePath, "utf8")) : null;
  const previous = stored?.method === METHOD ? stored.counts : null;
  const candidate = update ? current : previous;
  if (base && candidate) {
    const raised = compare(candidate, base).increased;
    if (raised.length > 0) {
      for (const area of raised) console.error(`${area}: baseline increase over the base ref (${base[area]} to ${candidate[area]}) is forbidden.`);
      return 1;
    }
  }
  if (update) {
    const increased = previous ? compare(current, previous).increased : [];
    if (increased.length > 0) {
      for (const area of increased) console.error(`${area}: ${current[area]} duplicated tokens, above the baseline of ${previous[area]}.`);
      console.error(`Refusing to raise ${shownPath}. Remove the new duplication instead.`);
      return 1;
    }
    writeFileSync(baselinePath, `${JSON.stringify({ method: METHOD, counts: current }, null, 2)}\n`);
    console.log(`Wrote ${shownPath}: ${JSON.stringify(current)}`);
    return 0;
  }
  if (!stored) throw new Error(`${shownPath} is missing; run with --update to create it`);
  if (!previous) throw new Error(`${shownPath} was measured with ${stored.method ?? "revision 1"}, not ${METHOD}; run with --update`);
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
