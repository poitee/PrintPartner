#!/usr/bin/env node
/**
 * Lint a pull request body for the required Evidence block and Exemption field.
 * Rules: docs/contributing/gate-evidence.md
 *
 * Usage:
 *   PR_BODY='...' node scripts/lint-pr-evidence.mjs
 *   node scripts/lint-pr-evidence.mjs --body-file path.md
 *   node scripts/lint-pr-evidence.mjs --stdin < body.md
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const VALID_EXEMPTIONS = Object.freeze([
  "docs-only",
  "ci-only",
  "dependency-only",
  "internal refactor",
]);

const EXEMPTION_NONE = "none";
const PLACEHOLDER_EXEMPTION =
  /^<?\s*none\s*\|\s*docs-only\s*\|\s*ci-only\s*\|\s*dependency-only\s*\|\s*internal refactor\s*>?$/i;

/** Chad's LAN instances (.x.80 / .x.81) must never be verification targets. */
const BANNED_LAN_IP = /\b192\.168(?:\.\d+){1,2}\.(?:80|81)\b/;

const FIELD_LABELS = Object.freeze({
  journey: "Journey exercised",
  steps: "Steps followed to produce the evidence",
  result: "Result observed",
  artifact:
    "Screenshot / recording / verify-skill output or trace",
  reason: "Exemption reason",
});

const EXEMPTION_LINE = /^[ \t]*Exemption[ \t]*:.*$/gim;

function stripHtmlComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, "");
}

/**
 * Leading container markup of a line, consumed left to right without
 * backtracking: whitespace, blockquote markers, and list markers.
 * Returns where the content starts, its column, and whether a `>` was seen.
 */
function containerPrefix(line) {
  let i = 0;
  let quote = false;
  for (;;) {
    while (line[i] === " " || line[i] === "\t") i += 1;
    if (line[i] === ">") {
      quote = true;
      i += 1;
      continue;
    }
    let j = i;
    if (line[j] === "-" || line[j] === "*" || line[j] === "+") {
      j += 1;
    } else {
      while (j < line.length && j - i < 9 && line[j] >= "0" && line[j] <= "9") j += 1;
      if (j === i || (line[j] !== "." && line[j] !== ")")) break;
      j += 1;
    }
    if (line[j] !== " " && line[j] !== "\t") break;
    i = j;
  }
  return { end: i, column: indentWidth(line.slice(0, i)), quote };
}

/** A fence opener after any container prefix; backtick openers hold no other backticks. */
function fenceOpener(line) {
  const prefix = containerPrefix(line);
  const open = line.slice(prefix.end).match(/^(`{3,}(?=[^`]*$)|~{3,})/);
  return open ? { marker: open[1], ...prefix } : null;
}

/**
 * Whether a line still belongs to an open fence's container. A fence inside a
 * blockquote ends at the first line without `>`; a fence inside a list item or
 * indented under one ends at the first non-blank line left of its column.
 */
function insideFenceContainer(line, fence) {
  if (fence.quote) return /^[ \t]*>/.test(line);
  return !line.trim() || indentWidth(line.match(/^[ \t]*/)[0]) >= fence.column;
}

/**
 * The body as a reviewer sees it: no CRLF, fenced code, or HTML comments. Fence
 * lines become blank lines so the text after a fence is not read as a lazy
 * continuation of the paragraph before it. One pass in document order, so
 * comment text cannot open a fence and fence text cannot hide a comment. A
 * closing fence uses the same character and at least the opening length; a
 * fence also ends with its container, and an unclosed top-level fence runs to
 * the end of the text.
 */
