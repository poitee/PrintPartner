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
  todoComments: /\b(?:TODO|FIXME|HACK)\b/,
  eslintDisable: /eslint-disable/,
  rustAllow: /#!?\[allow\(/,
};

const CODE_STATE = Object.freeze({ kind: "code" });
const HTML_TAG_STATE = Object.freeze({ kind: "htmlTag" });
const QUOTES = {
  cStyle: [
    { open: '"', close: '"', escape: true, multiline: false },
    { open: "'", close: "'", escape: true, multiline: false },
  ],
  javascript: [
    { open: '"', close: '"', escape: true, multiline: false },
    { open: "'", close: "'", escape: true, multiline: false },
    { open: "`", close: "`", escape: true, multiline: true },
  ],
  python: [
    { open: '"""', close: '"""', escape: true, multiline: true },
    { open: "'''", close: "'''", escape: true, multiline: true },
    { open: '"', close: '"', escape: true, multiline: false },
    { open: "'", close: "'", escape: true, multiline: false },
  ],
  rust: [{ open: '"', close: '"', escape: true, multiline: true }],
  shell: [
    { open: '"', close: '"', escape: true, multiline: false },
    { open: "'", close: "'", escape: false, multiline: false },
  ],
};

const SYNTAX = {
  cStyle: { block: ["/*", "*/"], line: null, quotes: QUOTES.cStyle, rustAllow: false },
  default: { block: ["/*", "*/"], line: "mixed", quotes: QUOTES.javascript, leadingStar: true, rustAllow: true },
  html: { block: ["<!--", "-->"], line: null, quotes: QUOTES.cStyle, html: true, rustAllow: false },
  javascript: { block: ["/*", "*/"], line: "slash", quotes: QUOTES.javascript, rustAllow: false },
  python: { block: null, line: "hash", quotes: QUOTES.python, rustAllow: false },
  rust: { block: ["/*", "*/"], line: "slash", quotes: QUOTES.rust, rustRawStrings: true, rustAllow: true },
  shell: { block: null, line: "shellHash", quotes: QUOTES.shell, rustAllow: false },
};

const SYNTAX_BY_EXTENSION = new Map([
  [".ts", SYNTAX.javascript],
  [".tsx", SYNTAX.javascript],
  [".mts", SYNTAX.javascript],
  [".cts", SYNTAX.javascript],
  [".js", SYNTAX.javascript],
  [".jsx", SYNTAX.javascript],
  [".mjs", SYNTAX.javascript],
  [".cjs", SYNTAX.javascript],
  [".rs", SYNTAX.rust],
  [".py", SYNTAX.python],
  [".sh", SYNTAX.shell],
  [".css", SYNTAX.cStyle],
  [".html", SYNTAX.html],
]);

function extensionOf(path) {
  const dot = path.lastIndexOf(".");
  return dot > path.lastIndexOf("/") ? path.slice(dot) : "";
}

export function isSourcePath(path) {
  if (EXCLUDED_PATHS.has(path)) return false;
  return SOURCE_EXTENSIONS.has(extensionOf(path));
}

function syntaxFor(path) {
  return SYNTAX_BY_EXTENSION.get(extensionOf(path)) ?? SYNTAX.default;
}

function lineCommentLength(line, index, syntax) {
  if ((syntax.line === "slash" || syntax.line === "mixed") && line.startsWith("//", index)) return 2;
  if (syntax.line === "hash" || syntax.line === "mixed") {
    if (syntax.rustAllow && (line.startsWith("#[allow(", index) || line.startsWith("#![allow(", index))) {
      return 0;
    }
    return line[index] === "#" ? 1 : 0;
  }
  if (syntax.line !== "shellHash" || line[index] !== "#") return 0;
  if (index === 0 || /[\s;|&()]/.test(line[index - 1])) return 1;
  return 0;
}

function rustRawQuoteAt(line, index) {
  if (index > 0 && /[A-Za-z0-9_]/.test(line[index - 1])) return null;
  const match = /^(?:br|r)(#{0,255})"/.exec(line.slice(index));
  if (!match) return null;
  return { open: match[0], close: `"${match[1]}`, escape: false, multiline: true };
}

function quoteAt(line, index, syntax) {
  if (syntax.rustRawStrings) {
    const raw = rustRawQuoteAt(line, index);
    if (raw) return raw;
  }
  return syntax.quotes.find(({ open }) => line.startsWith(open, index)) ?? null;
}

function scanLine(line, syntax, initialState) {
  const commentText = Array(line.length).fill(" ");
  const unquotedCodeText = Array(line.length).fill(" ");
  let state = initialState;
  let index = 0;

  while (index < line.length) {
    if (state.kind === "blockComment") {
      const length = line.startsWith(state.close, index) ? state.close.length : 1;
      for (let offset = 0; offset < length; offset += 1) commentText[index + offset] = line[index + offset];
      index += length;
      if (length === state.close.length) state = state.resume;
      continue;
    }

    if (state.kind === "quote") {
      if (line.startsWith(state.close, index)) {
        index += state.close.length;
        state = state.resume;
      } else {
        index += state.escape && line[index] === "\\" ? 2 : 1;
      }
      continue;
    }

    const blockOpen = syntax.block?.[0];
    if (blockOpen && line.startsWith(blockOpen, index)) {
      const [open, close] = syntax.block;
      for (let offset = 0; offset < open.length; offset += 1) commentText[index + offset] = line[index + offset];
      index += open.length;
      state = { kind: "blockComment", close, resume: state };
      continue;
    }

    const lineComment = lineCommentLength(line, index, syntax);
    const leadingStar = syntax.leadingStar && line[index] === "*" && /^\s*$/.test(line.slice(0, index));
    if (lineComment || leadingStar) {
      for (let offset = index; offset < line.length; offset += 1) commentText[offset] = line[offset];
      index = line.length;
      continue;
    }

    const quote = (!syntax.html || state.kind === "htmlTag") && quoteAt(line, index, syntax);
    if (quote) {
      index += quote.open.length;
      state = {
        kind: "quote",
        close: quote.close,
        escape: quote.escape,
        multiline: quote.multiline,
        resume: state,
      };
      continue;
    }

    unquotedCodeText[index] = line[index];
    if (syntax.html && state.kind === "code" && line[index] === "<") state = HTML_TAG_STATE;
    else if (syntax.html && state.kind === "htmlTag" && line[index] === ">") state = CODE_STATE;
    index += 1;
  }

  if (state.kind === "quote" && !state.multiline) state = state.resume;
  return { commentText: commentText.join(""), unquotedCodeText: unquotedCodeText.join(""), state };
}

export function countText(text, path = "") {
  const counts = Object.fromEntries(Object.keys(MARKERS).map((key) => [key, 0]));
  const syntax = syntaxFor(path);
  let state = CODE_STATE;
  for (const line of text.split("\n")) {
    const scanned = scanLine(line, syntax, state);
    state = scanned.state;
    if (MARKERS.todoComments.test(scanned.commentText)) counts.todoComments += 1;
    if (MARKERS.eslintDisable.test(scanned.commentText)) counts.eslintDisable += 1;
    if (syntax.rustAllow && MARKERS.rustAllow.test(scanned.unquotedCodeText)) counts.rustAllow += 1;
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
