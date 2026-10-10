#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, "..");
const BASELINE_PATH = join(SCRIPT_DIR, "workaround-baseline.json");
const requireWeb = createRequire(join(REPO_ROOT, "web/package.json"));

const JAVASCRIPT_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const SOURCE_EXTENSIONS = new Set([
  ...JAVASCRIPT_EXTENSIONS,
  ".rs",
  ".py",
  ".sh",
  ".css",
  ".html",
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

const JS_LINE_TERMINATORS = /\r\n|[\n\r\u2028\u2029]/;
const CODE_STATE = Object.freeze({ kind: "code" });
const HTML_TAG_STATE = Object.freeze({ kind: "htmlTag" });
const QUOTES = {
  cStyle: [
    { open: '"', close: '"', escape: true, multiline: false },
    { open: "'", close: "'", escape: true, multiline: false },
  ],
  default: [
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
    { open: '"', close: '"', escape: true, multiline: true },
    { open: "'", close: "'", escape: false, multiline: true },
  ],
};

const SYNTAX = {
  cStyle: { block: ["/*", "*/"], line: null, quotes: QUOTES.cStyle, rustAllow: false },
  default: { block: ["/*", "*/"], line: "mixed", quotes: QUOTES.default, leadingStar: true, rustAllow: true },
  html: { block: ["<!--", "-->"], line: null, quotes: QUOTES.cStyle, html: true, rustAllow: false },
  python: { block: null, line: "hash", quotes: QUOTES.python, rustAllow: false },
  rust: {
    block: ["/*", "*/"],
    line: "slash",
    quotes: QUOTES.rust,
    rustRawStrings: true,
    rustAllow: true,
    nestedBlockComments: true,
  },
  shell: { block: null, line: "shellHash", quotes: QUOTES.shell, rustAllow: false },
};

const SYNTAX_BY_EXTENSION = new Map([
  [".rs", SYNTAX.rust],
  [".py", SYNTAX.python],
  [".sh", SYNTAX.shell],
  [".css", SYNTAX.cStyle],
  [".html", SYNTAX.html],
]);

let javascriptParser;

function extensionOf(path) {
  const dot = path.lastIndexOf(".");
  return dot > path.lastIndexOf("/") ? path.slice(dot) : "";
}

export function isSourcePath(path) {
  if (EXCLUDED_PATHS.has(path)) return false;
  return SOURCE_EXTENSIONS.has(extensionOf(path));
}

function getJavaScriptParser() {
  if (javascriptParser) return javascriptParser;
  try {
    const parser = requireWeb("typescript-eslint").parser;
    if (typeof parser?.parseForESLint !== "function") throw new TypeError("parseForESLint is unavailable");
    javascriptParser = parser;
    return javascriptParser;
  } catch (cause) {
    throw new Error("Workaround ratchet needs typescript-eslint. Run npm ci in web.", { cause });
  }
}

function countJavaScriptComments(text, path) {
  const parser = getJavaScriptParser();
  const filePath = isAbsolute(path) ? path : join(REPO_ROOT, path);
  let comments;
  try {
    const result = parser.parseForESLint(text, {
      comment: true,
      filePath,
      jsx: extensionOf(path) === ".jsx" || extensionOf(path) === ".tsx",
      loc: true,
      range: true,
      sourceType: "module",
    });
    comments = result.ast.comments ?? [];
  } catch (cause) {
    throw new Error(`Workaround ratchet could not parse ${path}: ${cause.message}`, { cause });
  }

  const todoLines = new Set();
  const eslintLines = new Set();
  for (const comment of comments) {
    for (const [offset, segment] of comment.value.split(JS_LINE_TERMINATORS).entries()) {
      const line = comment.loc.start.line + offset;
      if (MARKERS.todoComments.test(segment)) todoLines.add(line);
      if (MARKERS.eslintDisable.test(segment)) eslintLines.add(line);
    }
  }
  return { todoComments: todoLines.size, eslintDisable: eslintLines.size, rustAllow: 0 };
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

function rustCharLengthAt(line, index) {
  if (line[index] !== "'") return 0;
  const match = /^'(?:\\(?:['"\\nrt0]|x[0-9A-Fa-f]{2}|u\{[0-9A-Fa-f_]{1,6}\})|[^\r\n\\'])'/u.exec(
    line.slice(index),
  );
  return match?.[0].length ?? 0;
}

function quoteAt(line, index, syntax) {
  if (syntax.rustRawStrings) {
    const raw = rustRawQuoteAt(line, index);
    if (raw) return raw;
  }
  return syntax.quotes.find(({ open }) => line.startsWith(open, index)) ?? null;
}

function heredocDelimiterMatches(line, { delimiter, stripTabs }) {
  const candidate = stripTabs ? line.replace(/^\t+/, "") : line;
  return candidate === delimiter;
}

function shellQuoteEscaped(line, index) {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && line[i] === "\\"; i -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

function shellArithmeticOpenerAt(line, index) {
  if (line.startsWith("$((", index)) return { kind: "dollar", length: 3, depth: 2 };
  if (line.startsWith("((", index)) return { kind: "double", length: 2, depth: 2 };
  return null;
}

function parseShellHeredoc(line, index) {
  if (!line.startsWith("<<", index) || line.startsWith("<<<", index)) return null;
  let cursor = index + 2;
  let stripTabs = false;
  if (line[cursor] === "-") {
    stripTabs = true;
    cursor += 1;
  }
  let delimiter;
  if (line[cursor] === "'") {
    const end = line.indexOf("'", cursor + 1);
    if (end === -1) return null;
    delimiter = line.slice(cursor + 1, end);
    cursor = end + 1;
  } else if (line[cursor] === '"') {
    const end = line.indexOf('"', cursor + 1);
    if (end === -1) return null;
    delimiter = line.slice(cursor + 1, end);
    cursor = end + 1;
  } else {
    const match = /^[A-Za-z0-9_+-]+/.exec(line.slice(cursor));
    if (!match) return null;
    delimiter = match[0];
    cursor += match[0].length;
  }
  return { delimiter, stripTabs, endIndex: cursor };
}

function findMatchingBracket(text, openIndex, openChar, closeChar) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    if (text[i] === openChar) depth += 1;
    else if (text[i] === closeChar) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function countRustAllowMarkers(unquotedText) {
  let count = 0;
  let index = 0;
  while (index < unquotedText.length) {
    if (unquotedText[index] !== "#") {
      index += 1;
      continue;
    }
    let cursor = index + 1;
    if (unquotedText[cursor] === "!") cursor += 1;
    if (unquotedText[cursor] !== "[") {
      index += 1;
      continue;
    }
    const close = findMatchingBracket(unquotedText, cursor, "[", "]");
    if (close === -1) {
      index += 1;
      continue;
    }
    const inner = unquotedText.slice(cursor + 1, close);
    if (/\ballow\s*\(/.test(inner)) count += 1;
    index = close + 1;
  }
  return count;
}

function skipShellWhitespace(line, index) {
  while (index < line.length && /[\t ]/.test(line[index])) index += 1;
  return index;
}

function startShellHeredocState(line, index, resume) {
  const first = parseShellHeredoc(line, index);
  if (!first) return null;
  const queue = [];
  let endIndex = first.endIndex;
  while (true) {
    endIndex = skipShellWhitespace(line, endIndex);
    const next = parseShellHeredoc(line, endIndex);
    if (!next) break;
    queue.push({ delimiter: next.delimiter, stripTabs: next.stripTabs });
    endIndex = next.endIndex;
  }
  return {
    endIndex,
    state: {
      kind: "heredoc",
      delimiter: first.delimiter,
      stripTabs: first.stripTabs,
      queue,
      resume,
    },
  };
}

function advanceShellHeredocState(state) {
  const queue = state.queue ?? [];
  if (queue.length === 0) return state.resume;
  const next = queue[0];
  return {
    kind: "heredoc",
    delimiter: next.delimiter,
    stripTabs: next.stripTabs,
    queue: queue.slice(1),
    resume: state.resume,
  };
}

function scanLine(line, syntax, initialState) {
  const commentText = Array(line.length).fill(" ");
  const unquotedCodeText = Array(line.length).fill(" ");
  let state = initialState;
  let index = 0;

  while (index < line.length) {
    if (state.kind === "blockComment") {
      const [blockOpen, blockClose] = syntax.block ?? [];
      if (syntax.nestedBlockComments && blockOpen && line.startsWith(blockOpen, index)) {
        for (let offset = 0; offset < blockOpen.length; offset += 1) {
          commentText[index + offset] = line[index + offset];
        }
        index += blockOpen.length;
        state = { ...state, depth: state.depth + 1 };
        continue;
      }
      const closes = line.startsWith(state.close, index);
      const length = closes ? state.close.length : 1;
      for (let offset = 0; offset < length; offset += 1) commentText[index + offset] = line[index + offset];
      index += length;
      if (closes) {
        const depth = (state.depth ?? 1) - 1;
        state = depth === 0 ? state.resume : { ...state, depth };
      }
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

    if (state.kind === "ansiCQuote") {
      if (line[index] === "'") {
        index += 1;
        state = state.resume;
      } else if (line[index] === "\\") {
        index += Math.min(2, line.length - index);
      } else {
        index += 1;
      }
      continue;
    }

    if (state.kind === "shellArith") {
      if (line[index] === "(") state = { ...state, depth: state.depth + 1 };
      else if (line[index] === ")") {
        const depth = state.depth - 1;
        state = depth === 0 ? state.resume : { ...state, depth };
      }
      index += 1;
      continue;
    }

    const blockOpen = syntax.block?.[0];
    if (blockOpen && line.startsWith(blockOpen, index)) {
      const [open, close] = syntax.block;
      for (let offset = 0; offset < open.length; offset += 1) commentText[index + offset] = line[index + offset];
      index += open.length;
      state = { kind: "blockComment", close, resume: state, depth: 1 };
      continue;
    }

    if (syntax.line === "shellHash") {
      const arith = shellArithmeticOpenerAt(line, index);
      if (arith) {
        index += arith.length;
        state = { kind: "shellArith", depth: arith.depth, resume: state };
        continue;
      }
      if (line[index] === "$" && line[index + 1] === "'") {
        index += 2;
        state = { kind: "ansiCQuote", resume: state };
        continue;
      }
      const heredoc = startShellHeredocState(line, index, state);
      if (heredoc) {
        index = heredoc.endIndex;
        state = heredoc.state;
        continue;
      }
    }

    const lineComment = lineCommentLength(line, index, syntax);
    const leadingStar = syntax.leadingStar && line[index] === "*" && /^\s*$/.test(line.slice(0, index));
    if (lineComment || leadingStar) {
      for (let offset = index; offset < line.length; offset += 1) commentText[offset] = line[offset];
      index = line.length;
      continue;
    }

    if (syntax.rustRawStrings && line[index] === "'") {
      const length = rustCharLengthAt(line, index);
      if (length > 0) {
        index += length;
        continue;
      }
    }

    let quote = (!syntax.html || state.kind === "htmlTag") && quoteAt(line, index, syntax);
    if (quote && syntax.line === "shellHash" && shellQuoteEscaped(line, index)) quote = null;
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

function countNonJavaScriptText(text, path) {
  const counts = Object.fromEntries(Object.keys(MARKERS).map((key) => [key, 0]));
  const syntax = syntaxFor(path);
  let state = CODE_STATE;
  const unquotedLines = [];
  for (const line of text.split("\n")) {
    if (state.kind === "heredoc") {
      if (heredocDelimiterMatches(line, state)) state = advanceShellHeredocState(state);
      continue;
    }
    const scanned = scanLine(line, syntax, state);
    state = scanned.state;
    unquotedLines.push(scanned.unquotedCodeText);
    if (MARKERS.todoComments.test(scanned.commentText)) counts.todoComments += 1;
    if (MARKERS.eslintDisable.test(scanned.commentText)) counts.eslintDisable += 1;
  }
  if (syntax.rustAllow) counts.rustAllow = countRustAllowMarkers(unquotedLines.join("\n"));
  return counts;
}

export function countText(text, path = "") {
  if (JAVASCRIPT_EXTENSIONS.has(extensionOf(path))) return countJavaScriptComments(text, path);
  return countNonJavaScriptText(text, path);
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
