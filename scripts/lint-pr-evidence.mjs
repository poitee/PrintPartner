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
// WHATWG HTML named characters: https://html.spec.whatwg.org/entities.json
// Vendored so the standalone checker needs no package install or network.
import NAMED_CHARACTER_REFERENCES from "./html-named-character-references.json" with { type: "json" };

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
const BANNED_LAN_IP = /\b192\.168\.\d{1,3}\.(?:80|81)\b(?!\.)/;

const FIELD_LABELS = Object.freeze({
  journey: "Journey exercised",
  steps: "Steps followed to produce the evidence",
  result: "Result observed",
  artifact:
    "Screenshot / recording / verify-skill output or trace",
  reason: "Exemption reason",
});

const EXEMPTION_LINE = /^[ \t]*Exemption[ \t]*:.*$/gim;

/**
 * Leading container markup of a line, consumed left to right without
 * backtracking: whitespace, blockquote markers, and list markers.
 * Returns where the content starts, its column, and how many `>` were seen.
 */
function containerPrefix(line) {
  let i = 0;
  let quote = 0;
  for (;;) {
    while (line[i] === " " || line[i] === "\t") i += 1;
    if (line[i] === ">") {
      quote += 1;
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
function quoteContent(line, depth) {
  let rest = line;
  for (let n = 0; n < depth; n += 1) {
    const marker = rest.match(/^[ ]{0,3}>[ ]?/);
    if (!marker) return null;
    rest = rest.slice(marker[0].length);
  }
  return rest;
}

function fenceOpener(line, listColumn = 0) {
  const prefix = containerPrefix(line);
  const open = line.slice(prefix.end).match(/^(`{3,}(?=[^`]*$)|~{3,})/);
  if (!open) return null;
  const content = quoteContent(line, prefix.quote);
  const hasList = /^[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]/.test(content);
  const column = hasList
    ? containerPrefix(content).column
    : (prefix.quote ? 0 : listColumn);
  return { marker: open[1], ...prefix, column };
}

/**
 * Whether a line still belongs to an open fence's container. A fence inside a
 * blockquote ends at the first line with fewer `>` markers; a fence inside a
 * list item or indented under one ends at the first non-blank line left of
 * its column.
 */
function insideFenceContainer(line, fence) {
  const content = quoteContent(line, fence.quote);
  if (content == null) return false;
  return !content.trim() || indentWidth(content.match(/^[ \t]*/)[0]) >= fence.column;
}

/**
 * The body as a reviewer sees it: no CRLF, fenced code, or HTML comments. Fence
 * lines become blank lines so the text after a fence is not read as a lazy
 * continuation of the paragraph before it. One pass in document order, so
 * comment text cannot open a fence and fence text cannot hide a comment. A
 * closing fence uses the same character and at least the opening length; a
 * fence also ends with its container, and an unclosed top-level fence runs to
 * the end of the text. `onLiteralLine` reports code, raw HTML, and comment
 * suffixes with their boundaries, so payload cannot impersonate metadata.
 */
// One body is stripped several times with the same text. Keep the last result.
let stripSlot = null;

function stripHiddenMarkdown(text, { inlineMultiline = true, includeRawHtml = false, onLiteralLine } = {}) {
  if (!onLiteralLine && stripSlot?.text === text && stripSlot.inlineMultiline === inlineMultiline && stripSlot.includeRawHtml === includeRawHtml) {
    return stripSlot.value;
  }
  const value = stripHiddenMarkdownCompute(text, { inlineMultiline, includeRawHtml, onLiteralLine });
  if (!onLiteralLine) stripSlot = { text, inlineMultiline, includeRawHtml, value };
  return value;
}

function rawHtmlArtifactMarker(value, state) {
  let marker = false;
  let cursor = 0;
  for (let index = value.indexOf("<"); index !== -1; index = value.indexOf("<", cursor)) {
    const tag = readHtmlTag(value, index);
    if (!state.hiddenTag && state.anchor && anchorVisible(value.slice(cursor, index))) marker = true;
    if (!tag) { cursor = index + 1; continue; }
    if (state.hiddenTag) {
      if (tag.closing && tag.name === state.hiddenTag) state.hiddenTag = null;
    } else if (["pre", "script", "style", "textarea"].includes(tag.name) && !tag.closing) {
      state.hiddenTag = tag.name;
    } else if (tag.name === "a") {
      state.anchor = !tag.closing && isConcreteTarget(decodeCharacterReferences(htmlAttribute(tag.tag, "href"), { htmlNumeric: true, dropBreaks: true }));
    } else if (tag.name === "img" && !tag.closing) {
      const destination = decodeCharacterReferences(htmlAttribute(tag.tag, "src"), { htmlNumeric: true, dropBreaks: true });
      if (isConcreteTarget(destination)) marker = true;
    }
    cursor = tag.end;
  }
  if (!state.hiddenTag && state.anchor && anchorVisible(value.slice(cursor))) marker = true;
  return marker;
}

function stripHiddenMarkdownCompute(text, { inlineMultiline = true, includeRawHtml = false, onLiteralLine } = {}) {
  const kept = [];
  let fence = null;
  let inComment = false;
  let inlineComment = false;
  let listColumn = 0;
  let htmlBlock = null;
  let indentedCode = null;
  let paragraphOpen = false;
  let referenceEnd = -1;
  const sourceLines = text.replace(/\r\n/g, "\n").split("\n");
  const referenceLines = referenceContainerLines(sourceLines.join("\n"));
  for (const [lineIndex, raw] of sourceLines.entries()) {
    const indent = indentWidth(raw.match(/^[ \t]*/)[0]);
    if (htmlBlock && !insideFenceContainer(raw, htmlBlock)) htmlBlock = null;
    if (htmlBlock) {
      const visible = stripHtmlComments(raw, htmlBlock.commentOpen);
      htmlBlock.commentOpen = visible.open;
      if (includeRawHtml) onLiteralLine?.(lineIndex, visible.visible);
      const marker = !htmlBlock.rawTag && rawHtmlArtifactMarker(visible.visible, htmlBlock);
      if (htmlBlock.end.test(quoteContent(raw, htmlBlock.quote))) htmlBlock = null;
      kept.push(marker ? "\u0001" : "");
      paragraphOpen = false;
      continue;
    }
    if (indentedCode != null) {
      if (!raw.trim() || indent >= indentedCode) {
        onLiteralLine?.(lineIndex, raw);
        kept.push("");
        continue;
      }
      indentedCode = null;
    }
    if (!fence && !inComment && !paragraphOpen && indent >= listColumn + 4) {
      indentedCode = listColumn + 4;
      onLiteralLine?.(lineIndex, raw);
      kept.push("");
      continue;
    }
    if (fence && !insideFenceContainer(raw, fence)) fence = null;
    if (fence) {
      const content = quoteContent(raw, fence.quote);
      const indent = indentWidth(content.match(/^[ \t]*/)[0]);
      const close = indent <= fence.column + 3
        ? content.trimStart().match(/^(`{3,}|~{3,})[ \t]*$/)
        : null;
      if (close && close[1][0] === fence.marker[0] && close[1].length >= fence.marker.length) {
        fence = null;
      }
      onLiteralLine?.(lineIndex, raw, { boundary: !fence, delimiter: !fence });
      // Fence payload stays field prose. The marker keeps it from becoming a heading,
      // an exemption declaration, or an artifact citation.
      if (fence && content != null) {
        const lead = content.match(/^[ \t]*/)[0];
        kept.push(`${lead}\u0000${content.slice(lead.length)}`);
      } else kept.push("");
      continue;
    }
    if (!inComment) {
      const list = raw.match(/^[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+/);
      if (list) listColumn = indentWidth(list[0]);
      else if (raw.trim() && indentWidth(raw.match(/^[ \t]*/)[0]) < listColumn) listColumn = 0;
      fence = fenceOpener(raw, listColumn);
      if (fence) {
        onLiteralLine?.(lineIndex, raw, { boundary: true, delimiter: true });
        kept.push("");
        paragraphOpen = false;
        continue;
      }
      const prefix = containerPrefix(raw);
      const content = raw.slice(prefix.end);
      const rawTag = content.match(/^<(pre|script|style|textarea)(?:[ \t>]|$)/i);
      if (rawTag || HTML_BLOCK_START.test(content)
        || (!paragraphOpen && isCompleteHtmlTag(content))) {
        const quoteLine = quoteContent(raw, prefix.quote);
        const hasList = /^[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]/.test(quoteLine);
        const end = rawTag ? new RegExp(`</${rawTag[1]}[ \\t]*>`, "i")
          : content.startsWith("<?") ? /\?>/
          : content.startsWith("<![CDATA[") ? /\]\]>/
          : /^<![A-Za-z]/.test(content) ? />/
          : /^\s*$/;
        htmlBlock = { end, rawTag: Boolean(rawTag), quote: prefix.quote,
          column: hasList ? containerPrefix(quoteLine).column : (prefix.quote ? 0 : listColumn) };
        const visible = stripHtmlComments(raw);
        htmlBlock.commentOpen = visible.open;
        if (includeRawHtml) onLiteralLine?.(lineIndex, visible.visible, { boundary: true });
        if (end.test(content)) htmlBlock = null;
        // A complete image or anchor is an artifact, but its attributes are not metadata.
        let keptLine = "";
        if (!rawTag && !HTML_BLOCK_START.test(content) && isCompleteHtmlTag(content)) {
          const marked = htmlConcreteMarker(content);
          if (marked.includes("\u0001")) {
            const tagAt = content.indexOf("<");
            const tag = readHtmlTag(content, tagAt);
            const destination = tag
              ? decodeCharacterReferences(htmlAttribute(tag.tag, tag.name === "img" ? "src" : "href"), { htmlNumeric: true, dropBreaks: true })
              : "";
            const lead = content.match(/^[ \t]*/)[0];
            keptLine = `${lead}${destination}`;
          }
        }
        if (!rawTag && rawHtmlArtifactMarker(visible.visible, htmlBlock ?? {})) keptLine = "\u0001";
        kept.push(keptLine);
        paragraphOpen = false;
        continue;
      }
    }
    let line = raw;
    if (inComment) {
      const end = line.indexOf("-->");
      // An inline comment cannot cross a paragraph break.
      if (inlineComment && !line.trim()) {
        inComment = false;
      } else if (end === -1) {
        kept.push("");
        continue;
      } else {
        const blockComment = !inlineComment;
        line = line.slice(end + 3);
        inComment = false;
        if (blockComment) {
          const suffix = stripHtmlComments(line);
          inComment = suffix.open;
          if (includeRawHtml) onLiteralLine?.(lineIndex, raw.match(/^[ \t]*/)[0] + suffix.visible.trimStart(), { boundary: true });
          kept.push("");
          paragraphOpen = false;
          continue;
        }
      }
    } else if (line.slice(containerPrefix(line).end).startsWith("<!--")) {
      // An HTML block comment hides everything up to its closing -->.
      const start = line.indexOf("<!--");
      const end = line.indexOf("-->", start + 4);
      if (end === -1) {
        inComment = true;
        inlineComment = false;
        kept.push("");
        paragraphOpen = false;
        continue;
      }
      const suffix = stripHtmlComments(line.slice(end + 3));
      inComment = suffix.open;
      inlineComment = false;
      if (includeRawHtml) onLiteralLine?.(lineIndex, raw.match(/^[ \t]*/)[0] + suffix.visible.trimStart(), { boundary: true });
      kept.push("");
      paragraphOpen = false;
      continue;
    }
    // Inline comments must close on the line; an unclosed, escaped, or
    // code-span `<!--` is literal text, as Markdown renders it.
    const inline = stripInlineComments(line, inlineMultiline);
    if (inline.open) {
      inComment = true;
      inlineComment = true;
    }
    const shown = inline.visible;
    kept.push(shown);
    if (!paragraphOpen && lineIndex > referenceEnd) {
      const definition = referenceDestination(referenceLines, lineIndex);
      if (definition) referenceEnd = definition.end;
    }
    paragraphOpen = lineIndex > referenceEnd && Boolean(shown.trim()) && !LEAF_BLOCK_START.test(shown);
  }
  return kept.join("\n");
}

function stripHtmlComments(line, open = false) {
  let visible = "";
  let cursor = 0;
  while (cursor < line.length) {
    const marker = line.indexOf(open ? "-->" : "<!--", cursor);
    if (marker === -1) {
      if (!open) visible += line.slice(cursor);
      break;
    }
    if (!open) visible += line.slice(cursor, marker);
    cursor = marker + (open ? 3 : 4);
    open = !open;
  }
  return { visible, open };
}

/**
 * Remove inline `<!-- … -->` comments from one line, skipping escaped openers
 * and openers inside code spans. An opener without `-->` on the line is
 * literal when `multiline` is false; otherwise it hides the rest of the line
 * and `open` reports that the comment continues.
 */
function stripInlineComments(line, multiline) {
  const code = codeSpanRanges(line);
  let kept = "";
  let cursor = 0;
  let span = 0;
  for (let start = line.indexOf("<!--"); start !== -1; start = line.indexOf("<!--", start + 1)) {
    if (start < cursor) continue;
    while (span < code.length && code[span].end <= start) span += 1;
    if (span < code.length && code[span].start <= start) continue;
    let slashes = 0;
    while (line[start - 1 - slashes] === "\\") slashes += 1;
    if (slashes % 2 === 1) continue;
    const end = line.indexOf("-->", start + 4);
    if (end === -1) {
      if (!multiline) break;
      return { visible: kept + line.slice(cursor, start), open: true };
    }
    kept += line.slice(cursor, start);
    cursor = end + 3;
  }
  return { visible: kept + line.slice(cursor), open: false };
}

function normalizeWs(text) {
  return text.replace(/\r\n/g, "\n").trim();
}

// GitHub accepts this heading in any case. Trailing spaces are not part of the heading text.
const EVIDENCE_HEADING = /^[ ]{0,3}##[ \t]+Evidence(?:[ \t]+#+)?[ \t]*$/i;

function listContentColumn(line) {
  const match = line.match(/^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)/);
  if (!match) return null;
  return indentWidth(match[1] + match[2]) + indentWidth(match[3]);
}

function evidenceHeadingSpans(text) {
  const spans = [];
  let listColumn = null;
  let offset = 0;
  for (const line of text.split("\n")) {
    const indent = indentWidth(line.match(/^[ \t]*/)[0]);
    const opened = listContentColumn(line);
    if (opened != null && (listColumn == null || indent < listColumn)) listColumn = opened;
    else if (line.trim() && listColumn != null && indent < listColumn) listColumn = null;
    if ((listColumn == null || indent < listColumn) && EVIDENCE_HEADING.test(line)) {
      spans.push({ index: offset, length: line.length });
    }
    offset += line.length + 1;
  }
  return spans;
}

function evidenceSectionEnd(text) {
  let offset = 0;
  let paragraphStart = null;
  let listColumn = null;
  const fields = parseFields(text);
  let fieldIndex = 0;
  for (const line of text.split("\n")) {
    while (fieldIndex < fields.length && fields[fieldIndex].end <= offset) fieldIndex += 1;
    const field = fields[fieldIndex];
    const indent = indentWidth(line.match(/^[ \t]*/)[0]);
    const nested = field && offset >= field.start && indent >= field.contentIndent;
    if (nested) {
      paragraphStart = null;
      offset += line.length + 1;
      continue;
    }
    // A heading indented into a list item stays inside that item, so it does not end Evidence.
    const opened = listContentColumn(line);
    if (opened != null && (listColumn == null || indent < listColumn)) listColumn = opened;
    else if (line.trim() && listColumn != null && indent < listColumn) listColumn = null;
    const topLevel = listColumn == null || indent < listColumn;
    if (topLevel && /^[ ]{0,3}#{1,2}(?:[ \t]+|$)/.test(line)) return offset;
    if (topLevel && paragraphStart != null && /^[ ]{0,3}(?:=+|-+)[ \t]*$/.test(line)) return paragraphStart;
    const paragraph = /^[ ]{0,3}\S/.test(line)
      && !/^[ ]{0,3}(?:#{1,6}(?:[ \t]+|$)|>|[-*+][ \t]|\d{1,9}[.)][ \t])/.test(line)
      && !HTML_BLOCK_START.test(line);
    paragraphStart = paragraph ? paragraphStart ?? offset : null;
    offset += line.length + 1;
  }
  return text.length;
}

/**
 * Extract the ## Evidence section body (without the heading), with comments
 * and fences already removed. Returns null when the heading is missing.
 * `inlineMultiline: false` gives the view for the .80/.81 check, where an
 * inline `<!--` hides text only when it closes on the same line.
 * `includeRawHtml` selects the conservative LAN view using visible section
 * boundaries; `onLiteralLine` reports literal payload within those boundaries.
 */
export function extractEvidenceSection(body, options) {
  if (typeof body !== "string" || !body.trim()) return null;
  const metadata = structuralMetadataView(body);
  const visible = stripHiddenMarkdown(metadata, options?.includeRawHtml ? undefined : options);
  const headings = referenceHeadingView(inlineCodeHeadingView(visible));
  const match = evidenceHeadingSpans(headings)[0];
  if (!match) return null;
  const start = match.index + match.length;
  const end = start + evidenceSectionEnd(headings.slice(start));
  if (options?.includeRawHtml) {
    // Both stripped views retain one output line per metadata input line.
    // Select boundaries from visible Markdown, then scan the same raw lines.
    const firstLine = visible.slice(0, start).split("\n").length;
    const lastLine = visible.slice(0, end).split("\n").length - (end < visible.length ? 1 : 0);
    const literalLines = new Map();
    const rawLines = stripHiddenMarkdown(metadata, {
      ...options,
      onLiteralLine: (lineIndex, raw, { boundary = false, delimiter = false } = {}) => literalLines.set(lineIndex, { raw, boundary, delimiter }),
    }).split("\n");
    const selected = rawLines.slice(firstLine, lastLine);
    if (options.onLiteralLine) {
      const literalOffsets = new Map();
      const literalBoundaries = new Set();
      let offset = 0;
      const context = selected.map((line, index) => {
        const literal = literalLines.get(firstLine + index);
        if (literal !== undefined) {
          if (literal.boundary) literalBoundaries.add(offset);
          if (!literal.delimiter) literalOffsets.set(offset, { lineIndex: firstLine + index, raw: literal.raw });
          // Preserve indentation and offsets without allowing payload to create fields.
          line = literal.raw.replace(/\S/g, "x");
          if (literal.boundary && !line.trim()) line += "x";
        }
        offset += line.length + 1;
        return line;
      }).join("\n");
      const reasons = parseFields(context, literalBoundaries).filter((field) => field.label === FIELD_LABELS.reason);
      let reasonIndex = 0;
      for (const [start, { lineIndex, raw }] of literalOffsets) {
        while (reasonIndex < reasons.length && reasons[reasonIndex].end <= start) reasonIndex += 1;
        const reason = reasons[reasonIndex];
        if (!reason || start < reason.start || indentWidth(raw.match(/^[ \t]*/)[0]) < reason.contentIndent) {
          options.onLiteralLine(lineIndex, raw);
        }
      }
    }
    return inlineCodeMetadataView("\n" + selected.join("\n"));
  }
  return inlineCodeMetadataView(visible.slice(start, end));
}

function parseExemption(sectionText) {
  const fields = parseFields(sectionText);
  let offset = 0;
  let line = null;
  for (const candidate of sectionText.split("\n")) {
    const start = offset;
    offset += candidate.length + 1;
    if (!EXEMPTION_START.test(candidate)) continue;
    if (fields.some((field) => start >= field.start && start < field.end)) continue;
    line = candidate;
    break;
  }
  if (!line) return { raw: null, value: null };
  const raw = line.replace(EXEMPTION_START, "").trim();
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
  `^([ \\t]*)(${LIST_MARKER})([ \\t]+)(${Object.values(FIELD_LABELS).map(fieldLabelPattern).join("|")})[ \\t]*:[ \\t]*(.*)$`,
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
function parseFields(cleaned, literalBoundaries) {
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
    if ((EXEMPTION_START.test(line) && (outer || blankSeen)) || (outer && (
      blankSeen || !lazyOk || BLOCK_START.test(line) || literalBoundaries?.has(lineStart)
    ))) {
      current = null;
      continue;
    }
    current.lines.push(trimmed);
    if (outer) current.lazy.push({ start: lineStart, end });
    current.end = end;
    blankSeen = false;
    lazyOk = !LEAF_BLOCK_START.test(line) && !literalBoundaries?.has(lineStart);
  }
  return fields.map(({ label, lines, lazy, start, end, contentIndent }) => ({
    label,
    value: lines.join(" ").trim(),
    text: lines.join("\n"),
    lazy,
    start,
    end,
    contentIndent,
  }));
}

/**
 * Read a template field value (same line and the lines that belong to it).
 */
function findField(sectionText, label) {
  return parseFields(sectionText).find((field) => field.label === label);
}

function readField(sectionText, label) {
  return findField(sectionText, label)?.text ?? "";
}

/**
 * Section text with the given fields cut out. With
 * keepLazy, the fields' lazy continuation lines stay in the text.
 */
function withoutFields(sectionText, labels, { keepLazy = false } = {}) {
  const text = sectionText;
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
 * Inline code span ranges in document order. Linear scan: each backtick run
 * opens a span closed by the next run of the same length; unmatched runs are
 * literal. Ranges are [open, close) with content between the backtick runs.
 */
function codeSpanRanges(value) {
  if (!value.includes("`")) return [];
  const runs = [...value.matchAll(/`+/g)].map((m) => ({ at: m.index, len: m[0].length }));
  const byLength = new Map();
  runs.forEach((run, index) => {
    if (!byLength.has(run.len)) byLength.set(run.len, { indexes: [], next: 0 });
    byLength.get(run.len).indexes.push(index);
  });
  const ranges = [];
  for (let i = 0; i < runs.length; i += 1) {
    const same = byLength.get(runs[i].len);
    while (same.next < same.indexes.length && same.indexes[same.next] <= i) same.next += 1;
    if (same.next === same.indexes.length) continue;
    const close = runs[same.indexes[same.next]];
    ranges.push({
      start: runs[i].at,
      end: close.at + close.len,
      content: value.slice(runs[i].at + runs[i].len, close.at),
    });
    i = same.indexes[same.next];
  }
  return ranges;
}

function codeSpans(value) {
  return codeSpanRanges(value).map((range) => range.content);
}

/**
 * Inline code counts only when it holds a command, path, or output: something
 * with whitespace or path/URL punctuation that is not a bare category word
 * or a placeholder note asking to attach a screenshot later.
 */
const PLACEHOLDER_WORD = /\b(?:todo|tbd|fixme|placeholder)\b/i;

const VERIFICATION_COMMAND =
  /^(?:\$\s*)?(?:cd\s+\S+\s+&&\s+)?(?:node\s+(?:--test\b|\S+\.m?[jc]s\b)|cargo\s+(?:test|nextest|check|build|fmt|clippy)\b|(?:pnpm|npm)\s+(?:test|run|exec|check|build)\b|python3?\s+\S+\.py\b|(?:py\.test|pytest)\b|go\s+test\b|mvn(?:w)?\b|(?:\.\/)?gradlew(?:\.bat)?\b|gradle\s+(?:test|check|build)\b|curl\s+(?:-\S+\s+)*https?:\/\/)/i;

const TEST_RUNNER_OUTPUT_LINE =
  /^(?:ok\s+\S+\s+\d+(?:\.\d+)?s(?:\s+\([^\)]*\))?|\d+\s+passed(?:\s|$)|\d+\s+failed(?:\s|$)|=+\s*(?:test session starts|.*passed).*?=+|BUILD SUCCESS(?:FUL)?(?:\s|$)|Tests run:\s*\d+)/i;

function hasSubstantiveCodeSpan(value) {
  return codeSpans(value).some((span) => {
    const content = span.trim();
    if (/^(?:not provided|no screenshot|could not test)$/i.test(content)) return false;
    return (
      content &&
      !NON_ARTIFACT_WORD.test(content) &&
      !PLACEHOLDER_WORD.test(content) &&
      (hasConcreteHttpUrl(content)
        || /^(?:[\w.-]+\/)+[\w.-]+$/.test(content)
        || VERIFICATION_COMMAND.test(content)
        || TEST_RUNNER_OUTPUT_LINE.test(content)
        || /\b(?:tests?|pass(?:ed)?|fail(?:ed)?|exit(?: status)?|status(?: code)?|assertions?)\s*[:=]?\s*\d+\b/i.test(content))
    );
  });
}

function hasCommandPlusRunnerOutput(value) {
  const spans = codeSpans(value);
  if (!spans.some((span) => VERIFICATION_COMMAND.test(span.trim()))) return false;
  const plain = value.replace(/`+[^`]*`+/g, "\n");
  return plain.split("\n").some((line) => TEST_RUNNER_OUTPUT_LINE.test(line.trim()));
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

const HTTP_URL = /https?:\/\/[^\s<>()"'`]+/gi;

function isHttpTarget(target) {
  if (!/^https?:\/\//i.test(target)) return false;
  try {
    const url = new URL(target);
    return ["http:", "https:"].includes(url.protocol) && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function hasConcreteHttpUrl(text) {
  return [...text.matchAll(HTTP_URL)].some((match) => isHttpTarget(trimToken(match[0])));
}

/** A link destination that identifies something: a web URL or a file path. */
function isConcreteTarget(destination) {
  const target = decodeCharacterReferences(destination.replace(/^<|>$/g, "").replace(/\\(.)/g, "$1")).trim();
  if (/^https?:/i.test(target)) return isHttpTarget(target);
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
    const start = i;
    for (i += 1; i < text.length && text[i] !== ">"; i += 1) {
      if (text[i] === "\n" || text[i] === "<") return null;
      if (text[i] === "\\") i += 1;
    }
    if (i >= text.length) return null;
    destination = text.slice(start, i + 1);
    i += 1;
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

/** Logical label and tail position, before destination/title validation. */
function referenceOpening(lines, index) {
  const opening = lines[index]?.match(/^[ \t]*\[/);
  if (!opening) return null;
  let label = "";
  let at = opening[0].length;
  for (; label.length <= 999; at += 1) {
    const ch = lines[index][at];
    if (ch === undefined) {
      if (!lines[index + 1]?.trim()) return null;
      label += "\n";
      index += 1;
      at = -1;
    } else if (ch === "\\" && at + 1 < lines[index].length) {
      label += ch + lines[index][++at];
    } else if (ch === "[") return null;
    else if (ch === "]") {
      return label.trim() && lines[index][at + 1] === ":"
        ? { label, tail: lines[index].slice(at + 2).trimStart(), end: index }
        : null;
    } else label += ch;
  }
  return null;
}

const REFERENCE_DESTINATION = /^(<(?:[^>\\\n]|\\.)*>|\S+)/;

const lineScanCache = new WeakMap();

function lineScanIndex(lines) {
  const cached = lineScanCache.get(lines);
  if (cached) return cached;
  const positions = lines.map((line) => {
    const found = { '"': [], "'": [], ")": [] };
    for (let i = 0; i < line.length; i += 1) {
      if (line[i] === "\\") { i += 1; continue; }
      if (Object.hasOwn(found, line[i])) found[line[i]].push(i);
    }
    return found;
  });
  const blankAt = new Array(lines.length);
  let nextBlank = lines.length;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].trim()) nextBlank = i;
    blankAt[i] = nextBlank;
  }
  const nextLine = {};
  for (const closer of ['"', "'", ")"]) {
    const next = new Array(lines.length + 1);
    let at = lines.length;
    next[lines.length] = lines.length;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (positions[i][closer].length) at = i;
      next[i] = at;
    }
    nextLine[closer] = next;
  }
  const scan = { blankAt, nextLine };
  lineScanCache.set(lines, scan);
  return scan;
}

/** Validate a complete destination and optional title, including continuation
 * lines. A prefix followed by unquoted garbage is not a Markdown definition. */
function referenceDestination(lines, index) {
  const opening = referenceOpening(lines, index);
  if (!opening) return null;
  index = opening.end;
  let tail = opening.tail;
  if (!tail.trim()) {
    index += 1;
    tail = lines[index]?.trim() ?? "";
  }
  const destination = tail.match(REFERENCE_DESTINATION)?.[1];
  if (!destination) return null;
  let title = tail.slice(tail.indexOf(destination) + destination.length).trim();
  if (!title && /^[ \t]*["'(]/.test(lines[index + 1] ?? "")) title = lines[++index].trim();
  if (title) {
    const closer = { '"': '"', "'": "'", "(": ")" }[title[0]];
    if (!closer) return null;
    const scan = lineScanIndex(lines);
    if (scan.nextLine[closer][index] >= scan.blankAt[index]) return null;
    const parts = [title];
    let closed = false;
    for (let at = 1; ; at = 0) {
      const part = parts[parts.length - 1];
      for (; at < part.length; at += 1) {
        if (part[at] === "\\") at += 1;
        else if (part[at] === closer) { closed = true; break; }
      }
      if (closed) break;
      const next = lines[++index];
      if (!next?.trim()) return null;
      parts.push(next);
    }
    title = parts.join("\n");
  }
  const wrapped = `(${destination}${title ? " " + title : ""})`;
  const parsed = parseLinkTail(wrapped, 0);
  return parsed?.end === wrapped.length
    ? { label: opening.label, destination: parsed.destination, end: index }
    : null;
}

/** Mask complete definitions without moving offsets in the section view. */
function openReferenceScan(rawLines, normalized = null) {
  return {
    rawLines,
    normalized: normalized ?? rawLines.map((line) => line.slice(containerPrefix(line).end)),
    paragraph: false,
  };
}

function lineIsHeadingOrRule(raw) {
  return /^[ \t]{0,3}#{1,6}(?:[ \t]|$)/.test(raw)
    || /^[ \t]{0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(raw);
}

function lineStartsListItem(raw) {
  return /^[ \t]*(?:>[ \t]*)*(?:[-+*]|\d{1,9}[.)])[ \t]/.test(raw);
}

function lineIsIndentedCode(raw) {
  if (lineStartsListItem(raw) || /^[ \t]*>/.test(raw)) return false;
  return /^(?: {4,}|\t)/.test(raw);
}

// A link reference definition cannot interrupt a paragraph, and a 4-space
// line outside a paragraph is indented code. Callers share this scan.
function pullReference(scan, index) {
  const raw = scan.rawLines[index] ?? "";
  const content = scan.normalized[index] ?? "";
  if (!raw.trim()) {
    scan.paragraph = false;
    return { kind: "blank" };
  }
  if (lineIsHeadingOrRule(raw)) {
    scan.paragraph = false;
    return { kind: "block" };
  }
  if (lineStartsListItem(raw) || /^[ \t]{0,3}>/.test(raw)) scan.paragraph = false;
  if (!scan.paragraph && lineIsIndentedCode(raw)) return { kind: "skip" };
  if (!scan.paragraph) {
    const definition = referenceDestination(scan.normalized, index);
    if (definition) return { kind: "definition", definition };
  }
  if (!/^[ \t]*\[/.test(content)) scan.paragraph = true;
  return { kind: "text" };
}

function referenceHeadingView(value) {
  const lines = value.split("\n");
  const scan = openReferenceScan(lines);
  for (let index = 0; index < lines.length; index += 1) {
    const event = pullReference(scan, index);
    if (event.kind !== "definition") continue;
    for (; index <= event.definition.end; index += 1) lines[index] = " ".repeat(lines[index].length);
    index -= 1;
  }
  return lines.join("\n");
}

function isEscaped(text, index) {
  let slashes = 0;
  while (text[index - 1 - slashes] === "\\") slashes += 1;
  return slashes % 2 === 1;
}

/** Link destinations/titles are inline metadata even when they span lines.
 * Preserve the link for artifact validation, but prevent its newlines from
 * introducing block declarations, fields, or headings. */
function inlineMetadataView(value) {
  const ranges = codeSpanRanges(value);
  let rangeIndex = 0;
  let cursor = 0;
  let kept = "";
  for (let at = value.indexOf("]("); at !== -1; at = value.indexOf("](", cursor)) {
    while (rangeIndex < ranges.length && ranges[rangeIndex].end <= at) rangeIndex += 1;
    const inCode = rangeIndex < ranges.length && ranges[rangeIndex].start <= at;
    const open = linkTextStart(value, at, cursor);
    const tail = !inCode && open !== -1 ? parseLinkTail(value, at + 1) : null;
    // A malformed tail may already have scanned the remaining text. Do not
    // retry every nested opener in it (quadratic on repeated `[a](` input).
    if (!inCode && open !== -1 && !tail) break;
    const end = tail?.end ?? at + 2;
    kept += value.slice(cursor, at + 1);
    kept += value.slice(at + 1, end).replace(/\r?\n/g, " ");
    cursor = end;
  }
  return kept + value.slice(cursor);
}

/** Keep complete hidden metadata on its opening line, so its contents cannot
 * impersonate block-level fields while links/definitions remain available
 * for artifact and LAN validation. */
function structuralMetadataView(value) {
  const inline = inlineHtmlMetadataView(inlineMetadataView(value));
  const lines = inline.split("\n");
  const hidden = stripHiddenMarkdown(inline).split("\n");
  const scan = openReferenceScan(hidden);
  for (let index = 0; index < lines.length; index += 1) {
    const event = pullReference(scan, index);
    if (event.kind !== "definition") continue;
    const start = index;
    const continuation = [];
    for (index += 1; index <= event.definition.end; index += 1) {
      continuation.push(scan.normalized[index]);
      lines[index] = "";
    }
    lines[start] += continuation.length ? " " + continuation.join(" ") : "";
    index -= 1;
  }
  return lines.join("\n");
}

function inlineHtmlMetadataView(value) {
  const ranges = codeSpanRanges(value);
  let rangeIndex = 0;
  let cursor = 0;
  let kept = "";
  const opener = /<\/?[A-Za-z][A-Za-z0-9-]*(?=[\s/>])/y;
  for (let start = value.indexOf("<"); start !== -1; start = value.indexOf("<", cursor)) {
    while (rangeIndex < ranges.length && ranges[rangeIndex].end <= start) rangeIndex += 1;
    opener.lastIndex = start;
    const inCode = rangeIndex < ranges.length && ranges[rangeIndex].start <= start;
    if (!inCode && !isEscaped(value, start)) {
      const declaration = value.startsWith("<?", start) ? [2, "?>"]
        : value.startsWith("<![CDATA[", start) ? [9, "]]>"]
        : /^<![A-Z]/.test(value.slice(start, start + 3)) ? [2, ">"] : null;
      if (declaration) {
        const close = value.indexOf(declaration[1], start + declaration[0]);
        if (close !== -1) {
          const end = close + declaration[1].length;
          kept += value.slice(cursor, start) + value.slice(start, end).replace(/\r?\n/g, " ");
          cursor = end;
          continue;
        }
      }
    }
    const tag = !inCode && !isEscaped(value, start) ? opener.exec(value) : null;
    if (!tag) {
      kept += value.slice(cursor, start + 1);
      cursor = start + 1;
      continue;
    }
    let quote = null;
    let end = opener.lastIndex;
    for (; end < value.length; end += 1) {
      const ch = value[end];
      if (quote) { if (ch === quote) quote = null; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === ">") { end += 1; break; }
      else if (ch === "<") break;
    }
    const raw = value.slice(start, end);
    const flat = raw.replace(/\r?\n/g, " ");
    kept += value.slice(cursor, start) + (isCompleteHtmlTag(flat) ? flat : raw);
    cursor = end;
  }
  return kept + value.slice(cursor);
}

/** Code spans render inline even when their source crosses physical lines. */
function inlineCodeMetadataView(value) {
  let cursor = 0;
  let kept = "";
  for (const range of codeSpanRanges(value)) {
    kept += value.slice(cursor, range.start)
      + value.slice(range.start, range.end).replace(/\r?\n/g, " ");
    cursor = range.end;
  }
  return kept + value.slice(cursor);
}

/** Mask code spans for block-boundary discovery without moving line offsets. */
function inlineCodeHeadingView(value) {
  let cursor = 0;
  let kept = "";
  for (const range of codeSpanRanges(value)) {
    kept += value.slice(cursor, range.start)
      + value.slice(range.start, range.end).replace(/[^\n]/g, " ");
    cursor = range.end;
  }
  return kept + value.slice(cursor);
}

/** Type-7 HTML blocks require a complete tag alone on a boundary line. */
function isCompleteHtmlTag(value) {
  return /^[ \t]*<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>[ \t]*$/.test(value)
    || /^[ \t]*<[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t]*=[ \t]*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*[ \t]*\/?[ \t]*>[ \t]*$/.test(value);
}

function referenceContainerLines(value) {
  return value.split("\n").map((line) => line.slice(containerPrefix(line).end));
}

/**
 * Drop link reference definitions, noting whether any destination is concrete.
 * A definition's destination may sit on the next line and its title may span
 * lines, so everything up to the next blank line goes with it (fail closed).
 */
function stripReferenceDefinitions(value, references, { keepMalformed = false } = {}) {
  let concrete = false;
  let dropping = false;
  const defined = new Set();
  const kept = [];
  const lines = value.split("\n");
  const scan = openReferenceScan(lines);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const paragraphBefore = scan.paragraph;
    const event = pullReference(scan, index);
    if (!line.trim()) {
      dropping = false;
      kept.push(line);
      continue;
    }
    if (event.kind === "definition") {
      if (!keepMalformed) {
        const label = normalizeReferenceLabel(event.definition.label);
        const referenced = references.has(label);
        if (event.definition.destination && !defined.has(label)) {
          defined.add(label);
          if (referenced && isConcreteTarget(event.definition.destination)) concrete = true;
        }
      }
      index = event.definition.end;
      continue;
    }
    if (event.kind === "skip") {
      kept.push(line);
      continue;
    }
    if (!paragraphBefore && referenceOpening(scan.normalized, index)) {
      if (keepMalformed) {
        // Only valid definitions are hidden Markdown. A malformed opener and
        // any later labels remain raw text for conservative LAN checking.
        kept.push(line);
        continue;
      }
      dropping = true;
      continue;
    }
    if (dropping) continue;
    kept.push(line);
  }
  return { text: kept.join("\n"), concrete };
}

/**
 * Index of the `[` that opens the link text ending at `close` (a `]`), looking
 * no further back than `floor`; -1 when there is none. One forward pass that
 * honours backslash escapes and nesting.
 */
function linkTextStart(text, close, floor) {
  const opens = [];
  for (let i = floor; i < close; i += 1) {
    if (text[i] === "\\") i += 1;
    else if (text[i] === "[") opens.push(i);
    else if (text[i] === "]") opens.pop();
  }
  return opens.length ? opens[opens.length - 1] : -1;
}

/**
 * Remove links (`[text](…)`, images, and reference definitions), noting
 * whether any destination is concrete. A link counts by its destination.
 * markConcrete keeps the visible label so placeholder and denial checks still
 * see it. Titles stay dropped. A `](` that does not form a link tail hides
 * the rest of the value (fail closed), so a malformed title can never surface
 * as an artifact. Each character is scanned a bounded number of times, so the
 * pass is linear.
 */
function stripLinks(value, references, { keepMalformed = false, markConcrete = false } = {}) {
  const definitions = stripReferenceDefinitions(value, references, { keepMalformed });
  let concrete = definitions.concrete;
  const text = definitions.text;
  let rest = "";
  let cursor = 0;
  for (let at = text.indexOf("](", cursor); at !== -1; at = text.indexOf("](", cursor)) {
    const open = linkTextStart(text, at, cursor);
    rest += `${text.slice(cursor, open === -1 ? at : open)} `;
    if (open === -1) return { rest: rest + (keepMalformed ? text.slice(at) : ""), concrete };
    const tail = parseLinkTail(text, at + 1);
    if (!tail) return { rest: rest + (keepMalformed ? text.slice(open) : ""), concrete };
    const image = open > 0 && text[open - 1] === "!" && !isEscaped(text, open - 1);
    const visible = visibleFieldText(text.slice(open + 1, at))
      .replace(/[\p{Default_Ignorable_Code_Point}\p{Mark}]/gu, "")
      .trim();
    if (isConcreteTarget(tail.destination) && (image || visible)) {
      concrete = true;
      if (markConcrete) rest += `\u0001${visible}`;
    }
    cursor = tail.end;
  }
  return { rest: rest + text.slice(cursor), concrete };
}

function stripRawHtmlTags(value, { keepMalformed = false } = {}) {
  const opener = /<\/?[a-z][a-z\d-]*(?=[\s>]|\/>)/iy;
  let kept = "";
  let cursor = 0;
  const hidden = [];
  for (let start = value.indexOf("<"); start !== -1; start = value.indexOf("<", cursor)) {
    opener.lastIndex = start;
    const tag = opener.exec(value);
    if (!tag) {
      if (!hidden.length) kept += value.slice(cursor, start + 1);
      cursor = start + 1;
      continue;
    }
    if (!hidden.length) kept += value.slice(cursor, start);
    let quote = null;
    let end = opener.lastIndex;
    for (; end < value.length; end += 1) {
      const ch = value[end];
      if (quote) { if (ch === quote) quote = null; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === ">") { end += 1; break; }
      else if (ch === "<") break;
    }
    const markup = value.slice(start, end);
    const name = markup.match(/^<\/?([a-z][a-z\d-]*)/i)?.[1].toLowerCase();
    const closing = markup.startsWith("</");
    if (closing && name === hidden.at(-1)) hidden.pop();
    else if (!closing && ["script", "style", "template", "head", "title"].includes(name)
      && !["script", "style", "title"].includes(hidden.at(-1))) hidden.push(name);
    if (keepMalformed && !markup.endsWith(">")) {
      if (!hidden.length) kept += markup;
      cursor = end;
      continue;
    }
    cursor = end;
  }
  return kept + (hidden.length ? "" : value.slice(cursor));
}

function withoutFencePayload(text) {
  return text.split("\n").filter((line) => !line.includes("\u0000")).join("\n");
}

function splitClauses(text) {
  const masked = text.replace(/&(?:#[xX][\da-fA-F]+|#\d+|[a-zA-Z][a-zA-Z\d]*);/g, (match) => match.replaceAll(";", "\u0002"));
  return masked.split(/[;\n]/).map((clause) => clause.replaceAll("\u0002", ";"));
}

function stripEmphasis(token) {
  let text = token;
  let changed = true;
  while (changed) {
    changed = false;
    for (const mark of ["**", "~~", "__", "*", "_"]) {
      if (text.length > mark.length * 2 && text.startsWith(mark) && text.endsWith(mark)) {
        text = text.slice(mark.length, -mark.length);
        changed = true;
        break;
      }
    }
  }
  return text;
}

function htmlAttribute(tag, name) {
  const found = tag.match(new RegExp(`(?<![\\w-])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\x60]+))`, "i"));
  return found ? (found[1] ?? found[2] ?? found[3] ?? "") : "";
}

function readHtmlTag(value, index) {
  if (value[index] !== "<") return null;
  let at = index + 1;
  const closing = value[at] === "/";
  if (closing) at += 1;
  const nameStart = at;
  while (/[A-Za-z0-9-]/.test(value[at] ?? "")) at += 1;
  if (at === nameStart) return null;
  const name = value.slice(nameStart, at).toLowerCase();
  if (value[at] && !/[\s/>]/.test(value[at])) return null;
  let quote = null;
  const limit = Math.min(value.length, index + 2048);
  for (; at < limit; at += 1) {
    const ch = value[at];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ">") return { name, closing, end: at + 1, tag: value.slice(index, at + 1) };
    else if (ch === "<") return null;
  }
  return null;
}

function htmlTagEnd(value, index, closing, name) {
  const tag = readHtmlTag(value, index);
  if (!tag || tag.closing !== closing || tag.name !== name.toLowerCase()) return -1;
  return tag.end;
}

function decodeRawHtmlAttributes(value) {
  let out = "";
  let cursor = 0;
  for (let index = value.indexOf("<", cursor); index !== -1; index = value.indexOf("<", cursor)) {
    const tag = readHtmlTag(value, index);
    if (!tag) {
      out += value.slice(cursor, index + 1);
      cursor = index + 1;
      continue;
    }
    out += value.slice(cursor, index) + decodeCharacterReferences(tag.tag, { htmlNumeric: true, dropBreaks: true });
    cursor = tag.end;
  }
  return out + value.slice(cursor);
}

function anchorContentEnd(value, from) {
  let depth = 1;
  const limit = Math.min(value.length, from + 8192);
  for (let index = from; index < limit && depth > 0; index += 1) {
    if (value[index] !== "<") continue;
    const close = htmlTagEnd(value, index, true, "a");
    if (close !== -1) {
      depth -= 1;
      if (depth === 0) return index;
      index = close - 1;
      continue;
    }
    const open = htmlTagEnd(value, index, false, "a");
    if (open !== -1) {
      depth += 1;
      index = open - 1;
    }
  }
  return -1;
}

function anchorVisible(inner) {
  let text = "";
  for (let index = 0; index < inner.length; index += 1) {
    if (inner.startsWith("<!--", index)) {
      const end = inner.indexOf("-->", index + 4);
      if (end === -1) {
        text += inner.slice(index);
        break;
      }
      index = end + 2;
      continue;
    }
    if (inner[index] !== "<") {
      text += inner[index];
      continue;
    }
    const tag = readHtmlTag(inner, index);
    if (!tag) {
      text += inner[index];
      continue;
    }
    // A quoted > stays inside the tag. This is the same scanner that finds the tag end.
    if (!tag.closing && tag.name === "img" && htmlAttribute(tag.tag, "src").trim()) return true;
    index = tag.end - 1;
  }
  const visible = decodeCharacterReferences(text)
    .replace(/[\p{Default_Ignorable_Code_Point}\p{Mark}]/gu, "")
    .replace(/\u00a0/g, " ")
    .trim();
  return visible.length > 0;
}

// Raw HTML attributes accept a numeric character reference without a semicolon. Markdown destinations still require one.
function htmlConcreteMarker(value) {
  let out = "";
  let cursor = 0;
  for (let index = value.indexOf("<", cursor); index !== -1; index = value.indexOf("<", cursor)) {
    const tag = readHtmlTag(value, index);
    if (!tag || tag.closing || (tag.name !== "a" && tag.name !== "img")) {
      out += value.slice(cursor, tag ? tag.end : index + 1);
      cursor = tag ? tag.end : index + 1;
      continue;
    }
    out += value.slice(cursor, index);
    if (tag.name === "img") {
      const destination = decodeCharacterReferences(htmlAttribute(tag.tag, "src"), { htmlNumeric: true, dropBreaks: true });
      out += destination && isConcreteTarget(destination) ? "\u0001" : "";
    } else {
      const destination = decodeCharacterReferences(htmlAttribute(tag.tag, "href"), { htmlNumeric: true, dropBreaks: true });
      const contentEnd = anchorContentEnd(value, tag.end);
      const inner = contentEnd === -1 ? "" : value.slice(tag.end, contentEnd);
      if (destination && isConcreteTarget(destination) && anchorVisible(inner)) out += "\u0001";
    }
    cursor = tag.end;
  }
  return out + value.slice(cursor);
}

function referenceClauseConcrete(text, definitions) {
  if (!definitions?.size) return false;
  for (const label of referenceUses(text, { requireVisible: true })) {
    const destination = definitions.get(label);
    if (destination && isConcreteTarget(destination)) return true;
  }
  return false;
}

function looksLikeArtifact(value, references, definitions = new Map()) {
  if (!value) return false;
  value = value.split("\n").filter((line) => !line.includes("\u0000")).join("\n");
  if (!value.trim()) return false;
  value = stripRawHtmlTags(htmlConcreteMarker(value));
  // Parse markup before evaluating prose: a placeholder link's title cannot
  // escape into a later clause, and filenames may contain placeholder words.
  if (/^\s*`?(?:TODO|TBD|FIXME|placeholder)(?:[ :]|$)/i.test(value)) return false;
  const { rest, concrete } = stripLinks(value, references, { markConcrete: true });
  const denial = /\b(?:not|no|without|never|missing|absent|unavailable|unable|omitted|failed to|n\/a)\b/i;
  const prose = (text) => text.split(/\s+/).filter((token) =>
    !hasConcreteHttpUrl(token) && !isArtifactPath(trimToken(stripEmphasis(token))),
  ).join(" ");
  const deniesConcrete = (text) => {
    const proseText = prose(text).trim();
    if (!proseText) return false;
    if (denial.test(proseText)) return true;
    const decoded = decodeCharacterReferences(proseText)
      .replace(/[\p{Default_Ignorable_Code_Point}\p{Mark}]/gu, "")
      .trim();
    if (!/[\p{Letter}\p{Number}]/u.test(decoded)) return false;
    return isPlaceholderField(decoded);
  };
  if (concrete && !deniesConcrete(rest.replaceAll("\u0001", ""))) return true;
  for (const clause of splitClauses(rest)) {
    const text = clause.replaceAll("\u0001", "").trim();
    if (!text && !clause.includes("\u0001")) continue;
    // A denied clause cannot suppress another independently cited artifact.
    if (deniesConcrete(text)) continue;
    if (clause.includes("\u0001") || referenceClauseConcrete(text, definitions)) return true;
    if (hasConcreteHttpUrl(text) || hasSubstantiveCodeSpan(text) || hasCommandPlusRunnerOutput(text)) return true;
    // Bare paths count only as a citation, not as incidental prose about a
    // missing file. Prose can use a Markdown link or an explicit citation.
    const citation = text.replace(/^(?:see|artifact(?: at|:)?|attached|saved(?: at| to)?|captured(?: at| to)?|output(?: at|:)?)\s+/i, "");
    const tokens = citation.split(/\s+/).map((token) => trimToken(stripEmphasis(token))).filter(Boolean);
    if (tokens.length && tokens.every(isArtifactPath)) return true;
  }
  return false;
}

/** Section text outside every template field and the Exemption line. */
function freeformText(sectionText) {
  return withoutFields(sectionText, Object.values(FIELD_LABELS)).replace(
    EXEMPTION_LINE,
    "",
  );
}

// Generated from Unicode 17.0.0 CaseFolding.txt, default full folding (C/F).
// https://www.unicode.org/Public/17.0.0/ucd/CaseFolding.txt
const REFERENCE_CASE_FOLD = new Map([
  ["µ", "μ"], ["ß", "ss"], ["İ", "i̇"], ["ŉ", "ʼn"], ["Ÿ", "ÿ"], ["ſ", "s"],
  ["Ɓ", "ɓ"], ["Ɔ", "ɔ"], ["Ƈ", "ƈ"], ["Ƌ", "ƌ"], ["Ǝ", "ǝ"], ["Ə", "ə"],
  ["Ɛ", "ɛ"], ["Ƒ", "ƒ"], ["Ɠ", "ɠ"], ["Ɣ", "ɣ"], ["Ɩ", "ɩ"], ["Ɨ", "ɨ"],
  ["Ƙ", "ƙ"], ["Ɯ", "ɯ"], ["Ɲ", "ɲ"], ["Ɵ", "ɵ"], ["Ʀ", "ʀ"], ["Ƨ", "ƨ"],
  ["Ʃ", "ʃ"], ["Ƭ", "ƭ"], ["Ʈ", "ʈ"], ["Ư", "ư"], ["Ʒ", "ʒ"], ["Ƹ", "ƹ"],
  ["Ƽ", "ƽ"], ["Ǆ", "ǆ"], ["ǅ", "ǆ"], ["Ǉ", "ǉ"], ["ǈ", "ǉ"], ["Ǌ", "ǌ"],
  ["ǰ", "ǰ"], ["Ǳ", "ǳ"], ["Ƕ", "ƕ"], ["Ƿ", "ƿ"], ["Ƞ", "ƞ"], ["Ⱥ", "ⱥ"],
  ["Ȼ", "ȼ"], ["Ƚ", "ƚ"], ["Ⱦ", "ⱦ"], ["Ɂ", "ɂ"], ["Ƀ", "ƀ"], ["Ʉ", "ʉ"],
  ["Ʌ", "ʌ"], ["ͅ", "ι"], ["Ͷ", "ͷ"], ["Ϳ", "ϳ"], ["Ά", "ά"], ["Ό", "ό"],
  ["ΐ", "ΐ"], ["ΰ", "ΰ"], ["ς", "σ"], ["Ϗ", "ϗ"], ["ϐ", "β"], ["ϑ", "θ"],
  ["ϕ", "φ"], ["ϖ", "π"], ["ϰ", "κ"], ["ϱ", "ρ"], ["ϴ", "θ"], ["ϵ", "ε"],
  ["Ϸ", "ϸ"], ["Ϲ", "ϲ"], ["Ϻ", "ϻ"], ["Ӏ", "ӏ"], ["և", "եւ"], ["Ⴧ", "ⴧ"],
  ["Ⴭ", "ⴭ"], ["ᲀ", "в"], ["ᲁ", "д"], ["ᲂ", "о"], ["ᲅ", "т"], ["ᲆ", "ъ"],
  ["ᲇ", "ѣ"], ["ᲈ", "ꙋ"], ["Ᲊ", "ᲊ"], ["ẖ", "ẖ"], ["ẗ", "ẗ"], ["ẘ", "ẘ"],
  ["ẙ", "ẙ"], ["ẚ", "aʾ"], ["ẛ", "ṡ"], ["ẞ", "ss"], ["ὐ", "ὐ"], ["ὒ", "ὒ"],
  ["ὔ", "ὔ"], ["ὖ", "ὖ"], ["ᾀ", "ἀι"], ["ᾁ", "ἁι"], ["ᾂ", "ἂι"], ["ᾃ", "ἃι"],
  ["ᾄ", "ἄι"], ["ᾅ", "ἅι"], ["ᾆ", "ἆι"], ["ᾇ", "ἇι"], ["ᾈ", "ἀι"], ["ᾉ", "ἁι"],
  ["ᾊ", "ἂι"], ["ᾋ", "ἃι"], ["ᾌ", "ἄι"], ["ᾍ", "ἅι"], ["ᾎ", "ἆι"], ["ᾏ", "ἇι"],
  ["ᾐ", "ἠι"], ["ᾑ", "ἡι"], ["ᾒ", "ἢι"], ["ᾓ", "ἣι"], ["ᾔ", "ἤι"], ["ᾕ", "ἥι"],
  ["ᾖ", "ἦι"], ["ᾗ", "ἧι"], ["ᾘ", "ἠι"], ["ᾙ", "ἡι"], ["ᾚ", "ἢι"], ["ᾛ", "ἣι"],
  ["ᾜ", "ἤι"], ["ᾝ", "ἥι"], ["ᾞ", "ἦι"], ["ᾟ", "ἧι"], ["ᾠ", "ὠι"], ["ᾡ", "ὡι"],
  ["ᾢ", "ὢι"], ["ᾣ", "ὣι"], ["ᾤ", "ὤι"], ["ᾥ", "ὥι"], ["ᾦ", "ὦι"], ["ᾧ", "ὧι"],
  ["ᾨ", "ὠι"], ["ᾩ", "ὡι"], ["ᾪ", "ὢι"], ["ᾫ", "ὣι"], ["ᾬ", "ὤι"], ["ᾭ", "ὥι"],
  ["ᾮ", "ὦι"], ["ᾯ", "ὧι"], ["ᾲ", "ὰι"], ["ᾳ", "αι"], ["ᾴ", "άι"], ["ᾶ", "ᾶ"],
  ["ᾷ", "ᾶι"], ["ᾼ", "αι"], ["ι", "ι"], ["ῂ", "ὴι"], ["ῃ", "ηι"], ["ῄ", "ήι"],
  ["ῆ", "ῆ"], ["ῇ", "ῆι"], ["ῌ", "ηι"], ["ῒ", "ῒ"], ["ΐ", "ΐ"], ["ῖ", "ῖ"],
  ["ῗ", "ῗ"], ["ῢ", "ῢ"], ["ΰ", "ΰ"], ["ῤ", "ῤ"], ["ῦ", "ῦ"], ["ῧ", "ῧ"],
  ["Ῥ", "ῥ"], ["ῲ", "ὼι"], ["ῳ", "ωι"], ["ῴ", "ώι"], ["ῶ", "ῶ"], ["ῷ", "ῶι"],
  ["ῼ", "ωι"], ["Ω", "ω"], ["K", "k"], ["Å", "å"], ["Ⅎ", "ⅎ"], ["Ↄ", "ↄ"],
  ["Ⱡ", "ⱡ"], ["Ɫ", "ɫ"], ["Ᵽ", "ᵽ"], ["Ɽ", "ɽ"], ["Ɑ", "ɑ"], ["Ɱ", "ɱ"],
  ["Ɐ", "ɐ"], ["Ɒ", "ɒ"], ["Ⱳ", "ⱳ"], ["Ⱶ", "ⱶ"], ["Ⳳ", "ⳳ"], ["Ᵹ", "ᵹ"],
  ["Ꞌ", "ꞌ"], ["Ɥ", "ɥ"], ["Ɦ", "ɦ"], ["Ɜ", "ɜ"], ["Ɡ", "ɡ"], ["Ɬ", "ɬ"],
  ["Ɪ", "ɪ"], ["Ʞ", "ʞ"], ["Ʇ", "ʇ"], ["Ʝ", "ʝ"], ["Ꭓ", "ꭓ"], ["Ꞔ", "ꞔ"],
  ["Ʂ", "ʂ"], ["Ᶎ", "ᶎ"], ["Ɤ", "ɤ"], ["Ƛ", "ƛ"], ["Ꟶ", "ꟶ"], ["ﬀ", "ff"],
  ["ﬁ", "fi"], ["ﬂ", "fl"], ["ﬃ", "ffi"], ["ﬄ", "ffl"], ["ﬅ", "st"], ["ﬆ", "st"],
  ["ﬓ", "մն"], ["ﬔ", "մե"], ["ﬕ", "մի"], ["ﬖ", "վն"], ["ﬗ", "մխ"],
]);
for (const [start, end, step, offset] of [
  [0x41, 0x5a, 1, 32], [0xc0, 0xd6, 1, 32], [0xd8, 0xde, 1, 32],
  [0x100, 0x12e, 2, 1], [0x132, 0x136, 2, 1], [0x139, 0x147, 2, 1],
  [0x14a, 0x176, 2, 1], [0x179, 0x17d, 2, 1], [0x182, 0x184, 2, 1],
  [0x189, 0x18a, 1, 205], [0x1a0, 0x1a4, 2, 1], [0x1b1, 0x1b2, 1, 217],
  [0x1b3, 0x1b5, 2, 1], [0x1cb, 0x1db, 2, 1], [0x1de, 0x1ee, 2, 1],
  [0x1f2, 0x1f4, 2, 1], [0x1f8, 0x21e, 2, 1], [0x222, 0x232, 2, 1],
  [0x246, 0x24e, 2, 1], [0x370, 0x372, 2, 1], [0x388, 0x38a, 1, 37],
  [0x38e, 0x38f, 1, 63], [0x391, 0x3a1, 1, 32], [0x3a3, 0x3ab, 1, 32],
  [0x3d8, 0x3ee, 2, 1], [0x3fd, 0x3ff, 1, -130], [0x400, 0x40f, 1, 80],
  [0x410, 0x42f, 1, 32], [0x460, 0x480, 2, 1], [0x48a, 0x4be, 2, 1],
  [0x4c1, 0x4cd, 2, 1], [0x4d0, 0x52e, 2, 1], [0x531, 0x556, 1, 48],
  [0x10a0, 0x10c5, 1, 7264], [0x13f8, 0x13fd, 1, -8], [0x1c83, 0x1c84, 1, -6210],
  [0x1c90, 0x1cba, 1, -3008], [0x1cbd, 0x1cbf, 1, -3008], [0x1e00, 0x1e94, 2, 1],
  [0x1ea0, 0x1efe, 2, 1], [0x1f08, 0x1f0f, 1, -8], [0x1f18, 0x1f1d, 1, -8],
  [0x1f28, 0x1f2f, 1, -8], [0x1f38, 0x1f3f, 1, -8], [0x1f48, 0x1f4d, 1, -8],
  [0x1f59, 0x1f5f, 2, -8], [0x1f68, 0x1f6f, 1, -8], [0x1fb8, 0x1fb9, 1, -8],
  [0x1fba, 0x1fbb, 1, -74], [0x1fc8, 0x1fcb, 1, -86], [0x1fd8, 0x1fd9, 1, -8],
  [0x1fda, 0x1fdb, 1, -100], [0x1fe8, 0x1fe9, 1, -8], [0x1fea, 0x1feb, 1, -112],
  [0x1ff8, 0x1ff9, 1, -128], [0x1ffa, 0x1ffb, 1, -126], [0x2160, 0x216f, 1, 16],
  [0x24b6, 0x24cf, 1, 26], [0x2c00, 0x2c2f, 1, 48], [0x2c67, 0x2c6b, 2, 1],
  [0x2c7e, 0x2c7f, 1, -10815], [0x2c80, 0x2ce2, 2, 1], [0x2ceb, 0x2ced, 2, 1],
  [0xa640, 0xa66c, 2, 1], [0xa680, 0xa69a, 2, 1], [0xa722, 0xa72e, 2, 1],
  [0xa732, 0xa76e, 2, 1], [0xa779, 0xa77b, 2, 1], [0xa77e, 0xa786, 2, 1],
  [0xa790, 0xa792, 2, 1], [0xa796, 0xa7a8, 2, 1], [0xa7b4, 0xa7c2, 2, 1],
  [0xa7c7, 0xa7c9, 2, 1], [0xa7cc, 0xa7da, 2, 1], [0xab70, 0xabbf, 1, -38864],
  [0xff21, 0xff3a, 1, 32], [0x10400, 0x10427, 1, 40], [0x104b0, 0x104d3, 1, 40],
  [0x10570, 0x1057a, 1, 39], [0x1057c, 0x1058a, 1, 39], [0x1058c, 0x10592, 1, 39],
  [0x10594, 0x10595, 1, 39], [0x10c80, 0x10cb2, 1, 64], [0x10d50, 0x10d65, 1, 32],
  [0x118a0, 0x118bf, 1, 32], [0x16e40, 0x16e5f, 1, 32], [0x16ea0, 0x16eb8, 1, 27],
  [0x1e900, 0x1e921, 1, 34],
]) {
  for (let cp = start; cp <= end; cp += step) {
    REFERENCE_CASE_FOLD.set(String.fromCodePoint(cp), String.fromCodePoint(cp + offset));
  }
}

function normalizeReferenceLabel(label) {
  // GFM example 554 keeps backslashes. Only case and whitespace change.
  const normalized = label.trim().replace(/\s+/g, " ");
  return [...normalized].map((ch) => REFERENCE_CASE_FOLD.get(ch) ?? ch).join("");
}

function referenceUses(value, { requireVisible = false, keepMalformed = false } = {}) {
  let text = stripRawHtmlTags(value, { keepMalformed });
  for (const range of codeSpanRanges(text).reverse()) {
    text = text.slice(0, range.start) + " " + text.slice(range.end);
  }
  text = stripLinks(text, new Set(), { keepMalformed }).rest;
  const references = new Set();
  const uses = /\[((?:[^\[\]\\]|\\.){0,999})\](?:\[((?:[^\[\]\\]|\\.){0,999})\])?/g;
  for (const match of text.matchAll(uses)) {
    if (text[match.index + match[0].length] === ":") continue;
    if (/\n[ \t]*\n/.test(match[0]) || !normalizeReferenceLabel(match[2] || match[1])) continue;
    let escapes = 0;
    for (let at = match.index - 1; at >= 0 && text[at] === "\\"; at -= 1) escapes += 1;
    if (escapes % 2) continue;
    if (requireVisible && !(text[match.index - 1] === "!" && !isEscaped(text, match.index - 1))
      && !visibleFieldText(match[1]).replace(/[\p{Default_Ignorable_Code_Point}\p{Mark}]/gu, "").trim()) continue;
    references.add(normalizeReferenceLabel(match[2] || match[1]));
  }
  return references;
}

/** Visible inline text for required fields: destinations and HTML attributes
 * cannot turn a placeholder label into a substantive explanation. */
function visibleFieldText(value) {
  value = referenceHeadingView(String(value).replaceAll("\u0000", ""));
  let text = "";
  let cursor = 0;
  for (let at = value.indexOf("]("); at !== -1; at = value.indexOf("](", cursor)) {
    const open = linkTextStart(value, at, cursor);
    const tail = open === -1 ? null : parseLinkTail(value, at + 1);
    if (open === -1) {
      text += value.slice(cursor, at + 2);
      cursor = at + 2;
      continue;
    }
    if (!tail) {
      // Stop after a malformed tail rather than scanning overlapping tails.
      // Its destination/title cannot supply substantive visible field text.
      text += value.slice(cursor, open > cursor && value[open - 1] === "!" ? open - 1 : open) + value.slice(open + 1, at);
      cursor = value.length;
      break;
    }
    text += value.slice(cursor, open > cursor && value[open - 1] === "!" ? open - 1 : open) + value.slice(open + 1, at);
    cursor = tail.end;
  }
  text += value.slice(cursor);
  text = stripRawHtmlTags(text)
    .replace(/!?\[([^\]\n]*)\](?:\[[^\]\n]*\])?/g, "$1")
    .replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, "$1");
  return decodeCharacterReferences(text).replace(/[*_`~]/g, "").trim();
}

function decodeCharacterReferences(text, { htmlNumeric = false, dropBreaks = false } = {}) {
  const pattern = htmlNumeric
    ? /&(#[xX][\da-fA-F]+;?|#\d+;?|[a-zA-Z][a-zA-Z\d]*;)/g
    : /&(#[xX][\da-fA-F]+;|#\d+;|[a-zA-Z][a-zA-Z\d]*;)/g;
  return text.replace(pattern, (match, rawEntity) => {
    const entity = rawEntity.replace(/;$/, "");
    let decoded = match;
    if (entity[0] !== "#") {
      if (Object.hasOwn(NAMED_CHARACTER_REFERENCES, entity)) decoded = NAMED_CHARACTER_REFERENCES[entity];
    } else {
      const code = entity[1].toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      decoded = code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "\ufffd";
    }
    if (dropBreaks && decoded !== match && /^[\t\n\r]+$/.test(decoded)) return "";
    return decoded;
  });
}

// Fold common Greek/Cyrillic lookalikes only for placeholder comparison.
// This never changes the submitted explanation or requires English prose.
const PLACEHOLDER_LOOKALIKES = new Map([
  ["a", "αа"], ["b", "βв"], ["c", "ϲс"], ["d", "ԁ"],
  ["e", "εе"], ["f", "ϝғ"], ["h", "ηнһ"], ["i", "ιіӏ"],
  ["k", "κк"], ["m", "μм"], ["n", "νп"], ["o", "οо"],
  ["p", "ρр"], ["s", "ѕ"], ["t", "τт"], ["x", "χх"], ["y", "υу"],
].flatMap(([ascii, letters]) => [...letters].map((letter) => [letter, ascii])));

function stripLeadingListMarkers(text) {
  return text.split("\n").map((line) => line.replace(/^(?:[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]*)?)+/, "")).join("\n").trim();
}

function isPlaceholderField(value) {
  const visible = stripLeadingListMarkers(visibleFieldText(value)).normalize("NFKD").toLowerCase()
    .replace(/[\p{Default_Ignorable_Code_Point}\p{Mark}]/gu, "");
  const plain = [...visible].map((letter) => PLACEHOLDER_LOOKALIKES.get(letter) ?? letter).join("").trim();
  return !/[\p{Letter}\p{Number}]/u.test(plain) || /^(?:todo|tbd|fixme|placeholder)\b/i.test(plain)
    || /^(?:n\/?a|none|pending|not provided)[.!?]*$/i.test(plain)
    || /^(?:not[\s-]+(?:run|tested|executed)|no tests?(?:[\s-]+(?:run|were run|executed))?|did(?:n't| not)[\s-]+(?:test|run)|untested|tests?[\s-]+not[\s-]+(?:run|executed))[.!?]*$/i.test(plain);
}

/**
 * Evidence requires steps, observed result, and a concrete artifact: either the
 * artifact field or freeform text outside the template fields. A journey name,
 * a bare category word, or exemption-reason text cannot pass.
 */
export function hasEvidenceContent(sectionText, definitions = new Map()) {
  const steps = readField(sectionText, FIELD_LABELS.steps);
  const result = readField(sectionText, FIELD_LABELS.result);
  const artifact = findField(sectionText, FIELD_LABELS.artifact)?.text ?? "";
  if (isPlaceholderField(steps) || isPlaceholderField(result)) return false;
  // Count reference destinations only for visible reference uses in verification
  // content, never for definitions or labels inside the exemption reason.
  const verification = withoutFencePayload(withoutFields(sectionText, [FIELD_LABELS.reason]));
  const references = referenceUses(verification, { requireVisible: true });
  return looksLikeArtifact(artifact, references, definitions)
    || looksLikeArtifact(freeformText(sectionText), references, definitions);
}

const ANSI_C_ESCAPES = {
  a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n",
  r: "\r", t: "\t", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?",
};

function ansiCFragment(value, start) {
  let text = "";
  let terminated = false;
  for (let index = start; index < value.length; index += 1) {
    const ch = value[index];
    if (ch === "'") return { text, end: index };
    let decoded = ch;
    if (ch === "\\") {
      const escape = value[++index];
      if (Object.hasOwn(ANSI_C_ESCAPES, escape)) decoded = ANSI_C_ESCAPES[escape];
      else {
        const pattern = /[0-7]/.test(escape ?? "") ? /^[0-7]{1,3}/
          : { x: /^[\da-fA-F]{1,2}/, u: /^[\da-fA-F]{1,4}/, U: /^[\da-fA-F]{1,8}/ }[escape];
        const digits = pattern?.exec(value.slice(index + (escape === "x" || escape === "u" || escape === "U" ? 1 : 0)))?.[0];
        if (digits) {
          const octal = /[0-7]/.test(escape);
          const code = parseInt(digits, octal ? 8 : 16);
          decoded = String.fromCodePoint(octal || escape === "x" ? code & 255 : code <= 0x10ffff ? code : 0xfffd);
          index += digits.length - (octal ? 1 : 0);
        } else if (escape === "c" && value[index + 1] !== undefined) {
          const control = value[++index];
          decoded = String.fromCharCode(control === "?" ? 127 : control.toUpperCase().charCodeAt(0) & 31);
        } else decoded = "\\" + (escape ?? "");
      }
    }
    if (decoded === "\0") terminated = true;
    if (!terminated) text += decoded;
  }
  return null;
}

const ARITHMETIC_INT64_MIN = -9223372036854775808n;
const ARITHMETIC_INT64_MAX = 9223372036854775807n;

/**
 * Decimal integers, parentheses, and + - * / % only. No eval.
 * Leading zeros, bases, variables, assignments, ++/--, and other operators
 * stay unresolved. An unresolved expansion inside a curl or wget URL operand
 * is rejected without naming a host. Single quotes and escaped dollars stay literal.
 */
function evaluateArithmetic(body) {
  if (body.length > 128) return null;
  let index = 0;
  const skip = () => {
    while (index < body.length && /[ \t\n\r]/.test(body[index])) index += 1;
  };
  const fit = (value) => (value < ARITHMETIC_INT64_MIN || value > ARITHMETIC_INT64_MAX ? null : value);
  const parseExpr = (depth) => {
    if (depth > 32) return null;
    let left = parseTerm(depth);
    if (left == null) return null;
    for (;;) {
      skip();
      const op = body[index];
      if (op !== "+" && op !== "-") break;
      index += 1;
      const right = parseTerm(depth);
      if (right == null) return null;
      left = fit(op === "+" ? left + right : left - right);
      if (left == null) return null;
    }
    return left;
  };
  const parseTerm = (depth) => {
    let left = parseUnary(depth);
    if (left == null) return null;
    for (;;) {
      skip();
      const op = body[index];
      if (op !== "*" && op !== "/" && op !== "%") break;
      if (op === "*" && body[index + 1] === "*") return null;
      index += 1;
      const right = parseUnary(depth);
      if (right == null || ((op === "/" || op === "%") && right === 0n)) return null;
      left = fit(op === "*" ? left * right : op === "/" ? left / right : left % right);
      if (left == null) return null;
    }
    return left;
  };
  const parseUnary = (depth) => {
    skip();
    const op = body[index];
    if (op !== "+" && op !== "-") return parsePrimary(depth);
    if (body[index + 1] === op) return null;
    index += 1;
    const value = parseUnary(depth);
    if (value == null) return null;
    return fit(op === "-" ? -value : value);
  };
  const parsePrimary = (depth) => {
    skip();
    if (body[index] === "(") {
      index += 1;
      const value = parseExpr(depth + 1);
      skip();
      if (value == null || body[index] !== ")") return null;
      index += 1;
      return value;
    }
    if (!/\d/.test(body[index] ?? "")) return null;
    if (body[index] === "0" && /\d/.test(body[index + 1] ?? "")) return null;
    const start = index;
    while (/\d/.test(body[index] ?? "")) index += 1;
    if (index - start > 19) return null;
    return fit(BigInt(body.slice(start, index)));
  };
  const value = parseExpr(0);
  skip();
  return value == null || index !== body.length ? null : value;
}

function readStaticArithmetic(value, start, quote) {
  const limit = Math.min(value.length, start + 256);
  let index = start + 3;
  let depth = 0;
  while (index < limit) {
    const ch = value[index];
    if (ch === "(") {
      depth += 1;
      index += 1;
      continue;
    }
    if (ch === ")") {
      if (depth === 0) {
        if (value[index + 1] !== ")") return { resolved: false, text: value.slice(start, index + 1), end: index + 1 };
        const end = index + 2;
        const evaluated = evaluateArithmetic(value.slice(start + 3, index));
        return evaluated == null
          ? { resolved: false, text: value.slice(start, end), end }
          : { resolved: true, text: evaluated.toString(), end };
      }
      depth -= 1;
      index += 1;
      continue;
    }
    if (depth === 0 && (ch === quote || ch === "\n" || ch === "\r" || ch === ";" || ch === "|" || ch === "&" || ch === "<" || ch === ">" || ch === "`")) {
      return { resolved: false, text: value.slice(start, index), end: index };
    }
    index += 1;
  }
  return { resolved: false, text: value.slice(start, index), end: index };
}

function readParenGroup(value, openIndex) {
  const limit = Math.min(value.length, openIndex + 256);
  let index = openIndex + 1;
  let depth = 1;
  let quote = null;
  while (index < limit && depth > 0) {
    const ch = value[index];
    if (quote) {
      if (quote === '"' && ch === "\\" && index + 1 < limit) {
        index += 2;
        continue;
      }
      if (ch === quote) quote = null;
      index += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      index += 1;
      continue;
    }
    if (ch === "\\") {
      index += index + 1 < limit ? 2 : 1;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    index += 1;
  }
  return { end: index, closed: depth === 0 };
}

function readCommandSubstitution(value, start) {
  const limit = Math.min(value.length, start + 256);
  let index = start + 2;
  let depth = 1;
  let quote = null;
  while (index < limit && depth > 0) {
    const ch = value[index];
    if (quote) {
      if (quote === '"' && ch === "\\" && index + 1 < limit) {
        index += 2;
        continue;
      }
      if (ch === quote) quote = null;
      index += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      index += 1;
      continue;
    }
    if (ch === "\\") {
      index += index + 1 < limit ? 2 : 1;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    index += 1;
  }
  return { text: value.slice(start, index), end: index, closed: depth === 0 };
}

function shellFenceLine(value, index) {
  const start = value.lastIndexOf("\n", index - 1) + 1;
  const end = value.indexOf("\n", index);
  return /^[ ]{0,3}`{3,}[^`]*$/.test(value.slice(start, end === -1 ? value.length : end));
}

// A backslash keeps the next character only before $, `, or \. The body is not run.
function readBacktickSubstitution(value, start) {
  const limit = value.length;
  let index = start + 1;
  while (index < limit) {
    const ch = value[index];
    if (ch === "\\" && index + 1 < limit && /[$`\\]/.test(value[index + 1])) {
      index += 2;
      continue;
    }
    if (ch === "`") return { text: value.slice(start, index + 1), end: index + 1, closed: true };
    index += 1;
  }
  return { text: value.slice(start, index), end: index, closed: false };
}

function staticParameterFallback(raw) {
  if (/\$|`/.test(raw)) return { dynamic: true };
  let text = raw;
  if ((text.startsWith("'") && text.endsWith("'") && text.length >= 2)
    || (text.startsWith('"') && text.endsWith('"') && text.length >= 2)) {
    text = text.slice(1, -1);
  }
  return { text };
}

// A parameter expansion is not evaluated. A curl or wget target fails closed only when this shell text assigned that name.
// A static `${name:-word}` fallback is also a candidate, because Bash uses it when the name is unset.
function readParameterExpansion(value, start) {
  const next = value[start + 1];
  if (next === undefined || next === "(" || next === "'") return null;
  if (next === "{") {
    let name = null;
    let nameAt = start + 2;
    if (value[nameAt] === "!") {
      const indirectAt = nameAt + 1;
      if (/[A-Za-z_]/.test(value[indirectAt] ?? "")) {
        let endName = indirectAt;
        while (/[A-Za-z0-9_]/.test(value[endName] ?? "")) endName += 1;
        if (value[endName] === "}") return { end: endName + 1, name: null, indirect: value.slice(indirectAt, endName) };
      }
    } else if (/[0-9]/.test(value[nameAt] ?? "")) {
      let endName = nameAt;
      while (/[0-9]/.test(value[endName] ?? "")) endName += 1;
      if (value[endName] === "}" && /^(?:0|[1-9][0-9]*)$/.test(value.slice(nameAt, endName))) {
        return { end: endName + 1, name: value.slice(nameAt, endName) };
      }
    }
    if (/[A-Za-z_]/.test(value[nameAt] ?? "")) {
      const nameStart = nameAt;
      while (/[A-Za-z0-9_]/.test(value[nameAt] ?? "")) nameAt += 1;
      name = value.slice(nameStart, nameAt);
    }
    const two = value.slice(nameAt, nameAt + 2);
    const wordAt = two === ":-" || two === ":=" || two === ":+"
      ? nameAt + 2
      : (value[nameAt] === "-" || value[nameAt] === "=" || value[nameAt] === "+" ? nameAt + 1 : -1);
    const limit = Math.min(value.length, start + 256);
    let index = start + 2;
    let depth = 1;
    while (index < limit && depth > 0) {
      const ch = value[index];
      if (ch === "\\" && index + 1 < limit) {
        index += 2;
        continue;
      }
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      else if (depth === 1 && (ch === "\n" || ch === ";" || ch === "|" || ch === "&" || ch === "`")) break;
      index += 1;
    }
    let fallback = null;
    let dynamicFallback = false;
    if (name && wordAt !== -1) {
      if (depth !== 0) dynamicFallback = true;
      else {
        const parsed = staticParameterFallback(value.slice(wordAt, index - 1));
        if (parsed.dynamic) dynamicFallback = true;
        else fallback = parsed.text;
      }
    }
    return { end: index, name, fallback, dynamicFallback };
  }
  if (/[0-9]/.test(next)) return { end: start + 2, name: next };
  if (/[*@#?!$\-]/.test(next)) return { end: start + 2, name: null };
  if (!/[A-Za-z_]/.test(next)) return null;
  let index = start + 2;
  while (index < value.length && /[A-Za-z0-9_]/.test(value[index])) index += 1;
  return { end: index, name: value.slice(start + 1, index) };
}

function shellWords(value, { commandTokens = false } = {}) {
  const words = [];
  let word = "";
  let quote = null;
  let braceText = "";
  let wordStarted = false;
  let wordProtected = false;
  let wordUnresolved = false;
  let wordSubstitution = false;
  let wordParameters = [];
  let nameQuoted = false;
  let sawUnquotedEquals = false;
  let substitutionBodies = [];
  let wordProcessSource = false;
  let wordReplacements = [];
  let wordDynamicFallback = false;
  let wordIndirect = null;
  let fenceFrom = -1;
  let fenceTo = -1;
  let fenceHit = false;
  const fenceAt = (index) => {
    if (index >= fenceFrom && index < fenceTo) return fenceHit;
    fenceHit = shellFenceLine(value, index);
    const start = value.lastIndexOf("\n", index - 1) + 1;
    let end = value.indexOf("\n", index);
    if (end === -1) end = value.length;
    fenceFrom = start;
    fenceTo = end + 1;
    return fenceHit;
  };
  const append = (text, protectedText = false) => {
    wordStarted = true;
    wordProtected ||= protectedText;
    word += text;
    braceText += protectedText ? text.replace(/[\\{},.]/g, (ch) => "\\" + ch) : text;
  };
  const flush = () => {
    if (word || (commandTokens && wordStarted)) {
      const assignable = !nameQuoted && /^[A-Za-z_][\w]*\+?=/.test(word);
      words.push(commandTokens ? {
        text: word,
        plain: !wordProtected,
        braceText,
        unresolved: wordUnresolved,
        substitution: wordSubstitution,
        parameters: wordParameters,
        assignable,
        substitutionBodies,
        processSource: wordProcessSource,
        replacements: wordReplacements,
        dynamicFallback: wordDynamicFallback,
        indirect: wordIndirect,
      } : word);
    }
    word = "";
    braceText = "";
    wordStarted = false;
    wordProtected = false;
    wordUnresolved = false;
    wordSubstitution = false;
    wordParameters = [];
    nameQuoted = false;
    sawUnquotedEquals = false;
    substitutionBodies = [];
    wordProcessSource = false;
    wordReplacements = [];
    wordDynamicFallback = false;
    wordIndirect = null;
  };
  for (let index = 0; index < value.length; index += 1) {
    const ch = value[index];
    if (quote !== "'" && ch === "$" && value[index + 1] === "(" && value[index + 2] === "(") {
      const expansion = readStaticArithmetic(value, index, quote);
      append(expansion.text, true);
      if (!expansion.resolved) wordUnresolved = true;
      index = expansion.end - 1;
      continue;
    }
    // $(...) and backticks stay in this word, including at its start, so a curl or wget
    // operand is not split off. The body is not executed. A later scan keeps a nested client visible.
    if (quote !== "'" && ch === "$" && value[index + 1] === "(") {
      const substitution = readCommandSubstitution(value, index);
      append(substitution.text, true);
      wordUnresolved = true;
      wordSubstitution = true;
      const inner = substitution.text.slice(2);
      substitutionBodies.push(substitution.closed ? inner.slice(0, -1) : inner);
      index = substitution.end - 1;
      continue;
    }
    // A fence line is three or more backticks. Those ticks stay separators, and the marker tells the caller to drop retained assignments.
    if (quote === null && ch === "`" && fenceAt(index)) {
      flush();
      if (commandTokens) words.push({ fence: true });
      continue;
    }
    if (quote !== "'" && ch === "`") {
      const substitution = readBacktickSubstitution(value, index);
      append(substitution.text, true);
      wordUnresolved = true;
      wordSubstitution = true;
      const inner = substitution.text.slice(1);
      const body = substitution.closed ? inner.slice(0, -1) : inner;
      if (/\S/.test(body)) substitutionBodies.push(body);
      index = substitution.end - 1;
      continue;
    }
    // Bash process substitution is one filename operand, not a redirect plus a subshell.
    if (quote === null && ch === "<" && value[index + 1] === "(") {
      const group = readParenGroup(value, index + 1);
      append(value.slice(index, group.end), true);
      wordProcessSource = true;
      index = group.end - 1;
      continue;
    }
    if (quote === null && !wordStarted && (ch === "{" || ch === "}") && (index + 1 === value.length || /[\s;|&<>()]/.test(value[index + 1]))) {
      flush();
      if (commandTokens) words.push(null);
      continue;
    }
    if (quote === null && /[\s;|&<>()]/.test(ch)) {
      flush();
      if (commandTokens && /[\n\r;|&<>()]/.test(ch)) words.push(null);
      continue;
    }
    if (quote === null && ch === "#" && !wordStarted) {
      const end = value.indexOf("\n", index);
      if (end === -1) break;
      index = end - 1;
      continue;
    }
    if (quote === null && ch === "$" && value[index + 1] === "'") {
      const fragment = ansiCFragment(value, index + 2);
      if (!fragment) return commandTokens ? words : words.filter((word) => !/\s/.test(word));
      append(fragment.text, true);
      index = fragment.end;
      continue;
    }
    if (quote !== "'" && ch === "$") {
      const parameter = readParameterExpansion(value, index);
      if (parameter) {
        const slice = value.slice(index, parameter.end);
        if (parameter.fallback != null) {
          wordReplacements.push({ from: word.length, length: slice.length, fallback: parameter.fallback });
        }
        if (parameter.dynamicFallback) wordDynamicFallback = true;
        if (parameter.indirect) wordIndirect = parameter.indirect;
        append(slice, true);
        if (parameter.name) wordParameters.push(parameter.name);
        index = parameter.end - 1;
        continue;
      }
    }
    if (ch === "\\" && quote !== "'") {
      const next = value[index + 1];
      if (next !== undefined && (quote === null || /[\\"$`]/.test(next))) {
        append(next, true);
        index += 1;
      } else append(ch, quote !== null);
      continue;
    }
    if (ch === quote) quote = null;
    else if (quote === null && (ch === "'" || ch === '"')) {
      if (!sawUnquotedEquals) nameQuoted = true;
      quote = ch;
      wordProtected = true;
      wordStarted = true;
    } else {
      if (quote === null && ch === "=") sawUnquotedEquals = true;
      append(ch, quote !== null);
    }
  }
  if (quote === null) flush();
  return commandTokens ? words : words.filter((word) => !/\s/.test(word));
}

// Value-taking options from curl 8.18.0 --help all.
const CURL_VALUE_OPTIONS = new Set([
  "abstract-unix-socket alt-svc aws-sigv4 cacert capath cert cert-type ciphers",
  "config connect-timeout connect-to continue-at cookie cookie-jar create-file-mode crlfile",
  "curves data data-ascii data-binary data-raw data-urlencode delegation dns-interface",
  "dns-ipv4-addr dns-ipv6-addr dns-servers doh-url dump-header ech egd-file engine",
  "etag-compare etag-save expect100-timeout form form-string ftp-account ftp-alternative-to-user ftp-method",
  "ftp-port ftp-ssl-ccc-mode happy-eyeballs-timeout-ms haproxy-clientip header help hostpubmd5 hostpubsha256",
  "hsts interface ip-tos ipfs-gateway json keepalive-cnt keepalive-time key",
  "key-type knownhosts krb libcurl limit-rate local-port login-options mail-auth",
  "mail-from mail-rcpt max-filesize max-redirs max-time netrc-file noproxy oauth2-bearer",
  "output output-dir parallel-max parallel-max-host pass pinnedpubkey preproxy proto",
  "proto-default proto-redir proxy proxy-cacert proxy-capath proxy-cert proxy-cert-type proxy-ciphers",
  "proxy-crlfile proxy-header proxy-key proxy-key-type proxy-pass proxy-pinnedpubkey proxy-service-name proxy-tls13-ciphers",
  "proxy-tlsauthtype proxy-tlspassword proxy-tlsuser proxy-user pubkey quote random-file range",
  "rate referer request request-target resolve retry retry-delay retry-max-time",
  "sasl-authzid service-name sigalgs socks4 socks4a socks5 socks5-gssapi-service socks5-hostname",
  "speed-limit speed-time ssl-sessions stderr telnet-option tftp-blksize time-cond tls-max",
  "tls13-ciphers tlsauthtype tlspassword tlsuser trace trace-ascii trace-config unix-socket",
  "upload-file upload-flags url url-query user user-agent variable vlan-priority",
  "write-out",
].join(" ").split(" "));
const CURL_SHORT_VALUE_OPTIONS = new Set("EKCbcdDFPHhmoxUQreXYytzTuAw");
const MAX_STATIC_CURL_TARGETS = 4096;

function expandTargetGlobs(value, { shell = false } = {}) {
  let values = [value];
  for (let pass = 0; pass <= value.length; pass += 1) {
    let changed = false;
    const next = [];
    for (const text of values) {
      let span = null;
      for (let at = 0; at < text.length; at += 1) {
        if (text[at] === "\\") { at += 1; continue; }
        if (text[at] !== "{" && (shell || text[at] !== "[")) continue;
        const close = text[at] === "{" ? "}" : "]";
        const end = text.indexOf(close, at + 1);
        if (end === -1) { if (shell) continue; return { values: [], overflow: false }; }
        const content = text.slice(at + 1, end);
        if (!shell && text[at] === "[" && content.includes(":") && /^[\da-f:.%]+$/i.test(content)) {
          at = end;
          continue;
        }
        if (content.includes("{")) { if (shell) continue; return { values: [], overflow: false }; }
        let items;
        const authorityStart = /^(?:[a-z][\w+.-]*:\/{1,3}|\/\/)/i.exec(text)?.[0].length ?? 0;
        const pathStart = text.slice(authorityStart).search(/[/?#]/);
        const inPath = !shell && pathStart !== -1 && at >= authorityStart + pathStart;
        const list = [""];
        for (let index = 0; index < content.length; index += 1) {
          if (content[index] === "\\" && index + 1 < content.length) list[list.length - 1] += content[index] + content[++index];
          else if (content[index] === ",") list.push("");
          else list[list.length - 1] += content[index];
        }
        if (text[at] === "{" && (!shell || list.length > 1)) items = list;
        else {
          const range = (shell ? /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$|^([a-zA-Z])\.\.([a-zA-Z])(?:\.\.(-?\d+))?$/
            : /^(\d+)-(\d+)(?::(\d+))?$|^([a-zA-Z])-([a-zA-Z])(?::(\d+))?$/).exec(content);
          if (!range) { if (shell) continue; return { values: [], overflow: false }; }
          const numeric = range[1] !== undefined;
          const first = numeric ? Number(range[1]) : range[4].charCodeAt(0);
          const last = numeric ? Number(range[2]) : range[5].charCodeAt(0);
          const step = Math.abs(Number(range[3] ?? range[6] ?? 1));
          if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || !Number.isSafeInteger(step)
            || step === 0 || (!shell && first > last)) return { values: [], overflow: false };
          const count = Math.floor(Math.abs(last - first) / step) + 1;
          if (!inPath && count > MAX_STATIC_CURL_TARGETS) return { values: [], overflow: true };
          const width = numeric && /^-?0\d/.test(range[1]) ? range[1].replace("-", "").length : 0;
          items = Array.from({ length: inPath ? 1 : count }, (_, i) => {
            const n = first + i * step * (first <= last ? 1 : -1);
            return numeric ? (n < 0 ? "-" : "") + String(Math.abs(n)).padStart(width, "0") : String.fromCharCode(n);
          });
        }
        if (items.some((item) => /[{}\[\]]/.test(item))) return { values: [], overflow: false };
        span = { at, end, items: inPath ? items.slice(0, 1) : items };
        break;
      }
      if (!span) { next.push(text); continue; }
      changed = true;
      if (next.length + span.items.length > MAX_STATIC_CURL_TARGETS) return { values: [], overflow: true };
      next.push(...span.items.map((item) => text.slice(0, span.at) + item + text.slice(span.end + 1)));
    }
    values = next;
    if (!changed) return { values, overflow: false };
  }
  return { values: [], overflow: true };
}

const COMMAND_LAUNCHERS = {
  env: {
    mode: "executable", flags: "iv", values: "uCa",
    longFlags: ["ignore-environment", "debug", "list-signal-handling"],
    longValues: ["unset", "chdir", "argv0"], optionalValues: ["ignore-signal", "default-signal", "block-signal"],
  },
  command: { mode: "shell", flags: "p", values: "", longFlags: [], longValues: [] },
  exec: { mode: "executable", flags: "cl", values: "a", longFlags: [], longValues: [] },
  builtin: { mode: "builtin", flags: "", values: "", longFlags: [], longValues: [] },
  nice: { mode: "executable", flags: "", values: "n", longFlags: [], longValues: ["adjustment"] },
  nohup: { mode: "executable", flags: "", values: "", longFlags: [], longValues: [] },
  timeout: {
    mode: "executable", flags: "v", values: "sk",
    longFlags: ["foreground", "preserve-status", "verbose"], longValues: ["signal", "kill-after"],
  },
};
const SHELL_COMMAND_LAUNCHERS = new Set(["command", "exec", "builtin"]);

const SUDO_SHORT = {
  A: { kind: "flag", flag: "askpass" }, a: { kind: "value", key: "auth-type" },
  B: { kind: "flag" }, b: { kind: "flag", flag: "background" },
  C: { kind: "value", key: "close-from" }, c: { kind: "value", key: "login-class" },
  D: { kind: "value", key: "chdir" }, E: { kind: "flag", flag: "preserveEnv" },
  e: { kind: "mode", mode: "edit" }, g: { kind: "value", key: "group" },
  H: { kind: "flag", flag: "setHome" }, h: { kind: "optional" },
  i: { kind: "flag", flag: "login" }, K: { kind: "mode", mode: "kill" },
  k: { kind: "flag" }, l: { kind: "mode", mode: "list" }, N: { kind: "flag" },
  n: { kind: "flag", flag: "noninteractive" }, P: { kind: "flag", flag: "preserveGroups" },
  p: { kind: "value", key: "prompt" }, R: { kind: "value", key: "chroot" },
  r: { kind: "value", key: "role" }, S: { kind: "flag", flag: "stdin" },
  s: { kind: "flag", flag: "shell" }, T: { kind: "value", key: "command-timeout" },
  t: { kind: "value", key: "type" }, U: { kind: "value", key: "other-user" },
  u: { kind: "value", key: "user" }, V: { kind: "mode", mode: "version" },
  v: { kind: "mode", mode: "validate" },
};
const SUDOEDIT_SHORT = {
  A: SUDO_SHORT.A, a: SUDO_SHORT.a, B: SUDO_SHORT.B, C: SUDO_SHORT.C, c: SUDO_SHORT.c,
  D: SUDO_SHORT.D, g: SUDO_SHORT.g, h: SUDO_SHORT.h, K: SUDO_SHORT.K, k: SUDO_SHORT.k,
  N: SUDO_SHORT.N, n: SUDO_SHORT.n, p: SUDO_SHORT.p, R: SUDO_SHORT.R, r: SUDO_SHORT.r,
  S: SUDO_SHORT.S, T: SUDO_SHORT.T, t: SUDO_SHORT.t, u: SUDO_SHORT.u, V: SUDO_SHORT.V,
};
const SUDO_LONG = {
  background: { kind: "flag", flag: "background" },
  "preserve-env": { kind: "optional-env" },
  edit: { kind: "mode", mode: "edit" },
  "set-home": { kind: "flag", flag: "setHome" },
  login: { kind: "flag", flag: "login" },
  "remove-timestamp": { kind: "mode", mode: "kill" },
  list: { kind: "mode", mode: "list" },
  "preserve-groups": { kind: "flag", flag: "preserveGroups" },
  shell: { kind: "flag", flag: "shell" },
  "other-user": { kind: "value", key: "other-user" },
  validate: { kind: "mode", mode: "validate" },
  askpass: { kind: "flag", flag: "askpass" },
  "auth-type": { kind: "value", key: "auth-type" },
  bell: { kind: "flag" },
  "close-from": { kind: "value", key: "close-from" },
  "login-class": { kind: "value", key: "login-class" },
  chdir: { kind: "value", key: "chdir" },
  group: { kind: "value", key: "group" },
  help: { kind: "mode", mode: "help" },
  host: { kind: "value", key: "host" },
  "reset-timestamp": { kind: "flag" },
  "no-update": { kind: "flag" },
  "non-interactive": { kind: "flag", flag: "noninteractive" },
  prompt: { kind: "value", key: "prompt" },
  chroot: { kind: "value", key: "chroot" },
  role: { kind: "value", key: "role" },
  stdin: { kind: "flag", flag: "stdin" },
  "command-timeout": { kind: "value", key: "command-timeout" },
  type: { kind: "value", key: "type" },
  user: { kind: "value", key: "user" },
  version: { kind: "mode", mode: "version" },
};
const SUDOEDIT_LONG = Object.fromEntries(Object.entries(SUDO_LONG).filter(([name]) => [
  "askpass", "auth-type", "bell", "close-from", "login-class", "chdir", "group", "help", "host",
  "reset-timestamp", "no-update", "non-interactive", "prompt", "chroot", "role", "stdin",
  "command-timeout", "type", "user", "version",
].includes(name)));
const SUDO_RUN_FLAGS = new Set(["background", "preserveEnv", "setHome", "login", "noninteractive", "preserveGroups", "shell"]);

function sudoAssignment(text) {
  return text.length > 0 && text[0] !== "/" && text[0] !== "=" && !text.startsWith("-") && text.includes("=");
}

function sudoCommandIndex(command, index) {
  const base = command[index].text.slice(command[index].text.lastIndexOf("/") + 1);
  const editInvoked = base === "sudoedit";
  const shortKind = editInvoked ? SUDOEDIT_SHORT : SUDO_SHORT;
  const longKind = editInvoked ? SUDOEDIT_LONG : SUDO_LONG;
  const flag = {};
  const once = new Set();
  let mode = editInvoked ? "edit" : "";
  let sawEnvar = false;
  let askpass = false;
  let stdin = false;
  let cursor = index + 1;
  const raise = (name) => {
    if (name === "askpass") askpass = true;
    else if (name === "stdin") stdin = true;
    else if (name) flag[name] = true;
  };
  const setMode = (spec) => {
    if (spec.mode === "list" && mode === "list") { flag.longList = true; return true; }
    if (mode && mode !== spec.mode) return false;
    mode = spec.mode;
    return true;
  };
  const takeValue = (key, value) => {
    if (value === undefined || value === "--") return false;
    if (value === "" && key !== "prompt" && key !== "command-timeout") return false;
    if (once.has(key)) return false;
    if (key === "close-from") {
      const number = Number(value);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 3 || number > 2147483647) return false;
    }
    once.add(key);
    return true;
  };
  const consumeShort = (option) => {
    let next = cursor + 1;
    for (let at = 1; at < option.length; at += 1) {
      const spec = shortKind[option[at]];
      if (!spec) return -1;
      if (spec.kind === "flag") { raise(spec.flag); continue; }
      if (spec.kind === "mode") {
        if (!setMode(spec)) return -1;
        raise(spec.flag);
        continue;
      }
      if (spec.kind === "optional") {
        const inline = option.slice(at + 1);
        if (inline) return takeValue("host", inline) ? next : -1;
        const host = command[next]?.text;
        if (option === "-h" && host !== undefined && !host.startsWith("-") && !sudoAssignment(host)) {
          return takeValue("host", host) ? next + 1 : -1;
        }
        return setMode({ mode: "help" }) ? next : -1;
      }
      const inline = option.slice(at + 1);
      if (inline) return takeValue(spec.key, inline) ? next : -1;
      return takeValue(spec.key, command[next]?.text) ? next + 1 : -1;
    }
    return next;
  };

  while (cursor < command.length) {
    const option = command[cursor].text;
    if (option === "--") { cursor += 1; break; }
    if (sudoAssignment(option)) {
      if (editInvoked || mode === "edit") return -1;
      sawEnvar = true;
      cursor += 1;
      continue;
    }
    if (option === "-" || !option.startsWith("-")) break;
    if (option.startsWith("--")) {
      const eq = option.indexOf("=", 2);
      const spec = longKind[option.slice(2, eq === -1 ? undefined : eq)];
      if (!spec) return -1;
      if (spec.kind === "flag" || spec.kind === "mode") {
        if (spec.kind === "mode" && !setMode(spec)) return -1;
        raise(spec.flag);
        cursor += 1;
        continue;
      }
      if (spec.kind === "optional-env") {
        if (eq === -1) raise("preserveEnv");
        cursor += 1;
        continue;
      }
      if (eq !== -1) {
        if (!takeValue(spec.key, option.slice(eq + 1))) return -1;
        cursor += 1;
        continue;
      }
      if (!takeValue(spec.key, command[cursor + 1]?.text)) return -1;
      cursor += 2;
      continue;
    }
    cursor = consumeShort(option);
    if (cursor < 0) return -1;
  }

  if (!mode) mode = "run";
  if (mode === "list" && cursor < command.length) mode = "check";
  if (flag.login && flag.shell) return -1;
  if (flag.login && flag.preserveEnv) return -1;
  if ((mode === "edit" || editInvoked) && (flag.preserveEnv || sawEnvar)) return -1;
  if (askpass && stdin) return -1;
  const allowedByMode = {
    run: SUDO_RUN_FLAGS,
    edit: new Set(["noninteractive"]),
    list: new Set(["noninteractive", "longList"]),
    check: new Set(["noninteractive", "longList"]),
    validate: new Set(["noninteractive"]),
  };
  const allowed = allowedByMode[mode] ?? new Set();
  if (Object.keys(flag).some((name) => !allowed.has(name))) return -1;
  if (cursor < command.length && mode !== "run" && mode !== "edit" && mode !== "check") return -1;
  if (mode !== "run" || cursor >= command.length) return -1;
  return { index: cursor, shell: Boolean(flag.shell || flag.login) };
}

const MAX_CURL_EXPAND_BYTES = 4096;
const MAX_CURL_EXPAND_TOTAL = 65536;

function chargeCurlExpand(budget, bytes) {
  if (bytes > MAX_CURL_EXPAND_BYTES || budget.used > MAX_CURL_EXPAND_TOTAL - bytes) return false;
  budget.used += bytes;
  return true;
}

function utf8ByteLength(code) {
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  if (code < 0x10000) return 3;
  return 4;
}

function curlUnreservedByte(byte) {
  return (byte >= 48 && byte <= 57)
    || (byte >= 65 && byte <= 90)
    || (byte >= 97 && byte <= 122)
    || byte === 45 || byte === 46 || byte === 95 || byte === 126;
}

function curlJsonEscape(value, budget) {
  if (Buffer.byteLength(value, "utf8") > MAX_CURL_EXPAND_BYTES) return null;
  const parts = [];
  let bytes = 0;
  for (const ch of value) {
    const code = ch.codePointAt(0);
    let piece;
    if (ch === "\\") piece = "\\\\";
    else if (ch === "\"") piece = "\\\"";
    else if (ch === "\b") piece = "\\b";
    else if (ch === "\f") piece = "\\f";
    else if (ch === "\n") piece = "\\n";
    else if (ch === "\r") piece = "\\r";
    else if (ch === "\t") piece = "\\t";
    else if (code < 32) piece = `\\u${code.toString(16).padStart(4, "0")}`;
    else piece = ch;
    bytes += piece === ch ? utf8ByteLength(code) : piece.length;
    if (bytes > MAX_CURL_EXPAND_BYTES) return null;
    parts.push(piece);
  }
  if (!chargeCurlExpand(budget, bytes)) return null;
  return parts.join("");
}

function curlEscape(value, budget) {
  const inputBytes = Buffer.byteLength(value, "utf8");
  if (inputBytes > MAX_CURL_EXPAND_BYTES) return null;
  const input = Buffer.from(value, "utf8");
  let outLen = 0;
  for (let i = 0; i < input.length; i += 1) {
    outLen += curlUnreservedByte(input[i]) ? 1 : 3;
    if (outLen > MAX_CURL_EXPAND_BYTES) return null;
  }
  if (!chargeCurlExpand(budget, outLen)) return null;
  const out = Buffer.allocUnsafe(outLen);
  let at = 0;
  for (let i = 0; i < input.length; i += 1) {
    const byte = input[i];
    if (curlUnreservedByte(byte)) out[at++] = byte;
    else {
      const hex = byte.toString(16).toUpperCase().padStart(2, "0");
      out[at++] = 37;
      out[at++] = hex.charCodeAt(0);
      out[at++] = hex.charCodeAt(1);
    }
  }
  return out.toString("ascii");
}

function curlBase64Decode(value, budget) {
  if (value.length === 0) return { text: "" };
  const outLen = Math.floor(value.length / 4) * 3;
  if (outLen > MAX_CURL_EXPAND_BYTES) return { budget: true };
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return { text: "[64dec-fail]" };
  if (!chargeCurlExpand(budget, outLen)) return { budget: true };
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) return { text: "[64dec-fail]" };
  if (decoded.includes(0)) return { invalid: true };
  return { text: decoded.toString("utf8") };
}

function applyCurlFunctions(value, funcs, budget) {
  let rest = funcs;
  while (rest.startsWith(":")) {
    rest = rest.slice(1);
    const match = /^(trim|json|url|b64|64dec)(?=:|$)/.exec(rest);
    if (!match) return { ok: false };
    if (match[1] === "trim") {
      let start = 0;
      let end = value.length;
      const whitespace = "\t\n\v\f\r ";
      while (start < end && whitespace.includes(value[start])) start += 1;
      while (end > start && whitespace.includes(value[end - 1])) end -= 1;
      if (end - start > MAX_CURL_EXPAND_BYTES) return { budget: true };
      value = value.slice(start, end);
      if (Buffer.byteLength(value, "utf8") > MAX_CURL_EXPAND_BYTES) return { budget: true };
    } else if (match[1] === "json") {
      const escaped = curlJsonEscape(value, budget);
      if (escaped === null) return { budget: true };
      value = escaped;
    } else if (match[1] === "url") {
      const escaped = curlEscape(value, budget);
      if (escaped === null) return { budget: true };
      value = escaped;
    } else if (match[1] === "b64") {
      const bytes = Buffer.byteLength(value, "utf8");
      const outLen = 4 * Math.ceil(bytes / 3);
      if (outLen > MAX_CURL_EXPAND_BYTES || !chargeCurlExpand(budget, outLen)) return { budget: true };
      value = outLen === 0 ? "" : Buffer.from(value, "utf8").toString("base64");
    } else {
      const decoded = curlBase64Decode(value, budget);
      if (decoded.budget) return { budget: true };
      if (decoded.invalid) return { ok: false };
      value = decoded.text;
    }
    rest = rest.slice(match[1].length);
  }
  return rest.length === 0 ? { ok: true, text: value } : { ok: false };
}

function expandCurlTemplate(input, variables, budget) {
  const parts = [];
  let added = false;
  let bytes = 0;
  let over = false;
  const push = (text) => {
    if (over) return;
    const n = Buffer.byteLength(text, "utf8");
    if (n > MAX_CURL_EXPAND_BYTES || bytes > MAX_CURL_EXPAND_BYTES - n) {
      over = true;
      return;
    }
    bytes += n;
    parts.push(text);
  };
  let cursor = 0;
  while (cursor < input.length) {
    const at = input.indexOf("{{", cursor);
    if (at === -1) {
      push(input.slice(cursor));
      break;
    }
    if (at > cursor && input[at - 1] === "\\") {
      push(input.slice(cursor, at - 1));
      push("{{");
      cursor = at + 2;
      continue;
    }
    const close = input.indexOf("}}", at + 2);
    if (close === -1) {
      push(input.slice(cursor));
      break;
    }
    push(input.slice(cursor, at));
    const expr = input.slice(at + 2, close);
    const colon = expr.indexOf(":");
    const name = colon === -1 ? expr : expr.slice(0, colon);
    if (name.length === 0 || name.length >= 128 || !/^[A-Za-z0-9_]+$/.test(name)) {
      push(input.slice(at, close + 2));
      cursor = close + 2;
      continue;
    }
    const binding = variables.get(name);
    if (binding?.budget) return { budget: true };
    if (!binding?.dynamic && over) return { budget: true };
    let value = binding?.dynamic ? "" : (binding?.text ?? "");
    if (colon !== -1) {
      const applied = applyCurlFunctions(value, expr.slice(colon), budget);
      if (applied.budget) return { budget: true };
      if (!applied.ok) return { ok: false };
      value = applied.text;
    }
    if (binding?.dynamic) return { dynamic: true };
    push(value);
    added = true;
    if (over) return { budget: true };
    cursor = close + 2;
  }
  if (!added) return { ok: true, text: input };
  if (over || !chargeCurlExpand(budget, bytes)) return { budget: true };
  return { ok: true, text: parts.join("") };
}

function curlVariableName(input) {
  const body = input.startsWith("%") ? input.slice(1) : input;
  const name = /^[A-Za-z0-9_]*/.exec(body)?.[0] ?? "";
  if (name.length === 0 || name.length >= 128) return null;
  return name;
}

function assignCurlVariable(variables, input) {
  let line = input;
  const imported = line.startsWith("%");
  if (imported) line = line.slice(1);
  const name = curlVariableName(line);
  if (!name) return;
  line = line.slice(name.length);
  let start = 0;
  let end = Infinity;
  let ranged = false;
  if (line.startsWith("[") && /\d/.test(line[1] ?? "")) {
    const range = /^\[(\d+)-(\d*)\]/.exec(line);
    if (!range) return;
    start = Number(range[1]);
    end = range[2] === "" ? Infinity : Number(range[2]);
    if (!Number.isSafeInteger(start) || (range[2] !== "" && !Number.isSafeInteger(end)) || start > end) return;
    line = line.slice(range[0].length);
    ranged = true;
  }
  // Curl reads @ as a file or stdin. A % import uses the environment when set, then that file. The path is not content.
  if (line.startsWith("@")) {
    variables.set(name, { dynamic: true });
    return;
  }
  if (line[0] !== "=") {
    if (imported) variables.set(name, { dynamic: true });
    return;
  }
  let content = line.slice(1);
  if (ranged) {
    if (start >= content.length) content = "";
    else {
      const last = end === Infinity ? content.length - 1 : Math.min(end, content.length - 1);
      content = content.slice(start, last + 1);
    }
  }
  variables.set(name, { text: content });
}

function curlExpandedOption(arg, args, index, variables, budget) {
  const equal = arg.indexOf("=");
  let name = arg.slice(2, equal === -1 ? undefined : equal);
  const expand = name.startsWith("expand-");
  if (expand) name = name.slice("expand-".length);
  const takesValue = CURL_VALUE_OPTIONS.has(name);
  if (expand && !takesValue) return { index };
  let next = index;
  let operand;
  if (equal === -1) {
    if (takesValue) {
      next = index + 1;
      operand = args[next];
    }
  } else operand = arg.slice(equal + 1);
  if (!takesValue || operand === undefined) return { index: next };
  if (expand && name !== "url" && name !== "variable" && !CURL_CONNECTION_OPTIONS.has(name)) return { index: next };
  const expanded = expand ? expandCurlTemplate(operand, variables, budget) : { ok: true, text: operand };
  if (expanded.budget) {
    if (name === "variable") {
      const varName = curlVariableName(operand);
      if (varName) variables.set(varName, { budget: true });
    }
    return { index: next, budget: name === "url" };
  }
  if (!expanded.ok) return { index: next };
  if (name === "variable") {
    if (expanded.dynamic) {
      const dynamicName = curlVariableName(operand);
      if (dynamicName) variables.set(dynamicName, { dynamic: true });
    } else assignCurlVariable(variables, expanded.text);
    return { index: next };
  }
  if (name === "url" && !expanded.dynamic) return { index: next, url: expanded.text };
  if (!expanded.dynamic && CURL_CONNECTION_OPTIONS.has(name)) {
    return { index: next, endpoints: connectionEndpoints(CURL_CONNECTION_OPTIONS.get(name), expanded.text) };
  }
  return { index: next };
}
// Curl treats these as --proxy. http_proxy is lowercase only. HTTP_PROXY is not.
const PROXY_URL_NAMES = new Set([
  "http_proxy",
  "https_proxy", "HTTPS_PROXY",
  "ftp_proxy", "FTP_PROXY",
  "all_proxy", "ALL_PROXY",
]);

function proxyAssignmentValue(text) {
  const eq = text.indexOf("=");
  if (eq <= 0) return null;
  let name = text.slice(0, eq);
  if (name.endsWith("+")) name = name.slice(0, -1);
  if (!PROXY_URL_NAMES.has(name)) return null;
  return text.slice(eq + 1);
}

function proxyAssignmentName(text) {
  const eq = text.indexOf("=");
  if (eq <= 0) return null;
  let name = text.slice(0, eq);
  if (name.endsWith("+")) name = name.slice(0, -1);
  return PROXY_URL_NAMES.has(name) ? name : null;
}

// wgetrc command names ignore case, underscores, and hyphens. Curl environment names stay exact.
const WGETRC_PROXY_NAMES = new Set(["httpproxy", "httpsproxy", "ftpproxy"]);

function wgetrcProxyValue(text) {
  const eq = text.indexOf("=");
  if (eq < 0) return null;
  // wgetrc syntax is `name = value`. Spaces around `=` are not part of either side.
  const name = text.slice(0, eq).trim().toLowerCase().replace(/[_-]/g, "");
  if (!name || !WGETRC_PROXY_NAMES.has(name)) return null;
  return text.slice(eq + 1).trim();
}

function assignmentName(text) {
  const eq = text.indexOf("=");
  if (eq <= 0) return null;
  let name = text.slice(0, eq);
  if (name.endsWith("+")) name = name.slice(0, -1);
  const subscript = name.indexOf("[");
  if (subscript !== -1 && name.endsWith("]")) name = name.slice(0, subscript);
  if (!/^[A-Za-z_][\w]*$/.test(name)) return null;
  return name;
}

function assignmentFlags(word, assigned) {
  const rest = word.text.replace(/\$\(\(/g, "");
  const substitution = Boolean(word.substitution) || /\$\(/.test(rest);
  return {
    substitution,
    arithmetic: Boolean(word.unresolved) && (/\$\(\(/.test(word.text) || (!substitution && !/\$\(/.test(word.text))),
    parameter: (word.parameters ?? []).some((name) => assigned?.has(name)),
  };
}

function noteProxyAssignment(proxies, word, assigned) {
  if (!word?.text) return;
  if (assigned && word.assignable) {
    const name = assignmentName(word.text);
    if (name) assigned.add(name);
  }
  const value = proxyAssignmentValue(word.text);
  if (value == null) return;
  const flags = assignmentFlags(word, assigned);
  const eq = word.text.indexOf("=");
  const entry = {
    name: proxyAssignmentName(word.text),
    value,
    append: eq > 0 && word.text[eq - 1] === "+",
    arithmetic: flags.arithmetic,
    substitution: flags.substitution,
    parameter: flags.parameter,
  };
  proxies.push(entry);
}

const SHELL_CONTROL_PREFIXES = new Set(["if", "elif", "then", "else", "while", "until", "do", "!"]);

function shellCommandAfterControl(command) {
  let index = 0;
  while (command[index]?.plain) {
    const word = command[index].text;
    if (SHELL_CONTROL_PREFIXES.has(word)) index += 1;
    else if (word === "time") {
      index += 1;
      if (command[index]?.text === "-p") index += 1;
      if (command[index]?.text === "--") index += 1;
    } else break;
  }
  return index === 0 ? command : command.slice(index);
}

function transferClientName(program) {
  const slash = Math.max(program.lastIndexOf("/"), program.lastIndexOf("\\"));
  let base = slash < 0 ? program : program.slice(slash + 1);
  if (base.length > 4 && base.slice(-4).toLowerCase() === ".exe") base = base.slice(0, -4);
  const folded = base.toLowerCase();
  return ["curl", "wget", "ssh", "scp", "sftp"].includes(folded) ? folded : null;
}

function effectiveCurlStart(command, assigned, stop = (program) => Boolean(transferClientName(program))) {
  const proxies = [];
  const miss = () => ({ index: -1, proxies });
  let start = 0;
  let mode = "shell";
  while (/^[a-zA-Z_][\w]*\+?=/.test(command[start]?.text ?? "")) {
    noteProxyAssignment(proxies, command[start], assigned);
    start += 1;
  }
  while (start < command.length) {
    const program = command[start].text;
    const name = program.slice(program.lastIndexOf("/") + 1);
    if (stop(program, name)) {
      return { index: mode === "builtin" && transferClientName(program) ? -1 : start, proxies };
    }
    if (name === "sudo" || name === "sudoedit") {
      if (mode === "builtin") return miss();
      const from = start;
      const next = sudoCommandIndex(command, start);
      if (next === -1 || next.index <= start) return miss();
      for (let at = from + 1; at < next.index; at += 1) {
        if (sudoAssignment(command[at].text)) noteProxyAssignment(proxies, command[at], assigned);
      }
      start = next.index;
      mode = next.shell ? "shell" : "executable";
      continue;
    }
    if (!Object.hasOwn(COMMAND_LAUNCHERS, name)) return miss();
    const shellBuiltin = SHELL_COMMAND_LAUNCHERS.has(name);
    if ((shellBuiltin && (mode === "executable" || program !== name))
      || (!shellBuiltin && mode === "builtin")) return miss();
    const launcher = COMMAND_LAUNCHERS[name];
    start += 1;
    while (start < command.length) {
      const option = command[start].text;
      if (option === "--") { start += 1; break; }
      if (name === "env" && option === "-") { start += 1; break; }
      if (name === "nice" && /^-\d+$/.test(option)) { start += 1; continue; }
      if (!option.startsWith("-") || option === "-") break;
      start += 1;
      if (option.startsWith("--")) {
        const equal = option.indexOf("=");
        const flag = option.slice(2, equal === -1 ? undefined : equal);
        if (launcher.optionalValues?.includes(flag)) continue;
        if (launcher.longFlags.includes(flag) && equal === -1) continue;
        if (!launcher.longValues.includes(flag)) return miss();
        if (equal === -1) {
          if (start === command.length) return miss();
          start += 1;
        }
      } else {
        for (let at = 1; at < option.length; at += 1) {
          const flag = option[at];
          if (launcher.flags.includes(flag)) continue;
          if (!launcher.values.includes(flag)) return miss();
          if (at + 1 === option.length) {
            if (start === command.length) return miss();
            start += 1;
          }
          break;
        }
      }
    }
    if (name === "env") {
      while (/^[^=]*=/.test(command[start]?.text ?? "")) {
        noteProxyAssignment(proxies, command[start], assigned);
        start += 1;
      }
    } else if (name === "timeout") {
      if (!/^(?:\d+(?:\.\d*)?|\.\d+)[smhd]?$/.test(command[start]?.text ?? "")) return miss();
      start += 1;
    }
    mode = launcher.mode;
  }
  return miss();
}

const CURL_CONNECTION_OPTIONS = new Map([
  ["proxy", "endpoint"],
  ["preproxy", "endpoint"],
  ["connect-to", "connect-to"],
  ["resolve", "resolve"],
  ["socks4", "endpoint"],
  ["socks4a", "endpoint"],
  ["socks5", "endpoint"],
  ["socks5-hostname", "endpoint"],
]);
const WGET_URL_OPTIONS = new Set(["base"]);
const WGET_VALUE_OPTIONS = new Set("execute output-file append-output report-speed input-file input-metalink metalink-index config rejected-log tries retry-on-http-error output-document start-pos progress timeout dns-timeout connect-timeout read-timeout wait waitretry quota bind-address bind-dns-address dns-servers limit-rate restrict-file-names prefer-family user password use-askpass local-encoding remote-encoding directory-prefix cut-dirs http-user http-password default-page header compression max-redirect proxy-user proxy-password referer user-agent load-cookies save-cookies post-data post-file method body-data body-file secure-protocol certificate certificate-type private-key private-key-type ca-certificate ca-directory crl-file pinnedpubkey random-file egd-file ciphers hsts-file warc-file warc-header warc-max-size warc-dedup warc-tempdir ftp-user ftp-password level accept reject accept-regex reject-regex regex-type domains exclude-domains follow-tags ignore-tags include-directories exclude-directories".split(" "));
const WGET_FLAG_OPTIONS = new Set("adjust-extension ask-password auth-no-challenge background backup-converted backups cache check-certificate clobber content-disposition content-on-error continue convert-file-only convert-links cookies debug delete-after directories dns-cache follow-ftp force-directories force-html ftps-clear-data-connection ftps-fallback-to-ftp ftps-implicit ftps-resume-ssl glob help host-directories hsts http-keep-alive https-only if-modified-since ignore-case ignore-length inet4-only inet6-only iri keep-session-cookies mirror netrc no-adjust-extension no-ask-password no-auth-no-challenge no-background no-backup-converted no-backups no-cache no-check-certificate no-clobber no-config no-content-disposition no-content-on-error no-continue no-convert-file-only no-convert-links no-cookies no-debug no-delete-after no-directories no-dns-cache no-follow-ftp no-force-directories no-force-html no-ftps-clear-data-connection no-ftps-fallback-to-ftp no-ftps-implicit no-ftps-resume-ssl no-glob no-host-directories no-hsts no-http-keep-alive no-https-only no-if-modified-since no-ignore-case no-ignore-length no-inet4-only no-inet6-only no-iri no-keep-session-cookies no-mirror no-netrc no-page-requisites no-parent no-passive-ftp no-preserve-permissions no-protocol-directories no-proxy no-quiet no-random-wait no-recursive no-relative no-remove-listing no-retr-symlinks no-retry-connrefused no-retry-on-host-error no-save-headers no-server-response no-show-progress no-span-hosts no-spider no-strict-comments no-timestamping no-trust-server-names no-unlink no-use-server-timestamps no-verbose no-warc-cdx no-warc-compression no-warc-digests no-warc-keep-log no-xattr page-requisites parent passive-ftp preserve-permissions protocol-directories proxy quiet random-wait recursive relative remove-listing retr-symlinks retry-connrefused retry-on-host-error save-headers server-response show-progress span-hosts spider strict-comments timestamping trust-server-names unlink use-server-timestamps verbose version warc-cdx warc-compression warc-digests warc-keep-log xattr".split(" "));
const WGET_LONG_NAMES = [...WGET_FLAG_OPTIONS, ...WGET_URL_OPTIONS, ...WGET_VALUE_OPTIONS];

function resolveWgetLongOption(name) {
  // Exact flags win over prefix matching, so --hsts does not consume a word as --hsts-file.
  if (WGET_FLAG_OPTIONS.has(name)) return null;
  if (WGET_URL_OPTIONS.has(name) || WGET_VALUE_OPTIONS.has(name)) return name;
  let match = null;
  for (const option of WGET_LONG_NAMES) {
    if (!option.startsWith(name)) continue;
    if (match) return null;
    match = option;
  }
  if (match === null || WGET_FLAG_OPTIONS.has(match)) return null;
  return match;
}

const WGET_SHORT_VALUE = new Map([
  ["e", "value"], ["o", "value"], ["a", "value"], ["i", "value"], ["B", "url"],
  ["t", "value"], ["O", "value"], ["T", "value"], ["w", "value"], ["Q", "value"],
  ["P", "value"], ["U", "value"], ["l", "value"], ["A", "value"], ["R", "value"],
  ["D", "value"], ["I", "value"], ["X", "value"],
]);

function httpHostTarget(value) {
  if (!/^[a-z][\w+.-]*:\/\//i.test(value)) return value;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return value;
  }
  if (/^(?:0x[\da-f]+|\d+)$/i.test(parsed.hostname)) return `http://${parsed.hostname}`;
  return value;
}

function splitColons(value) {
  const fields = [];
  let current = "";
  let depth = 0;
  for (const ch of value) {
    if (ch === "[") depth += 1;
    else if (ch === "]" && depth > 0) depth -= 1;
    else if (ch === ":" && depth === 0) {
      fields.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  fields.push(current);
  return fields;
}

function connectionEndpoints(kind, value) {
  if (!value) return [];
  if (kind === "endpoint") return [httpHostTarget(value)];
  if (kind === "connect-to") {
    const fields = splitColons(value);
    if (fields.length !== 4) return [];
    return fields[2] ? [httpHostTarget(fields[2])] : [];
  }
  if (kind !== "resolve") return [];
  let text = value.startsWith("+") ? value.slice(1) : value;
  let hostEnd;
  if (text.startsWith("[")) {
    const close = text.indexOf("]");
    if (close < 0 || text[close + 1] !== ":") return [];
    hostEnd = close + 1;
  } else {
    hostEnd = text.indexOf(":");
    if (hostEnd < 0) return [];
  }
  const portEnd = text.indexOf(":", hostEnd + 1);
  if (portEnd < 0) return [];
  const addresses = [];
  let current = "";
  let depth = 0;
  for (const ch of text.slice(portEnd + 1)) {
    if (ch === "[") depth += 1;
    else if (ch === "]" && depth > 0) depth -= 1;
    else if (ch === "," && depth === 0) {
      if (current) addresses.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) addresses.push(current);
  return addresses.map(httpHostTarget);
}

function collectWgetUrls(args, urls) {
  let stdinList = false;
  let processList = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") {
      for (const url of args.slice(i + 1)) urls.push(url);
      return stdinList;
    }
    if (arg.startsWith("--")) {
      const equal = arg.indexOf("=");
      const rawName = arg.slice(2, equal === -1 ? undefined : equal);
      const resolved = resolveWgetLongOption(rawName);
      const name = resolved === null ? rawName : (resolved ?? rawName);
      const takes = resolved !== null && (WGET_URL_OPTIONS.has(name) || WGET_VALUE_OPTIONS.has(name));
      let operand;
      if (equal !== -1) operand = arg.slice(equal + 1);
      else if (takes) operand = args[++i];
      if (WGET_URL_OPTIONS.has(name) && operand !== undefined) urls.push(operand);
      // wget -e/--execute takes one wgetrc command. The command is not run.
      if (name === "execute" && operand) {
        const proxy = wgetrcProxyValue(operand);
        if (proxy) urls.push(proxy);
      }
      if (name === "input-file" && operand === "-") stdinList = true;
      if (name === "input-file" && operand?.startsWith("<(")) processList = true;
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") {
      for (let at = 1; at < arg.length; at += 1) {
        const spec = WGET_SHORT_VALUE.get(arg[at]);
        if (!spec) continue;
        const inline = arg.slice(at + 1);
        const operand = inline === "" ? args[++i] : inline;
        if (spec === "url" && operand !== undefined) urls.push(operand);
        if (arg[at] === "e" && operand) {
          const proxy = wgetrcProxyValue(operand);
          if (proxy) urls.push(proxy);
        }
        if (arg[at] === "i" && operand === "-") stdinList = true;
        if (arg[at] === "i" && operand?.startsWith("<(")) processList = true;
        break;
      }
      continue;
    }
    urls.push(arg);
  }
  return { stdin: stdinList, process: processList };
}

function unresolvedOperand(arg, operand) {
  if (!operand) return false;
  if (arg === operand) return true;
  const equal = arg.indexOf("=");
  if (arg.startsWith("--") && equal !== -1 && arg.slice(equal + 1) === operand) return true;
  if (arg.startsWith("-") && !arg.startsWith("--") && arg.slice(2) === operand) return true;
  return (operand.includes("$") || operand.includes("`")) && arg.includes(operand);
}

const STATIC_SHELLS = new Set(["ash", "bash", "dash", "ksh", "sh"]);
const SHELL_LONG_FLAGS = new Set([
  "debug", "debugger", "dump-po-strings", "dump-strings", "help", "login",
  "noediting", "noprofile", "norc", "posix", "protected", "restricted", "verbose", "version",
]);
const SHELL_LONG_VALUES = new Set(["init-file", "rcfile"]);

function commandProgramIndex(command) {
  let start = 0;
  while (/^[a-zA-Z_][\w]*\+?=/.test(command[start]?.text ?? "")) start += 1;
  return start;
}

function shellCommandLater(command, index) {
  return command.slice(index).some((word) => word.text === "-c" || /^-[^-]*c/.test(word.text));
}

function wordBoundary(ch) {
  return ch === undefined || /[\s;|&<>()]/.test(ch);
}

function simpleParameter(value, index, parameter) {
  if (!parameter?.name) return false;
  const raw = value.slice(index, parameter.end);
  return raw === "$" + parameter.name || raw === "${" + parameter.name + "}";
}

function staticBindingText(binding) {
  if (binding.substitution) return { reject: true, substitution: true };
  if (binding.arithmetic) return { reject: true, unresolved: true, substitution: false };
  if (binding.parameter) return { reject: true, parameter: true, substitution: false };
  if (/['"`$\\\n]/.test(binding.value ?? "")) return { reject: true, parameter: true, substitution: false };
  return { text: binding.value };
}

function sameBinding(left, right) {
  return left.value === right.value
    && left.arithmetic === right.arithmetic
    && left.substitution === right.substitution
    && left.parameter === right.parameter
    && left.exported === right.exported;
}

// A whole-word parameter is replaced with its static text. A parameter inside a word stays in place.
function expandSameShellWords(value, shellVars) {
  let out = "";
  let quote = null;
  let unresolvedParameter = false;
  for (let index = 0; index < value.length; index += 1) {
    const ch = value[index];
    if (quote !== "'" && ch === "$" && value[index + 1] === "(" && value[index + 2] === "(") {
      const expansion = readStaticArithmetic(value, index, quote);
      out += value.slice(index, expansion.end);
      index = expansion.end - 1;
      continue;
    }
    if (quote !== "'" && ch === "$" && value[index + 1] === "(") {
      const substitution = readCommandSubstitution(value, index);
      out += value.slice(index, substitution.end);
      index = substitution.end - 1;
      continue;
    }
    if (quote !== "'" && ch === "`") {
      const substitution = readBacktickSubstitution(value, index);
      out += value.slice(index, substitution.end);
      index = substitution.end - 1;
      continue;
    }
    if (quote !== "'" && ch === "$") {
      const parameter = readParameterExpansion(value, index);
      if (parameter?.name && shellVars.has(parameter.name)) {
        const whole = quote !== '"'
          && simpleParameter(value, index, parameter)
          && wordBoundary(value[index - 1])
          && wordBoundary(value[parameter.end]);
        if (whole) {
          const replacement = staticBindingText(shellVars.get(parameter.name));
          if (replacement.reject) return replacement;
          out += replacement.text;
          index = parameter.end - 1;
          continue;
        }
        unresolvedParameter = true;
      }
    }
    if (ch === "\\" && quote !== "'") {
      out += ch;
      if (value[index + 1] !== undefined) out += value[++index];
      continue;
    }
    if (ch === quote) quote = null;
    else if (quote === null && (ch === "'" || ch === '"')) quote = ch;
    out += ch;
  }
  if (out.length > MAX_CURL_EXPAND_TOTAL) return { reject: true };
  return { text: out, parameter: unresolvedParameter };
}

// Arguments after a shell -c string are $0, $1, ... They are substituted before the inner scan.
function expandPositionalParameters(text, positionals) {
  const values = positionals.map((word) => {
    if (word.substitution) return { reject: "substitution" };
    if (word.unresolved) return { reject: "unresolved" };
    if (word.dynamicFallback || word.indirect || (word.parameters ?? []).length) return { reject: "parameter" };
    if (/['"`$\\\n\s;&|<>(){}]/.test(word.text)) return { reject: "parameter" };
    return { text: word.text };
  });
  let out = "";
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (quote !== "'" && ch === "\\" && text[index + 1] !== undefined) {
      out += ch + text[index + 1];
      index += 1;
      continue;
    }
    if (ch === quote) {
      quote = null;
      out += ch;
      continue;
    }
    if (quote === null && (ch === "'" || ch === '"')) {
      quote = ch;
      out += ch;
      continue;
    }
    if (quote !== "'" && ch === "$") {
      const parameter = readParameterExpansion(text, index);
      if (parameter?.name && /^(?:0|[1-9][0-9]*)$/.test(parameter.name)) {
        const binding = values[Number(parameter.name)];
        if (!binding) {
          out += text.slice(index, parameter.end);
        } else if (binding.reject) {
          return { reject: true, [binding.reject]: true };
        } else out += binding.text;
        index = parameter.end - 1;
        continue;
      }
    }
    out += ch;
  }
  if (out.length > MAX_CURL_EXPAND_TOTAL) return { reject: true, parameter: true };
  return { text: out };
}

// eval joins its arguments and parses them in this shell. The text is not executed.
function staticEvalOperand(command) {
  const args = command.slice(1);
  if (args.length === 0) return null;
  let text = "";
  let substitution = false;
  let unresolved = false;
  for (const word of args) {
    if (word.substitution) substitution = true;
    else if (word.unresolved) unresolved = true;
    if (word.substitution || word.unresolved) continue;
    if (text) text += " ";
    text += word.text;
    if (text.length > MAX_CURL_EXPAND_TOTAL) return { reject: true };
  }
  if (substitution) return { reject: true, substitution: true };
  if (unresolved) return { reject: true, unresolved: true, substitution: false };
  return { text, word: args[0], sameShell: true };
}

// The -c operand is the next argument. It is parsed again and not executed.
function staticShellOperand(command) {
  const program = command[0]?.text ?? "";
  const name = program.slice(program.lastIndexOf("/") + 1);
  if (name === "eval") return staticEvalOperand(command);
  if (!STATIC_SHELLS.has(name)) return null;
  let index = 1;
  while (index < command.length) {
    const word = command[index];
    const option = word.text;
    if (option === "--" || option === "-" || !option.startsWith("-")) return null;
    if (option.startsWith("--")) {
      const equal = option.indexOf("=");
      const flag = option.slice(2, equal === -1 ? undefined : equal);
      index += 1;
      if (SHELL_LONG_VALUES.has(flag)) {
        if (equal === -1) index += 1;
        continue;
      }
      if (!SHELL_LONG_FLAGS.has(flag)) return shellCommandLater(command, index) ? { reject: true } : null;
      continue;
    }
    let skipIncrement = false;
    for (let at = 1; at < option.length; at += 1) {
      const flag = option[at];
      if (flag === "c") {
        const inline = option.slice(at + 1);
        const script = inline !== "" ? word : command[index + 1];
        if (!script) return null;
        const text = inline !== "" ? inline : script.text;
        if (text.length > MAX_CURL_EXPAND_TOTAL) return { reject: true };
        const after = inline !== "" ? index + 1 : index + 2;
        return { text, word: script, positionals: command.slice(after) };
      }
      if (flag === "o" || flag === "O") {
        index += option.slice(at + 1) === "" ? 2 : 1;
        skipIncrement = true;
        break;
      }
    }
    if (!skipIncrement) index += 1;
  }
  return null;
}

// Export is a mark on one binding. A later assignment updates that same value.
function staticAppend(prior, record) {
  if (!record.append || !prior) {
    return {
      value: record.value,
      arithmetic: record.arithmetic,
      substitution: record.substitution,
      parameter: record.parameter,
    };
  }
  const arithmetic = prior.arithmetic || record.arithmetic;
  const substitution = prior.substitution || record.substitution;
  const parameter = prior.parameter || record.parameter;
  if (arithmetic || substitution || parameter) return { value: prior.value, arithmetic, substitution, parameter };
  return { value: prior.value + record.value, arithmetic: false, substitution: false, parameter: false };
}

function rememberAssignment(word, shellVars, assigned, markExported = false) {
  if (!word?.text) return;
  const name = assignmentName(word.text);
  if (!name) return;
  if (assigned) assigned.add(name);
  const eq = word.text.indexOf("=");
  const flags = assignmentFlags(word, assigned);
  const prior = shellVars.get(name);
  const combined = staticAppend(prior, {
    value: word.text.slice(eq + 1),
    append: word.text[eq - 1] === "+",
    arithmetic: flags.arithmetic,
    substitution: flags.substitution,
    parameter: flags.parameter,
  });
  shellVars.set(name, {
    ...combined,
    exported: markExported || prior?.exported || false,
  });
}

function rememberStandalone(command, shellVars, assigned) {
  if (command.length === 0) return false;
  if (!command.every((word) => assignmentName(word?.text ?? ""))) return false;
  for (const word of command) rememberAssignment(word, shellVars, assigned, Boolean(shellVars.allexport));
  return true;
}

// set -a and set -o allexport export later assignments in this shell. +a and +o clear that state.
function noteSetAllexport(command) {
  const start = commandProgramIndex(command);
  if (command[start]?.text !== "set") return null;
  let allexport = null;
  for (let index = start + 1; index < command.length; index += 1) {
    const text = command[index].text;
    if (text === "--") break;
    if ((text === "-o" || text === "+o") && command[index + 1]?.text === "allexport") {
      allexport = text === "-o";
      index += 1;
      continue;
    }
    if (/^\+[A-Za-z]+$/.test(text) && text.includes("a")) allexport = false;
    else if (/^-[A-Za-z]+$/.test(text) && text.includes("a")) allexport = true;
  }
  return { allexport };
}

function fallbackTarget(text) {
  if (!text || /\s/.test(text)) return null;
  return /^(?:[a-z][\w+.-]*:|\/\/)/i.test(text) ? text : `http://${text}`;
}

function applyReplacements(text, replacements) {
  if (!replacements?.length) return null;
  let out = "";
  let at = 0;
  for (const replacement of replacements) {
    out += text.slice(at, replacement.from) + replacement.fallback;
    at = replacement.from + replacement.length;
  }
  return out + text.slice(at);
}

function noteShellExport(command, assigned, shellVars) {
  const start = commandProgramIndex(command);
  const program = command[start]?.text;
  // declare -x and typeset -x set the same export mark. +x does not clear it.
  const builtin = ["declare", "typeset", "readonly", "local"].includes(program);
  if (program !== "export" && !builtin) return false;
  let namesAt = start + 1;
  let exporting = !builtin;
  if (builtin) {
    for (let index = start + 1; index < command.length; index += 1) {
      const option = command[index].text;
      if (option === "--") {
        namesAt = index + 1;
        break;
      }
      if (!/^[-+][A-Za-z]+$/.test(option)) break;
      namesAt = index + 1;
      if (option.startsWith("-") && /[pfF]/.test(option)) return true;
      if (option.startsWith("-") && option.includes("x")) exporting = true;
    }
  }
  for (const word of command.slice(0, start)) {
    if (assigned && word.assignable) {
      const name = assignmentName(word.text);
      if (name) assigned.add(name);
    }
  }
  for (let index = namesAt; index < command.length; index += 1) {
    const word = command[index];
    const text = word.text;
    if (text === "--") continue;
    if (text.startsWith("-") && text !== "-" && !text.includes("=")) continue;
    if (text.includes("=")) {
      rememberAssignment(word, shellVars, assigned, exporting);
      continue;
    }
    if (/^[A-Za-z_][\w]*$/.test(text)) {
      const binding = shellVars.get(text);
      if (binding && exporting) binding.exported = true;
      if (assigned) assigned.add(text);
    }
  }
  return true;
}

function proxyBinding(name, fields) {
  return {
    name,
    value: fields.value,
    arithmetic: fields.arithmetic,
    substitution: fields.substitution,
    parameter: fields.parameter,
    exported: true,
  };
}

function commandProxies(shellVars, prefixes) {
  const active = new Map();
  for (const [name, binding] of shellVars) {
    if (!binding.exported || !PROXY_URL_NAMES.has(name)) continue;
    active.set(name, proxyBinding(name, binding));
  }
  for (const proxy of prefixes) {
    const prior = active.get(proxy.name) ?? shellVars.get(proxy.name);
    active.set(proxy.name, proxyBinding(proxy.name, staticAppend(prior, proxy)));
  }
  return active;
}

function programBaseName(program) {
  const slash = Math.max(program.lastIndexOf("/"), program.lastIndexOf("\\"));
  let base = slash < 0 ? program : program.slice(slash + 1);
  if (base.length > 4 && base.slice(-4).toLowerCase() === ".exe") base = base.slice(0, -4);
  return base.toLowerCase();
}

function quoteScanWord(text) {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text;
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function resolveIndirectWords(command, shellVars) {
  let unresolvedParameter = false;
  for (const word of command) {
    if (!word?.indirect) continue;
    if (word.text !== `\${\!${word.indirect}}`) {
      unresolvedParameter = true;
      continue;
    }
    const pointer = shellVars.get(word.indirect);
    const targetName = pointer && !pointer.substitution && !pointer.arithmetic && !pointer.parameter ? pointer.value : "";
    const target = /^[A-Za-z_][\w]*$/.test(targetName) ? shellVars.get(targetName) : null;
    if (!target || target.substitution || target.arithmetic || target.parameter || /['"`$\\\n\s]/.test(target.value ?? "")) {
      unresolvedParameter = true;
      continue;
    }
    word.text = target.value;
    word.braceText = target.value;
    word.unresolved = false;
    word.parameters = [];
    word.indirect = null;
  }
  return unresolvedParameter;
}

function envSplitOperand(command) {
  let index = 0;
  while (/^[a-zA-Z_][\w]*\+?=/.test(command[index]?.text ?? "")) index += 1;
  if (programBaseName(command[index]?.text ?? "") !== "env") return null;
  index += 1;
  const launcher = COMMAND_LAUNCHERS.env;
  let split = null;
  while (index < command.length && !split) {
    const word = command[index];
    const option = word?.text ?? "";
    if (option === "--" || option === "-" || !option.startsWith("-")) return null;
    if (option === "-S" || option === "--split-string") {
      const source = command[index + 1];
      if (!source) return { reject: true };
      split = { text: source.text, word: source, after: index + 2 };
      break;
    }
    if (option.startsWith("--split-string=")) {
      split = { text: option.slice("--split-string=".length), word, after: index + 1 };
      break;
    }
    if (option.startsWith("-S") && !option.startsWith("--")) {
      split = { text: option.slice(2), word, after: index + 1 };
      break;
    }
    index += 1;
    if (option.startsWith("--")) {
      const equal = option.indexOf("=");
      const flag = option.slice(2, equal === -1 ? undefined : equal);
      if (launcher.optionalValues.includes(flag)) continue;
      if (launcher.longFlags.includes(flag) && equal === -1) continue;
      if (!launcher.longValues.includes(flag)) return null;
      if (equal === -1) {
        if (index >= command.length) return null;
        index += 1;
      }
      continue;
    }
    let known = true;
    for (let at = 1; at < option.length; at += 1) {
      const flag = option[at];
      if (launcher.flags.includes(flag)) continue;
      if (!launcher.values.includes(flag)) {
        known = false;
        break;
      }
      if (at + 1 === option.length) {
        if (index >= command.length) return null;
        index += 1;
      }
      break;
    }
    if (!known) return null;
  }
  if (!split) return null;
  if (split.word.unresolved || split.word.substitution || split.word.dynamicFallback) return { reject: true };
  if (/[$`]/.test(split.text) || split.text.length > MAX_CURL_EXPAND_TOTAL) return { reject: true };
  const rest = command.slice(split.after);
  if (rest.some((word) => word.unresolved || word.substitution || word.dynamicFallback || word.indirect)) return { reject: true };
  const trailing = rest.map((word) => quoteScanWord(word.text)).join(" ");
  const text = trailing ? `${split.text} ${trailing}` : split.text;
  if (text.length > MAX_CURL_EXPAND_TOTAL) return { reject: true };
  return { text };
}

const XARGS_FLAGS = new Set("0rtxpo");
const XARGS_VALUES = new Set("adEILnPs");
const XARGS_OPTIONAL = new Set("eil");
const XARGS_LONG_FLAGS = new Set(["null", "no-run-if-empty", "verbose", "exit", "interactive", "open-tty", "show-limits", "help", "version"]);
const XARGS_LONG_VALUES = new Set(["arg-file", "delimiter", "eof", "replace", "max-lines", "max-args", "max-procs", "max-chars", "process-slot-var"]);

function xargsCommand(command) {
  let index = 0;
  while (/^[a-zA-Z_][\w]*\+?=/.test(command[index]?.text ?? "")) index += 1;
  if (programBaseName(command[index]?.text ?? "") !== "xargs") return null;
  index += 1;
  let replacing = false;
  while (index < command.length) {
    const option = command[index]?.text ?? "";
    if (option === "--") {
      index += 1;
      break;
    }
    if (!option.startsWith("-") || option === "-") break;
    if (option.startsWith("--")) {
      const equal = option.indexOf("=");
      const flag = option.slice(2, equal === -1 ? undefined : equal);
      if (flag === "replace") replacing = true;
      if (XARGS_LONG_FLAGS.has(flag) && equal === -1) {
        index += 1;
        continue;
      }
      if (flag === "eof" && equal === -1) {
        index += 1;
        continue;
      }
      if (!XARGS_LONG_VALUES.has(flag)) return { reject: true };
      if (equal === -1) {
        if (!command[index + 1]) return { reject: true };
        index += 2;
      } else index += 1;
      continue;
    }
    let consumedNext = false;
    for (let at = 1; at < option.length; at += 1) {
      const flag = option[at];
      if (flag === "I" || flag === "i") replacing = true;
      if (XARGS_FLAGS.has(flag)) continue;
      if (XARGS_OPTIONAL.has(flag)) break;
      if (!XARGS_VALUES.has(flag)) return { reject: true };
      if (at + 1 < option.length) break;
      consumedNext = true;
      break;
    }
    if (consumedNext && !command[index + 1]) return { reject: true };
    index += consumedNext ? 2 : 1;
  }
  if (replacing) return { reject: true };
  const words = command.slice(index);
  if (words.length === 0) return null;
  const commandName = words[0].text.slice(Math.max(words[0].text.lastIndexOf("/"), words[0].text.lastIndexOf("\\")) + 1);
  if (!transferClientName(words[0].text) && !STATIC_SHELLS.has(commandName)) return null;
  if (words.some((word) => word.unresolved || word.substitution || word.dynamicFallback || word.indirect)) return { reject: true };
  const text = words.map((word) => quoteScanWord(word.text)).join(" ");
  if (text.length > MAX_CURL_EXPAND_TOTAL) return { reject: true };
  return { text };
}

const SSH_FLAGS = new Set("46AaCfGgKkMNnqsTtVvXxYy");
const SSH_VALUES = new Set("BbcDEeFIiJLlmOoPpQRSWw");

function sshHostToken(token) {
  const sshUrl = /^ssh:\/\/(?:[^@/?#]+@)?([^/:?#]+)/i.exec(token);
  if (sshUrl) return sshUrl[1];
  if (/^[a-z][\w+.-]*:/i.test(token)) return null;
  const at = token.lastIndexOf("@");
  const hostport = at === -1 ? token : token.slice(at + 1);
  if (!hostport || hostport.startsWith("-")) return null;
  return hostport.startsWith("[") ? hostport : hostport.replace(/:\d+$/, "");
}

function sshConfigScalar(value) {
  const scalar = /^(?:"([^"]*)"|([^\s"#]+))(?:\s*(?:#.*)?)?$/.exec(value.trim());
  return scalar ? scalar[1] ?? scalar[2] : null;
}

function sshForwardHost(value, stdio = false) {
  const fields = [];
  let bracket = false;
  let from = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "[") {
      if (bracket) return null;
      bracket = true;
    } else if (value[index] === "]") {
      if (!bracket) return null;
      bracket = false;
    } else if (value[index] === ":" && !bracket) {
      fields.push(value.slice(from, index));
      if (fields.length > 3) return null;
      from = index + 1;
    }
  }
  if (bracket) return null;
  fields.push(value.slice(from));
  if (stdio) {
    if (fields.length === 1 && fields[0].includes("/")) return "";
    return fields.length === 2 && /^\d+$/.test(fields[1]) ? fields[0] : null;
  }
  if (fields.length <= 2 && /^\d+$/.test(fields.at(-1))) return "";
  if (fields.at(-1)?.includes("/")) return "";
  return fields.length >= 3 && fields.length <= 4 && /^\d+$/.test(fields.at(-1))
    ? fields.at(-2) : null;
}

function sshDestinations(args) {
  const hosts = [];
  const commands = [];
  const localCommands = [];
  let permitLocalCommand = null;
  let sshUnresolved = false;
  const hostValue = (value) => {
    if (!value || /[%$`\s]/.test(value) || hosts.length >= MAX_STATIC_CURL_TARGETS) {
      sshUnresolved = true;
      return;
    }
    hosts.push(value);
  };
  const jumpHosts = (value) => {
    if (value.trim().toLowerCase() === "none") return true;
    const hops = value.split(",");
    if (hosts.length + hops.length > MAX_STATIC_CURL_TARGETS) return false;
    for (const hop of hops) {
      const host = sshHostToken(hop.trim());
      if (!host) return false;
      hostValue(host);
    }
    return true;
  };
  const finish = (arg, remote = []) => {
    const host = arg ? sshHostToken(arg) : null;
    if (host) hostValue(host);
    if (remote.length) commands.push(remote.join(" "));
    return {
      hosts,
      commands: permitLocalCommand === false ? commands : [...commands, ...localCommands],
      sshUnresolved,
      reject: !host,
    };
  };
  const forward = (value, stdio = false) => {
    const host = sshForwardHost(value, stdio);
    if (host === null) sshUnresolved = true;
    else if (host) hostValue(host);
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") return finish(args[index + 1], args.slice(index + 2));
    if (arg.startsWith("-") && arg !== "-") {
      if (arg.startsWith("--")) return { hosts, commands, sshUnresolved, reject: true };
      const cluster = arg.slice(1);
      for (let at = 0; at < cluster.length; at += 1) {
        const flag = cluster[at];
        if (SSH_FLAGS.has(flag)) continue;
        if (!SSH_VALUES.has(flag)) return { hosts, commands, sshUnresolved, reject: true };
        const value = at + 1 < cluster.length ? cluster.slice(at + 1) : args[++index];
        if (value === undefined) return { hosts, commands, sshUnresolved, reject: true };
        if (flag === "J" && !jumpHosts(value)) return { hosts, commands, sshUnresolved, reject: true };
        if (flag === "W" || flag === "L" || flag === "R") forward(value, flag === "W");
        if (flag === "F" && value !== "none") sshUnresolved = true;
        if (flag === "o") {
          const option = /^([a-z][\w]*)(?:\s*=\s*|\s+)(.*)$/is.exec(value.trim());
          if (option) {
            const key = option[1].toLowerCase();
            const scalar = sshConfigScalar(option[2]);
            if (key === "hostname" || key === "proxyjump") {
              if (scalar === null) sshUnresolved = true;
              else if (key === "hostname") hostValue(scalar);
              else if (!jumpHosts(scalar)) sshUnresolved = true;
            } else if (["proxycommand", "localcommand", "knownhostscommand", "remotecommand"].includes(key)) {
              if (option[2].trim().toLowerCase() !== "none") {
                if (commands.length + localCommands.length >= MAX_STATIC_CURL_TARGETS) sshUnresolved = true;
                else (key === "localcommand" ? localCommands : commands).push(option[2]);
              }
            } else if (key === "permitlocalcommand" && permitLocalCommand === null) {
              if (scalar?.toLowerCase() === "no") permitLocalCommand = false;
              else if (scalar?.toLowerCase() === "yes") permitLocalCommand = true;
              else sshUnresolved = true;
            } else if (key === "localforward" || key === "remoteforward") {
              const fields = shellWords(option[2]);
              if (fields.length !== 2) sshUnresolved = true;
              else forward(fields[1], true);
            } else if (key === "include" || key === "match" || key === "canonicaldomains"
              || (key === "canonicalizepermittedcnames" && scalar?.toLowerCase() !== "none")
              || (key === "canonicalizehostname" && scalar?.toLowerCase() !== "no")) {
              sshUnresolved = true;
            }
          }
        }
        break;
      }
      continue;
    }
    return finish(arg, args.slice(index + 1));
  }
  return { hosts, commands, sshUnresolved };
}

function sshTransferDestinations(client, args) {
  const options = [];
  const hosts = [];
  let sshUnresolved = false;
  let operands = false;
  const flags = client === "scp" ? "346ABCOpqRrsTv" : "46AaCfpqrNv";
  const values = client === "scp" ? "cDFiJlopPSX" : "bBcDFiJloPRsSX";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (hosts.length + options.length > MAX_STATIC_CURL_TARGETS) { sshUnresolved = true; break; }
    if (!operands && arg === "--") { operands = true; continue; }
    if (!operands && arg.startsWith("-") && arg !== "-") {
      for (let at = 1; at < arg.length; at += 1) {
        const flag = arg[at];
        if (flags.includes(flag)) continue;
        if (!values.includes(flag)) { sshUnresolved = true; break; }
        const value = at + 1 < arg.length ? arg.slice(at + 1) : args[++index];
        if (value === undefined) { sshUnresolved = true; break; }
        if (["J", "o", "F"].includes(flag)) options.push(`-${flag}`, value);
        if (["S", "D"].includes(flag) || (client === "sftp" && ["b", "s"].includes(flag))) sshUnresolved = true;
        break;
      }
      continue;
    }
    if (client === "sftp") {
      if (/^sftp:\/\//i.test(arg)) {
        try { hosts.push(new URL(arg).hostname); } catch { sshUnresolved = true; }
      } else {
        const remote = /^(?:[^@]+@)?(\[[^\]]+\]|[^:]+)(?::.*)?$/.exec(arg);
        const host = remote && sshHostToken(remote[1]);
        if (host) hosts.push(host); else sshUnresolved = true;
      }
    } else {
      if (/^scp:\/\//i.test(arg)) {
        try { hosts.push(new URL(arg).hostname); } catch { sshUnresolved = true; }
      } else {
        const colon = arg.indexOf(":");
        // A slash before the colon makes an scp operand a local file.
        if (colon !== -1 && !arg.slice(0, colon).includes("/")) {
          const remote = /^(?:[^@]+@)?(\[[^\]]+\]|[^:]+):/.exec(arg);
          const host = remote && sshHostToken(remote[1]);
          if (host) hosts.push(host); else sshUnresolved = true;
        }
      }
    }
  }
  const checked = sshDestinations([...options, "example.test"]);
  return { hosts: [...hosts, ...checked.hosts], commands: checked.commands,
    sshUnresolved: sshUnresolved || checked.sshUnresolved || checked.reject };
}

function staticSshClientOptions(client, args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") break;
    if (arg.startsWith("--")) {
      const equal = arg.indexOf("=");
      const raw = arg.slice(2, equal === -1 ? undefined : equal);
      const name = client === "wget" ? resolveWgetLongOption(raw) ?? raw : raw;
      if (client === "curl" && raw && "config".startsWith(raw)) return false;
      if (client === "wget" && ["config", "input-file", "input-metalink", "execute"].includes(name)) return false;
      const values = client === "curl" ? CURL_VALUE_OPTIONS : WGET_VALUE_OPTIONS;
      if (equal === -1 && (values.has(name) || (client === "wget" && WGET_URL_OPTIONS.has(name)))) index += 1;
    } else if (arg.startsWith("-") && arg !== "-") {
      for (let at = 1; at < arg.length; at += 1) {
        const flag = arg[at];
        if (client === "curl" ? flag === "K" : flag === "i" || flag === "e") return false;
        const takes = client === "curl" ? CURL_SHORT_VALUE_OPTIONS.has(flag) : WGET_SHORT_VALUE.has(flag);
        if (!takes) continue;
        if (at + 1 === arg.length) index += 1;
        break;
      }
    }
  }
  return true;
}

const SSH_INERT_COMMANDS = new Set(["cat", "echo", "printf", "true", "false", ":"]);

function staticSshCommand(text, depth = 0) {
  if (depth > 8) return false;
  let command = [];
  const checked = () => {
    command = shellCommandAfterControl(command);
    if (command.length === 0) return true;
    if (command.some((word) => word.unresolved || word.substitution || word.parameters.length > 0
      || word.text.includes("%"))) return false;
    if (command.length === 1 && command[0].plain && ["fi", "done", "esac"].includes(command[0].text)) return true;
    const split = envSplitOperand(command) ?? xargsCommand(command);
    if (split) return !split.reject && staticSshCommand(split.text, depth + 1);
    const opened = effectiveCurlStart(command, new Set(), (program, name) => (
      Boolean(transferClientName(program)) || STATIC_SHELLS.has(name) || name === "eval" || SSH_INERT_COMMANDS.has(name)
    ));
    if (opened.index === -1) return command.length === 1 && command[0].assignable;
    const program = command[opened.index].text;
    const name = program.slice(program.lastIndexOf("/") + 1);
    if (STATIC_SHELLS.has(name) || name === "eval") {
      for (const word of command.slice(opened.index + 1)) {
        if (word.text.startsWith("--rcfile") || word.text.startsWith("--init-file")) return false;
        if (!word.text.startsWith("-") || word.text.startsWith("--")) continue;
        for (const flag of word.text.slice(1)) {
          if (flag === "c") break;
          if (flag === "i" || flag === "l") return false;
        }
      }
      const shell = staticShellOperand(command.slice(opened.index));
      return Boolean(shell) && !shell.reject && staticSshCommand(shell.text, depth + 1);
    }
    const client = transferClientName(program);
    return client !== "curl" && client !== "wget"
      ? true : staticSshClientOptions(client, command.slice(opened.index + 1).map((word) => word.text));
  };
  for (const token of shellWords(text, { commandTokens: true })) {
    if (token === null || token.fence) {
      if (!checked()) return false;
      command = [];
    } else command.push(token);
  }
  return checked();
}

function copyExported(source) {
  const copy = new Map();
  for (const [name, binding] of source) {
    if (binding.exported) copy.set(name, { ...binding });
  }
  return copy;
}

function curlCommandTargets(value, assigned = new Set(), inherited = new Map(), depth = 0, state = null) {
  if (depth > 8) {
    return { targets: [], overflow: false, budget: false, unresolved: false, substitution: true, parameter: false, stdinConfig: false, wgetStdin: false, processSource: false, sshUnresolved: false };
  }
  const targets = [];
  const takeInner = (inner) => {
    targets.push(...inner.targets);
    overflow ||= inner.overflow;
    budget ||= inner.budget;
    unresolved ||= inner.unresolved;
    substitution ||= inner.substitution;
    parameter ||= inner.parameter;
    stdinConfig ||= inner.stdinConfig;
    wgetStdin ||= inner.wgetStdin;
    processSource ||= inner.processSource;
    sshUnresolved ||= inner.sshUnresolved;
  };
  let overflow = false;
  let budget = false;
  let unresolved = false;
  let substitution = false;
  let parameter = false;
  let stdinConfig = false;
  let wgetStdin = false;
  let processSource = false;
  let sshUnresolved = false;
  const shellVars = state ?? copyExported(inherited);
  const bodies = [];
  const markUnresolved = (item) => {
    if ((item.parameters ?? []).some((name) => assigned.has(name))) parameter = true;
    if (!item.unresolved && !item.substitution) return;
    const text = item.text;
    const rest = text.replace(/\$\(\(/g, "");
    const commandSubstitution = Boolean(item.substitution) || /\$\(/.test(rest);
    if (/\$\(\(/.test(text) || (!commandSubstitution && !/\$\(/.test(text))) unresolved = true;
    if (commandSubstitution) substitution = true;
  };
  let command = [];
  const flush = () => {
    command = shellCommandAfterControl(command);
    if (noteShellExport(command, assigned, shellVars)) {
      command = [];
      return;
    }
    if (rememberStandalone(command, shellVars, assigned)) {
      command = [];
      return;
    }
    const setOption = noteSetAllexport(command);
    if (setOption) {
      if (setOption.allexport != null) shellVars.allexport = setOption.allexport;
      command = [];
      return;
    }
    if (resolveIndirectWords(command, shellVars)) parameter = true;
    const split = envSplitOperand(command);
    if (split) {
      if (split.reject) parameter = true;
      else takeInner(curlCommandTargets(split.text, new Set(assigned), copyExported(shellVars), depth + 1));
      command = [];
      return;
    }
    const launched = xargsCommand(command);
    if (launched) {
      if (launched.reject) parameter = true;
      else takeInner(curlCommandTargets(launched.text, new Set(assigned), copyExported(shellVars), depth + 1));
      command = [];
      return;
    }
    const opened = effectiveCurlStart(command, assigned, (program, name) => (
      Boolean(transferClientName(program)) || STATIC_SHELLS.has(name) || name === "eval"
    ));
    const programAt = opened.index === -1 ? commandProgramIndex(command) : opened.index;
    const shell = staticShellOperand(command.slice(programAt));
    if (shell) {
      const shellName = command[programAt]?.text.split("/").at(-1);
      if (!shell.sameShell && shellName === "bash") {
        let startup = shellVars.get("BASH_ENV");
        for (let index = 0; index < programAt; index += 1) {
          const word = command[index];
          if (word.text.startsWith("BASH_ENV=")) startup = { value: word.text.slice(9), exported: true };
          if (word.text.split("/").at(-1) !== "env") continue;
          for (index += 1; index < programAt; index += 1) {
            const option = command[index].text;
            if (option === "--") break;
            if (option === "-" || option === "-i" || option === "--ignore-environment") startup = null;
            else if (option === "-u" || option === "--unset") {
              if (command[++index]?.text === "BASH_ENV") startup = null;
            } else if (option === "--unset=BASH_ENV") startup = null;
            else if (["--chdir", "--argv0"].includes(option)) index += 1;
            else if (option.startsWith("-") && !option.startsWith("--")) {
              for (let at = 1; at < option.length; at += 1) {
                const flag = option[at];
                if (flag === "i") startup = null;
                else if ("uCa".includes(flag)) {
                  const operand = option.slice(at + 1) || command[++index]?.text;
                  if (flag === "u" && operand === "BASH_ENV") startup = null;
                  break;
                }
              }
            } else if (!option.startsWith("-")) { index -= 1; break; }
          }
        }
        if (startup?.exported && (startup.value || startup.substitution || startup.parameter || startup.arithmetic)) processSource = true;
      }
      const prefixes = [];
      for (const word of command.slice(0, programAt)) noteProxyAssignment(prefixes, word, assigned);
      if (shell.sameShell) {
        const fork = new Map();
        fork.allexport = Boolean(shellVars.allexport);
        for (const [name, binding] of shellVars) fork.set(name, { ...binding });
        const applied = new Map();
        for (const proxy of prefixes) {
          const prior = fork.get(proxy.name);
          const combined = staticAppend(prior, proxy);
          const next = {
            value: combined.value,
            arithmetic: combined.arithmetic,
            substitution: combined.substitution,
            parameter: combined.parameter,
            exported: true,
          };
          applied.set(proxy.name, { ...next });
          fork.set(proxy.name, next);
        }
        const expanded = expandSameShellWords(shell.text, fork);
        let scanText = shell.text;
        if (expanded.reject) {
          if (expanded.unresolved) unresolved = true;
          if (expanded.parameter) parameter = true;
          if (expanded.substitution !== false) substitution = true;
        } else {
          scanText = expanded.text;
          if (expanded.parameter) parameter = true;
        }
        const inner = curlCommandTargets(scanText, assigned, fork, depth + 1, fork);
        for (const [name, binding] of fork) {
          const overlay = applied.get(name);
          if (overlay && sameBinding(binding, overlay)) continue;
          shellVars.set(name, { ...binding });
        }
        shellVars.allexport = Boolean(fork.allexport);
        targets.push(...inner.targets);
        overflow ||= inner.overflow;
        budget ||= inner.budget;
        unresolved ||= inner.unresolved;
        substitution ||= inner.substitution;
        parameter ||= inner.parameter;
        stdinConfig ||= inner.stdinConfig;
        wgetStdin ||= inner.wgetStdin;
        processSource ||= inner.processSource;
        sshUnresolved ||= inner.sshUnresolved;
        command = [];
        return;
      }
      const local = commandProxies(shellVars, prefixes);
      if (shell.reject) {
        if (shell.unresolved) unresolved = true;
        if (shell.substitution !== false) substitution = true;
      }
      else if (shell.word) {
        let scanText = shell.text;
        if (shell.positionals?.length) {
          const expanded = expandPositionalParameters(shell.text, shell.positionals);
          if (expanded.reject) {
            if (expanded.unresolved) unresolved = true;
            if (expanded.substitution) substitution = true;
            if (expanded.parameter || (!expanded.unresolved && !expanded.substitution)) parameter = true;
          } else scanText = expanded.text;
        }
        const inner = curlCommandTargets(scanText, new Set(assigned), local, depth + 1);
        targets.push(...inner.targets);
        overflow ||= inner.overflow;
        budget ||= inner.budget;
        unresolved ||= inner.unresolved;
        substitution ||= inner.substitution;
        parameter ||= inner.parameter;
        stdinConfig ||= inner.stdinConfig;
        wgetStdin ||= inner.wgetStdin;
        processSource ||= inner.processSource;
        sshUnresolved ||= inner.sshUnresolved;
      }
      command = [];
      return;
    }
    const located = effectiveCurlStart(command, assigned);
    if (located.index === -1) { command = []; return; }
    const start = located.index;
    for (const proxy of commandProxies(shellVars, located.proxies).values()) {
      if (proxy.arithmetic) unresolved = true;
      if (proxy.substitution) substitution = true;
      if (proxy.parameter) parameter = true;
      if (proxy.arithmetic || proxy.substitution || proxy.parameter || !proxy.value) continue;
      const target = /^(?:[a-z][\w+.-]*:|\/\/)/i.test(proxy.value) ? proxy.value : `http://${proxy.value}`;
      if (!/\s/.test(target)) targets.push(target);
    }
    let globoff = false;
    let options = true;
    let urls = [];
    const variables = new Map();
    const expandBudget = { used: 0 };
    const tagged = [];
    for (const word of command.slice(start + 1)) {
      if (word.unresolved) {
        tagged.push({
          text: word.text,
          unresolved: true,
          substitution: word.substitution,
          parameters: word.parameters,
          processSource: word.processSource,
        });
        continue;
      }
      const expanded = expandTargetGlobs(word.braceText, { shell: true });
      overflow ||= expanded.overflow;
      for (const text of expanded.values) {
        tagged.push({
          text: text.replace(/\\([\\{},.])/g, "$1"),
          unresolved: false,
          parameters: word.parameters,
          processSource: word.processSource,
        });
      }
    }
    const args = tagged.map((item) => item.text);
    const fromUnresolved = (operand) => {
      let found = false;
      for (const item of tagged) {
        const referencesAssigned = (item.parameters ?? []).some((name) => assigned.has(name));
        if (!(item.unresolved || referencesAssigned) || !unresolvedOperand(item.text, operand)) continue;
        found = true;
        markUnresolved(item);
      }
      return found;
    };
    const transfer = () => {
      for (const url of urls) {
        if (fromUnresolved(url)) continue;
        const expanded = globoff ? { values: [url], overflow: false } : expandTargetGlobs(url);
        overflow ||= expanded.overflow;
        for (const target of expanded.values) {
          if (/\s/.test(target)) continue;
          targets.push(/^(?:[a-z][\w+.-]*:|\/\/)/i.test(target) ? target : `http://${target}`);
        }
      }
      urls = [];
      globoff = false;
    };
    for (const word of command) {
      if (word.dynamicFallback) parameter = true;
      const replaced = applyReplacements(word.text, word.replacements);
      if (!replaced || replaced === word.text) continue;
      const proxy = proxyAssignmentValue(replaced);
      const target = fallbackTarget(proxy ?? replaced);
      if (target) targets.push(target);
    }
    const client = transferClientName(command[start].text);
    if (["ssh", "scp", "sftp"].includes(client)) {
      const destinations = client === "ssh" ? sshDestinations(args) : sshTransferDestinations(client, args);
      if (destinations.reject) parameter = true;
      sshUnresolved ||= destinations.sshUnresolved;
      urls.push(...destinations.hosts);
      for (const text of destinations.commands) {
        if (!staticSshCommand(text, depth + 1)) sshUnresolved = true;
        else takeInner(curlCommandTargets(text, new Set(assigned), copyExported(shellVars), depth + 1));
      }
      transfer();
      command = [];
      return;
    }
    if (client === "wget") {
      const inputSource = collectWgetUrls(args, urls);
      if (inputSource.stdin) wgetStdin = true;
      if (inputSource.process) processSource = true;
      transfer();
      command = [];
      return;
    }
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (!options) { urls.push(arg); continue; }
      if (arg === "--") { options = false; continue; }
      if (arg === "--next" || arg === "-:") { transfer(); continue; }
      if (arg === "--globoff") { globoff = true; continue; }
      if (arg === "--no-globoff") { globoff = false; continue; }
      if (arg.startsWith("--")) {
        const equal = arg.indexOf("=");
        const optionName = arg.slice(2, equal === -1 ? undefined : equal);
        // --config - can supply a transfer URL. A config path stays unread.
        if (optionName === "config") {
          const operand = equal === -1 ? args[i + 1] : arg.slice(equal + 1);
          if (operand === "-") stdinConfig = true;
          if (operand?.startsWith("<(")) processSource = true;
        }
        const parsed = curlExpandedOption(arg, args, i, variables, expandBudget);
        i = parsed.index;
        if (parsed.budget) budget = true;
        const referencesAssigned = (tagged[i]?.parameters ?? []).some((name) => assigned.has(name));
        if ((tagged[i]?.unresolved || referencesAssigned) && (parsed.url !== undefined || parsed.endpoints)) {
          markUnresolved(tagged[i]);
          continue;
        }
        if (parsed.url !== undefined) urls.push(parsed.url);
        if (parsed.endpoints) urls.push(...parsed.endpoints);
        continue;
      }
      if (arg.startsWith("-") && arg !== "-") {
        for (let at = 1; at < arg.length; at += 1) {
          if (arg[at] === "g") globoff = true;
          if (CURL_SHORT_VALUE_OPTIONS.has(arg[at])) {
            const inline = arg.slice(at + 1);
            const operand = inline === "" ? args[i + 1] : inline;
            if (inline === "") i += 1;
            if (arg[at] === "K" && operand === "-") stdinConfig = true;
            if (arg[at] === "K" && operand?.startsWith("<(")) processSource = true;
            if (arg[at] === "x" && operand !== undefined) {
              const referencesAssigned = (tagged[i]?.parameters ?? []).some((name) => assigned.has(name));
              if (tagged[i]?.unresolved || referencesAssigned) markUnresolved(tagged[i]);
              else urls.push(operand);
            }
            break;
          }
        }
        continue;
      }
      urls.push(arg);
    }
    transfer();
    command = [];
  };
  for (const token of shellWords(value, { commandTokens: true })) {
    if (token === null || token.fence) {
      flush();
      if (token !== null) shellVars.clear();
    } else {
      command.push(token);
      if (token.substitutionBodies.length > 0) {
        const seen = copyExported(shellVars);
        for (const text of token.substitutionBodies) bodies.push({ text, exported: seen });
      }
    }
  }
  flush();
  for (const body of bodies) {
    const inner = curlCommandTargets(body.text, assigned, body.exported, depth);
    targets.push(...inner.targets);
    overflow ||= inner.overflow;
    budget ||= inner.budget;
    unresolved ||= inner.unresolved;
    substitution ||= inner.substitution;
    parameter ||= inner.parameter;
    stdinConfig ||= inner.stdinConfig;
    wgetStdin ||= inner.wgetStdin;
    processSource ||= inner.processSource;
    sshUnresolved ||= inner.sshUnresolved;
  }
  return { targets, overflow, budget, unresolved, substitution, parameter, stdinConfig, wgetStdin, processSource, sshUnresolved };
}

function joinShellContinuations(value) {
  let quote = null;
  let joined = "";
  for (let index = 0; index < value.length; index += 1) {
    const ch = value[index];
    if (ch === "#" && quote === null && (index === 0 || /[\s;|&()]/.test(value[index - 1]))) {
      const end = value.indexOf("\n", index);
      if (end === -1) return joined + value.slice(index);
      joined += value.slice(index, end + 1);
      index = end;
      continue;
    }
    if (quote === null && ch === "$" && value[index + 1] === "'") {
      const fragment = ansiCFragment(value, index + 2);
      if (!fragment) return joined + value.slice(index);
      joined += value.slice(index, fragment.end + 1);
      index = fragment.end;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      const next = value[index + 1];
      if (next === "\n") { index += 1; continue; }
      if (next === "\r" && value[index + 2] === "\n") { index += 2; continue; }
      joined += ch;
      if (next !== undefined) joined += value[++index];
      continue;
    }
    if (ch === quote) quote = null;
    else if (quote === null && (ch === "'" || ch === '"')) quote = ch;
    joined += ch;
  }
  return joined;
}

/**
 * Verification content must never target Chad's LAN instances, whatever the
 * exemption. Mentions only in the Exemption reason or Exemption line are allowed;
 * reason lines must sit in its content column (lazy lines stay checked).
 */
function shellVisible(value) {
  let quote = null;
  let out = "";
  for (let index = 0; index < value.length; index += 1) {
    const ch = value[index];
    if (ch === "\\" && quote !== "'") {
      const next = value[index + 1];
      if (next === undefined) { out += ch; break; }
      if (quote === null || /[\\"$`]/.test(next)) { out += next; index += 1; continue; }
      out += ch;
      continue;
    }
    if (ch === quote) quote = null;
    else if (quote === null && (ch === "'" || ch === '"')) quote = ch;
    out += ch;
  }
  return out;
}

function targetsBannedLan(sectionText, definitions, literalText = []) {
  let budget = false;
  let unresolved = false;
  let substitution = false;
  let parameter = false;
  let stdinConfig = false;
  let wgetStdin = false;
  let processSource = false;
  let sshUnresolved = false;
  const verification = withoutFencePayload(withoutFields(sectionText, [FIELD_LABELS.reason], {
    keepLazy: true,
  }).replace(
    EXEMPTION_LINE,
    "",
  ));
  const bannedTarget = (value) => {
    if (BANNED_LAN_IP.test(value)) return true;
    const joined = joinShellContinuations(decodeCharacterReferences(decodeRawHtmlAttributes(value), { dropBreaks: true }));
    const words = shellWords(joined);
    const curl = curlCommandTargets(joined);
    if (curl.budget) budget = true;
    if (curl.unresolved) unresolved = true;
    if (curl.substitution) substitution = true;
    if (curl.parameter) parameter = true;
    if (curl.stdinConfig) stdinConfig = true;
    if (curl.wgetStdin) wgetStdin = true;
    if (curl.processSource) processSource = true;
    if (curl.sshUnresolved) sshUnresolved = true;
    if (curl.overflow) return true;
    const decoded = shellVisible(joined);
    const targets = [...decoded.matchAll(/(?:(?:https?|ftp|wss?):|\/\/)[^\s<>()"'`]+/gi)]
      .map((match) => trimToken(match[0]));
    targets.push(...curl.targets);
    targets.push(...words.filter((word) => /^(?:(?:https?|ftp|wss?):|\/\/)/i.test(word)).map(trimToken));
    for (const token of [...decoded.split(/[\s<>()"'`]+/), ...words]) {
      const target = trimToken(token);
      if (/[.:/?#]/.test(target)
        && /^(?:0x[\da-f]+|\d+)(?:\.(?:0x[\da-f]+|\d+)){0,3}(?::\d+)?(?:[/?#].*)?$/i.test(target)) {
        targets.push(`http://${target}`);
      }
    }
    return targets.some((target) => {
      try {
        let host = new URL(target, /^(?:https?|ftp|wss?):/i.test(target) ? undefined : "https://example.test/").hostname;
        const mapped = host.match(/^\[::ffff:([\da-f]{1,4}):([\da-f]{1,4})\]$/i);
        if (mapped) {
          const high = parseInt(mapped[1], 16);
          const low = parseInt(mapped[2], 16);
          host = `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
        }
        return BANNED_LAN_IP.test(host);
      }
      catch { return false; }
    });
  };
  const banned = bannedTarget(verification)
    || literalText.some(bannedTarget)
    // Malformed links render as raw text. Unlike artifact validation, the LAN
    // scan must retain their suffix so later reference uses cannot disappear.
    || (definitions.size > 0 && [...referenceUses(verification, { keepMalformed: true })].some((label) => bannedTarget(definitions.get(label) ?? "")));
  return { banned, budget, unresolved, substitution, parameter, stdinConfig, wgetStdin, processSource, sshUnresolved };
}

function documentReferences(body) {
  const definitions = new Map();
  const scan = openReferenceScan(stripHiddenMarkdown(body).split("\n"));
  for (let index = 0; index < scan.rawLines.length; index += 1) {
    const event = pullReference(scan, index);
    if (event.kind !== "definition") continue;
    const label = normalizeReferenceLabel(event.definition.label);
    if (!definitions.has(label)) definitions.set(label, event.definition.destination);
    index = event.definition.end;
  }
  return definitions;
}

/**
 * @param {string | null | undefined} body
 * @returns {{ ok: boolean, errors: string[], exemption: string | null, hasEvidence: boolean }}
 */
function exemptionDeclarationCount(section) {
  const fields = parseFields(section);
  let count = 0;
  let offset = 0;
  for (const line of section.split("\n")) {
    const start = offset;
    offset += line.length + 1;
    if (!EXEMPTION_START.test(line)) continue;
    if (fields.some((field) => start >= field.start && start < field.end)) continue;
    count += 1;
  }
  return count;
}

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

  const definitions = documentReferences(body);
  const { raw, value, unknown } = parseExemption(section);
  const reason = extractExemptionReason(section);
  const hasEvidence = hasEvidenceContent(section, definitions);

  if (evidenceHeadingSpans(referenceHeadingView(inlineCodeMetadataView(stripHiddenMarkdown(structuralMetadataView(body))))).length > 1) {
    errors.push("PR body must contain exactly one visible Evidence section.");
  }

  // Preserve the selected section boundaries even for the conservative LAN view.
  // Also scan the visible section so commented decoy headings cannot redirect it.
  const literalText = [];
  let previousLiteralLine = -2;
  const conservativeSection = extractEvidenceSection(body, {
    inlineMultiline: false,
    includeRawHtml: true,
    onLiteralLine: (lineIndex, raw) => {
      if (lineIndex === previousLiteralLine + 1) literalText[literalText.length - 1] += "\n" + raw;
      else literalText.push(raw);
      previousLiteralLine = lineIndex;
    },
  }) ?? section;
  const directLan = targetsBannedLan(section, definitions);
  const conservativeLan = targetsBannedLan(conservativeSection, definitions, literalText);
  if (directLan.banned || conservativeLan.banned) {
    errors.push(
      "Evidence must not target Chad's LAN instances (.80/.81). Use a disposable local verify instance instead. (To mention these hosts in the Exemption reason, indent every reason line under its bullet.)",
    );
  }
  if (directLan.budget || conservativeLan.budget) {
    errors.push(
      "Evidence curl expansion exceeded the static verifier budget before the URL target could be checked. Shorten repeated functions, templates, or assignments.",
    );
  }
  if (directLan.unresolved || conservativeLan.unresolved) {
    errors.push(
      "Evidence contains a curl or wget target with shell arithmetic this static check could not resolve. Rewrite that operand without arithmetic expansion.",
    );
  }
  if (directLan.substitution || conservativeLan.substitution) {
    errors.push(
      "Evidence contains a curl or wget target with a command substitution this static check could not resolve. Rewrite that operand without command substitution.",
    );
  }
  if (directLan.sshUnresolved || conservativeLan.sshUnresolved) {
    errors.push(
      "Evidence contains SSH connection options this static check could not resolve. Use literal endpoints and supported static commands without external configuration.",
    );
  }
  if (directLan.parameter || conservativeLan.parameter) {
    errors.push(
      "Evidence contains a curl or wget target with a shell variable this static check could not resolve. Rewrite that operand without variable expansion.",
    );
  }
  if (directLan.stdinConfig || conservativeLan.stdinConfig) {
    errors.push(
      "Evidence contains a curl --config or -K stdin source this static check does not read. Put the transfer URL on the curl command line.",
    );
  }
  if (directLan.wgetStdin || conservativeLan.wgetStdin) {
    errors.push(
      "Evidence contains a wget -i or --input-file stdin source this static check does not read. Put the transfer URL on the wget command line.",
    );
  }
  if (directLan.processSource || conservativeLan.processSource) {
    errors.push(
      "Evidence contains a curl --config or wget --input-file process substitution this static check does not read. Put the transfer URL on the command line.",
    );
  }

  if (exemptionDeclarationCount(section) !== 1) {
    errors.push("Evidence must contain exactly one Exemption declaration.");
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
    if (isPlaceholderField(reason)) {
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