function stripHiddenMarkdown(text) {
  const kept = [];
  let fence = null;
  let inComment = false;
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    if (fence && !insideFenceContainer(raw, fence)) fence = null;
    if (fence) {
      const close = raw.slice(containerPrefix(raw).end).match(/^(`{3,}|~{3,})[ \t]*$/);
      if (close && close[1][0] === fence.marker[0] && close[1].length >= fence.marker.length) {
        fence = null;
      }
      kept.push("");
      continue;
    }
    if (!inComment) {
      fence = fenceOpener(raw);
      if (fence) {
        kept.push("");
        continue;
      }
    }
    let line = raw;
    let visible = "";
    for (;;) {
      if (inComment) {
        const end = line.indexOf("-->");
        if (end === -1) break;
        line = line.slice(end + 3);
        inComment = false;
      } else {
        const start = line.indexOf("<!--");
        if (start === -1) {
          visible += line;
          break;
        }
        visible += line.slice(0, start);
        line = line.slice(start + 4);
        inComment = true;
      }
    }
    kept.push(visible);
  }
  return kept.join("\n");
}

function normalizeWs(text) {
  return text.replace(/\r\n/g, "\n").trim();
}

/**
 * Extract the ## Evidence section body (without the heading).
 * Returns null when the heading is missing.
 */
export function extractEvidenceSection(body) {
  if (typeof body !== "string" || !body.trim()) return null;
  const visible = stripHiddenMarkdown(body);
  const match = visible.match(/^##\s+Evidence\s*$/im);
  if (!match || match.index == null) return null;
  const start = match.index + match[0].length;
  const rest = visible.slice(start);
  const nextHeading = rest.search(/^##\s+/m);
  const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  return section;
}

function parseExemption(sectionText) {
  const cleaned = stripHtmlComments(sectionText);
  const match = cleaned.match(/^[ \t]*Exemption[ \t]*:(.*)$/im);
  if (!match) return { raw: null, value: null };
  const raw = match[1].trim();
  if (!raw || PLACEHOLDER_EXEMPTION.test(raw)) {
    return { raw, value: null };
  }
  const lower = raw.toLowerCase();
  if (lower === EXEMPTION_NONE) return { raw, value: EXEMPTION_NONE };
  // Accept only the documented spellings (no open-ended prefix match).
  if (
    lower === "internal refactor" ||
    lower === "internal refactor with no user-visible change"
  ) {
    return { raw, value: "internal refactor" };
  }
  if (VALID_EXEMPTIONS.includes(lower)) return { raw, value: lower };
  return { raw, value: null, unknown: true };
}

function fieldLabelPattern(label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (label === FIELD_LABELS.reason) {
    return `${escaped}(?:[ \\t]*\\([^)]*\\))?`;
  }
  return escaped;
}

/** Any Markdown list marker: bullet (-, *, +) or ordered (1. / 1)). */
const LIST_MARKER = "(?:[-*+]|\\d{1,9}[.)])";

const LABEL_LINE = new RegExp(
  `^([ \\t]*)(${LIST_MARKER})([ \\t]*)(${Object.values(FIELD_LABELS).map(fieldLabelPattern).join("|")})[ \\t]*:[ \\t]*(.*)$`,
  "i",
);

/** A line that ends any field regardless of indentation. */
const EXEMPTION_START = /^[ \t]*Exemption[ \t]*:/i;

/** CommonMark HTML blocks that can interrupt a paragraph (types 1 and 3-6). */
const HTML_BLOCK_START = new RegExp(
  `^[ \\t]*(?:<(?:script|pre|style|textarea)(?:[\\s>]|$)|<\\?|<![A-Za-z]|<!\\[CDATA\\[|</?(?:${[
    "address", "article", "aside", "base", "basefont", "blockquote", "body", "caption",
    "center", "col", "colgroup", "dd", "details", "dialog", "dir", "div", "dl", "dt",
    "fieldset", "figcaption", "figure", "footer", "form", "frame", "frameset",
    "h[1-6]", "head", "header", "hr", "html", "iframe", "legend", "li", "link", "main",
    "menu", "menuitem", "nav", "noframes", "ol", "optgroup", "option", "p", "param",
    "search", "section", "summary", "table", "tbody", "td", "tfoot", "th", "thead",
    "title", "tr", "track", "ul",
  ].join("|")})(?:[\\s/>]|$))`,
  "i",
);

/** Non-paragraph blocks: no lazy continuation line can follow them. */
const LEAF_BLOCK_START = new RegExp(
  `^[ \\t]*(?:#{1,6}(?:[ \\t]|$)|(?:[-*_][ \\t]*){3,}$)|${HTML_BLOCK_START.source}`,
  "i",
);

/**
 * Blocks that interrupt a paragraph and, outside a list item's content column,
 * end the item: list items of any marker, ATX headings, blockquotes, thematic
 * breaks, and HTML blocks.
 */
const BLOCK_START = new RegExp(
  `^[ \\t]*(?:${LIST_MARKER}(?:[ \\t]|$)|>)|${LEAF_BLOCK_START.source}`,
  "i",
);

/** Indentation width of a line prefix (tabs to the next stop of 4). */
function indentWidth(prefix) {
  let width = 0;
  for (const ch of prefix) width = ch === "\t" ? width + 4 - (width % 4) : width + 1;
  return width;
}

function labelKey(text) {
  const lower = text.toLowerCase();
  return Object.values(FIELD_LABELS).find((label) => lower.startsWith(label.toLowerCase()));
}

/**
 * Split comment-free section text into template fields in one pass. A field is
 * its label line plus every line that belongs to that list item in Markdown:
 * lazy continuation lines and, after a blank line, blocks indented to the
 * item's content column (nested lists, later paragraphs, even nested field
 * labels). It ends at an outer field label, the Exemption line, a block left
 * of the content column that follows a blank line or a heading, rule, or HTML
 * block (no lazy continuation there), or any outer list item, heading,
 * blockquote, rule, or HTML block.
 *
 * Lazy continuation lines (left of the content column) are ambiguous across
 * Markdown renderers, so each field records them in `lazy`: they count as
 * field text, yet callers can keep them visible to the .80/.81 check.
 */
function parseFields(cleaned) {
  const fields = [];
  let current = null;
  let blankSeen = false;
  let lazyOk = false;
  let offset = 0;
  for (const line of cleaned.split("\n")) {
    const lineStart = offset;
    offset += line.length + 1;
    const end = Math.min(offset, cleaned.length);

    const indent = indentWidth(line.match(/^[ \t]*/)[0]);
    const labeled = line.match(LABEL_LINE);
    if (labeled && !(current && indent >= current.contentIndent)) {
      const [, lead, marker, gap, label, rest] = labeled;
      const markerEnd = indentWidth(lead + " ".repeat(marker.length));
      const gapWidth = indentWidth(lead + " ".repeat(marker.length) + gap) - markerEnd;
      current = {
        label: labelKey(label),
        contentIndent: markerEnd + (gapWidth >= 1 && gapWidth <= 4 ? gapWidth : 1),
        lines: rest.trim() ? [rest.trim()] : [],
        lazy: [],
        start: lineStart,
        end,
      };
      fields.push(current);
      blankSeen = false;
      lazyOk = true;
      continue;
    }
    if (!current) continue;

    const trimmed = line.trim();
    if (!trimmed) {
      blankSeen = true;
      continue;
    }
    const outer = indent < current.contentIndent;
    if (
      EXEMPTION_START.test(line) ||
      (outer && (blankSeen || !lazyOk || BLOCK_START.test(line)))
    ) {
      current = null;
      continue;
    }
    current.lines.push(trimmed);
    if (outer) current.lazy.push({ start: lineStart, end });
    current.end = end;
    blankSeen = false;
    lazyOk = !LEAF_BLOCK_START.test(line);
  }
  return fields.map(({ label, lines, lazy, start, end }) => ({
    label,
    value: lines.join(" ").trim(),
    text: lines.join("\n"),
    lazy,
    start,
    end,
  }));
}

/**
 * Read a template field value (same line and the lines that belong to it).
 */
function findField(sectionText, label) {
  return parseFields(stripHtmlComments(sectionText)).find((field) => field.label === label);
}

function readField(sectionText, label) {
  return findField(sectionText, label)?.value ?? "";
}

/**
 * Section text with HTML comments removed and the given fields cut out. With
 * keepLazy, the fields' lazy continuation lines stay in the text.
 */
function withoutFields(sectionText, labels, { keepLazy = false } = {}) {
  const text = stripHtmlComments(sectionText);
  let kept = "";
  let cursor = 0;
  for (const field of parseFields(text)) {
    if (!labels.includes(field.label)) continue;
    kept += text.slice(cursor, field.start);
    if (keepLazy) for (const line of field.lazy) kept += text.slice(line.start, line.end);
    cursor = field.end;
  }
  return kept + text.slice(cursor);
}

function extractExemptionReason(sectionText) {
  return readField(sectionText, FIELD_LABELS.reason);
}

/** Category names and placeholders that say what an artifact is without being one. */
const NON_ARTIFACT_WORD =
  /^(?:evidence|screenshot|recording|verify-skill|trace|output|n\/?a|none|tbd|todo)$/i;

/**
 * Inline code spans in document order. Linear scan: each backtick run opens a
 * span closed by the next run of the same length; unmatched runs are literal.
 */
function codeSpans(value) {
  const runs = [...value.matchAll(/`+/g)].map((m) => ({ at: m.index, len: m[0].length }));
  const byLength = new Map();
  runs.forEach((run, index) => {
    if (!byLength.has(run.len)) byLength.set(run.len, { indexes: [], next: 0 });
    byLength.get(run.len).indexes.push(index);
  });
  const spans = [];
  for (let i = 0; i < runs.length; i += 1) {
    const same = byLength.get(runs[i].len);
    while (same.next < same.indexes.length && same.indexes[same.next] <= i) same.next += 1;
    if (same.next === same.indexes.length) continue;
    const close = same.indexes[same.next];
    spans.push(value.slice(runs[i].at + runs[i].len, runs[close].at));
    i = close;
  }
  return spans;
}

/**
 * Inline code counts only when it holds a command, path, or output: something
 * with whitespace or path/URL punctuation that is not a bare category word.
 */
function hasSubstantiveCodeSpan(value) {
  return codeSpans(value).some((span) => {
    const content = span.trim();
    return content && !NON_ARTIFACT_WORD.test(content) && /[\s/.:=]/.test(content);
  });
}

/** File extensions for screenshots, recordings, traces, logs, and archives. */
const ARTIFACT_EXTENSION =
  /\.(?:png|jpe?g|gif|webp|avif|svg|bmp|tiff?|heic|heif|jxl|mp4|m4v|webm|mov|mkv|avi|ogv|gifv|cast|json|jsonl|ndjson|har|trace|pcap|sarif|txt|log|out|md|html?|csv|xml|ya?ml|pdf|zip|gz|tgz|tar|7z|xz|zst|bz2)$/i;

/**
 * A concrete file path: a known artifact extension, or a directory path ending
 * in a file name with an extension (`evidence/run-42/out.trace`).
 */
function isArtifactPath(token) {
  if (!/^[\w.@%+~/-]+$/.test(token) || /^\.*$/.test(token)) return false;
  const name = token.slice(token.lastIndexOf("/") + 1);
  if (!name || NON_ARTIFACT_WORD.test(name)) return false;
  return ARTIFACT_EXTENSION.test(name) || (token.includes("/") && /\.[a-z][a-z0-9]{0,7}$/i.test(name));
}

const LEADING_PUNCTUATION = new Set("(<\"'`");
const TRAILING_PUNCTUATION = new Set(")>\"'`.,;:!?");

/** Strip surrounding punctuation with index loops (no backtracking regex). */
function trimToken(token) {
  let start = 0;
  let end = token.length;
  while (start < end && LEADING_PUNCTUATION.has(token[start])) start += 1;
  while (end > start && TRAILING_PUNCTUATION.has(token[end - 1])) end -= 1;
  return token.slice(start, end);
}

function mentionsArtifactPath(value) {
  return value.split(/\s+/).map(trimToken).some(isArtifactPath);
}

const HTTP_URL = /https?:\/\/[^\s/?#<>()"'`]+/i;

/** A link destination that identifies something: a web URL or a file path. */
function isConcreteTarget(destination) {
  const target = destination.replace(/^<|>$/g, "").replace(/\\(.)/g, "$1").trim();
  if (/^https?:\/\/[^\s/?#<>]+/i.test(target)) return true;
  // Relative paths only: no anchors, queries, or other schemes (mailto:, javascript:).
  if (!target || /^[#?]/.test(target) || /^[a-z][a-z0-9+.-]*:/i.test(target)) return false;
  const path = target.split(/[?#]/)[0];
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (!name || NON_ARTIFACT_WORD.test(name)) return false;
  return ARTIFACT_EXTENSION.test(name) || (path.includes("/") && /\.[a-z][a-z0-9]{0,7}$/i.test(name));
}

const isSpace = (ch) => ch === " " || ch === "\t" || ch === "\n";

/**
 * Parse the inline link tail that starts at `(` (index `open`): destination,
 * optional "", '', or () title with backslash escapes, then `)`. Returns the
 * destination and the index after `)`, or null when it is not a link tail.
 */
function parseLinkTail(text, open) {
  let i = open + 1;
  while (isSpace(text[i])) i += 1;
  let destination = "";
  if (text[i] === "<") {
    const close = text.indexOf(">", i);
    if (close === -1 || text.slice(i, close).includes("\n")) return null;
    destination = text.slice(i, close + 1);
    i = close + 1;
  } else {
    const start = i;
    let depth = 0;
    for (; i < text.length && !isSpace(text[i]); i += 1) {
      if (text[i] === "\\") i += 1;
      else if (text[i] === "(") depth += 1;
      else if (text[i] === ")") {
        if (depth === 0) break;
        depth -= 1;
      }
    }
    destination = text.slice(start, i);
  }
  const afterDestination = i;
  while (isSpace(text[i])) i += 1;
  const closer = { '"': '"', "'": "'", "(": ")" }[text[i]];
  if (closer && i > afterDestination) {
    for (i += 1; i < text.length && text[i] !== closer; i += 1) {
      if (text[i] === "\\") i += 1;
      else if (closer === ")" && text[i] === "(") return null;
    }
    if (i >= text.length) return null;
    i += 1;
    while (isSpace(text[i])) i += 1;
  }
  return text[i] === ")" ? { destination, end: i + 1 } : null;
}

/**
 * Remove link reference definitions and inline link tails (`](…)`), noting
 * whether any destination is concrete. Link text is kept: it is ordinary text.
 * A `](` that does not form a link tail hides the rest of the value (fail
 * closed), so a malformed title can never surface as an artifact. Every scan
 * moves forward, so the whole pass is linear.
 */
function stripLinks(value) {
  let concrete = false;
  const lines = value.split("\n").filter((line) => {
    const definition = line.match(/^[ \t]*\[[^\]\n]{1,999}\]:[ \t]*(<[^>\n]*>|\S+)/);
    if (!definition) return true;
    if (isConcreteTarget(definition[1])) concrete = true;
    return false;
  });
  const text = lines.join("\n");
  let rest = "";
  let cursor = 0;
  for (let at = text.indexOf("](", cursor); at !== -1; at = text.indexOf("](", cursor)) {
    rest += `${text.slice(cursor, at)}] `;
    const tail = parseLinkTail(text, at + 1);
    if (!tail) return { rest, concrete };
    if (isConcreteTarget(tail.destination)) concrete = true;
    cursor = tail.end;
  }
  return { rest: rest + text.slice(cursor), concrete };
}

function looksLikeArtifact(value) {
  if (!value) return false;
  // A link counts by its destination; its title never makes it evidence.
  const { rest, concrete } = stripLinks(value);
  if (concrete) return true;
  if (HTTP_URL.test(rest)) return true;
  if (hasSubstantiveCodeSpan(rest)) return true;
  return mentionsArtifactPath(rest);
}

/** Section text outside every template field and the Exemption line. */
function freeformText(sectionText) {
  return withoutFields(sectionText, Object.values(FIELD_LABELS)).replace(
    EXEMPTION_LINE,
    "",
  );
}

/**
 * Evidence requires steps, observed result, and a concrete artifact: either the
 * artifact field or freeform text outside the template fields. A journey name,
 * a bare category word, or exemption-reason text cannot pass.
 */
export function hasEvidenceContent(sectionText) {
  const steps = readField(sectionText, FIELD_LABELS.steps);
  const result = readField(sectionText, FIELD_LABELS.result);
  const artifact = findField(sectionText, FIELD_LABELS.artifact)?.text ?? "";
  if (!steps || !result) return false;
  return looksLikeArtifact(artifact) || looksLikeArtifact(freeformText(sectionText));
}

/**
 * Verification content must never target Chad's LAN instances, whatever the
 * exemption. Mentions only in the Exemption reason or Exemption line are allowed;
 * reason lines must sit in its content column (lazy lines stay checked).
 */
function targetsBannedLan(sectionText) {
  const verification = withoutFields(sectionText, [FIELD_LABELS.reason], {
    keepLazy: true,
  }).replace(
    EXEMPTION_LINE,
    "",
  );
  return BANNED_LAN_IP.test(verification);
}

/**
 * @param {string | null | undefined} body
 * @returns {{ ok: boolean, errors: string[], exemption: string | null, hasEvidence: boolean }}
 */
export function lintPrEvidence(body) {
  const errors = [];
  if (typeof body !== "string" || !normalizeWs(body)) {
    return {
      ok: false,
      errors: ["PR body is empty; Evidence block and Exemption field are required."],
      exemption: null,
      hasEvidence: false,
    };
  }

  const section = extractEvidenceSection(body);
  if (section == null) {
    return {
      ok: false,
      errors: [
        'Missing "## Evidence" section. See docs/contributing/gate-evidence.md.',
      ],
      exemption: null,
      hasEvidence: false,
    };
  }

  const { raw, value, unknown } = parseExemption(section);
  const reason = extractExemptionReason(section);
  const hasEvidence = hasEvidenceContent(section);

  if (targetsBannedLan(section)) {
    errors.push(
      "Evidence must not target Chad's LAN instances (.80/.81). Use a disposable local verify instance instead. (To mention these hosts in the Exemption reason, indent every reason line under its bullet.)",
    );
  }

  if (raw == null) {
    errors.push('Missing "Exemption:" field in the Evidence section.');
  } else if (unknown) {
    errors.push(
      `Unknown Exemption "${raw}". Use none, or one of: ${VALID_EXEMPTIONS.join(", ")}.`,
    );
  } else if (value == null) {
    errors.push(
      'Exemption is still the template placeholder. Set "Exemption: none" with evidence, or name a valid exemption with a reason.',
    );
  } else if (value === EXEMPTION_NONE) {
    if (!hasEvidence) {
      errors.push(
        "Evidence is incomplete. For Exemption: none, fill Steps followed, Result observed, and Screenshot/recording/verify-skill output or trace (a journey name alone is not enough).",
      );
    }
  } else if (VALID_EXEMPTIONS.includes(value)) {
    if (!reason) {
      errors.push(
        `Exemption "${value}" requires a non-empty Exemption reason (for docs/CI-only and other exempt PRs).`,
      );
    }
  }

  if (errors.length === 0 && !hasEvidence && value === EXEMPTION_NONE) {
    errors.push("Evidence block is empty and no valid Exemption reason was given.");
  }

  return {
    ok: errors.length === 0,
    errors,
    exemption: value,
    hasEvidence,
  };
}

function parseArgs(argv) {
  const args = { bodyFile: null, stdin: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--stdin") args.stdin = true;
    else if (arg === "--body-file") {
      const next = argv[++i];
      if (!next) throw new Error("--body-file requires a path");
      args.bodyFile = next;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function readBody(args) {
  if (args.bodyFile) return readFileSync(args.bodyFile, "utf8");
  if (args.stdin) return readFileSync(0, "utf8");
  if (process.env.PR_BODY != null) return process.env.PR_BODY;
  throw new Error("Provide PR body via PR_BODY, --body-file, or --stdin");
}

export function main(argv = process.argv.slice(2), io = console) {
  const args = parseArgs(argv);
  if (args.help) {
    io.log(`Usage:
  PR_BODY='...' node scripts/lint-pr-evidence.mjs
  node scripts/lint-pr-evidence.mjs --body-file path.md
  node scripts/lint-pr-evidence.mjs --stdin < body.md`);
    return 0;
  }
  const body = readBody(args);
  const result = lintPrEvidence(body);
  if (result.ok) {
    io.log(
      `PR evidence lint OK (exemption=${result.exemption ?? "n/a"}, hasEvidence=${result.hasEvidence})`,
    );
    return 0;
  }
  io.error("PR evidence lint FAILED:");
  for (const error of result.errors) io.error(`- ${error}`);
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main();
}
