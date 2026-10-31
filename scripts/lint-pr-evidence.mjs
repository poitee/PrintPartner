#!/usr/bin/env node
/**
 * Fail when Evidence is empty, or when a UI/desktop change has no screenshot or
 * video in Evidence, unless an Exemption reason is provided.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function withoutComments(body) {
  return body.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
}

// Ignore unfilled template prompts, with optional Markdown list formatting.
function isPlaceholder(line) {
  const text = line.trim().replace(/^[-*+]\s+/, "");
  return !text || /^<[^>]*>$/.test(text)
    || /^(?:TODO|TBD|FIXME|placeholder)\b/i.test(text);
}

const VISUAL_PATHS = /^(?:web\/apps\/web\/(?:src|public)\/|web\/apps\/web\/index\.html$|rust\/crates\/pp-desktop\/)/;
const NON_VISUAL = /(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|\.md$/;

export function needsVisualEvidence(changedFiles = []) {
  return changedFiles.some((file) => VISUAL_PATHS.test(file) && !NON_VISUAL.test(file));
}

const MEDIA = [
  /!\[[^\]]*\]\(\s*<?https:\/\/[^)\s]+/,
  /<(?:img|video)\b[^>]*\bsrc\s*=\s*["']?https:\/\//i,
  /https:\/\/github\.com\/user-attachments\/assets\/[0-9a-f-]{36}/i,
  /https:\/\/\S+\.(?:png|jpe?g|gif|webp|mp4|mov|webm)(?:\?[^\s)]*)?(?=[\s)>"']|$)/i,
];

export function lintPrEvidence(body, { changedFiles = [] } = {}) {
  const lines = withoutComments(body ?? "").replace(/\r\n/g, "\n").split("\n");
  let inEvidence = false;
  let fence = null;
  let hasEvidence = false;
  let hasMedia = false;
  let exemption = null;

  for (const line of lines) {
    // Fenced output counts as Evidence, but cannot introduce headings or metadata.
    const marker = line.match(/^[ ]{0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence[0]
          && marker[1].length >= fence.length && !marker[2].trim()) {
        fence = null;
      } else if (inEvidence && !isPlaceholder(line)) {
        hasEvidence = true;
      }
      continue;
    }
    if (marker) {
      fence = marker[1];
      continue;
    }
    if (/^[ ]{0,3}#{1,2}(?:[ \t]+|$)/.test(line)) {
      inEvidence = /^[ ]{0,3}##[ \t]+Evidence[ \t]*(?:#+[ \t]*)?$/i.test(line);
      continue;
    }
    const field = line.match(/^[ \t]*Exemption[ \t]*:[ \t]*(.*)$/i);
    if (field) {
      const reason = field[1].trim();
      if (!isPlaceholder(reason) && !/^none$/i.test(reason)) exemption = reason;
      continue;
    }
    if (!inEvidence) continue;
    // Checked before placeholders: a bare <img ...> line looks like a <prompt>.
    // Fenced media links do not render, so only unfenced lines count.
    if (MEDIA.some((pattern) => pattern.test(line))) hasEvidence = hasMedia = true;
    else if (!isPlaceholder(line)) hasEvidence = true;
  }

  const visual = needsVisualEvidence(changedFiles);
  const errors = [];
  if (exemption === null) {
    if (!hasEvidence) errors.push("Evidence is empty or missing and no Exemption reason was given.");
    else if (visual && !hasMedia) {
      errors.push("This PR changes UI or desktop files. Add a screenshot or video under Evidence, or give an Exemption reason.");
    }
  }
  return { ok: errors.length === 0, errors, exemption, hasEvidence, hasMedia, visual };
}

function parseArgs(argv) {
  const args = { bodyFile: null, stdin: false, help: false, changedFiles: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--stdin") args.stdin = true;
    else if (arg === "--body-file") {
      const next = argv[++i];
      if (!next) throw new Error("--body-file requires a path");
      args.bodyFile = next;
    } else if (arg === "--changed-files") {
      const next = argv[++i];
      if (!next) throw new Error("--changed-files requires a path");
      args.changedFiles = next;
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
  node scripts/lint-pr-evidence.mjs --stdin < body.md

Changed files (one path per line) come from --changed-files or the file named
by CHANGED_FILES_PATH. UI and desktop changes then need a screenshot or video.`);
    return 0;
  }
  const body = readBody(args);
  const listPath = args.changedFiles ?? process.env.CHANGED_FILES_PATH;
  const changedFiles = listPath ? readFileSync(listPath, "utf8").split("\n").filter(Boolean) : [];
  const result = lintPrEvidence(body, { changedFiles });
  if (result.ok) {
    io.log(
      `PR evidence lint OK (exemption=${result.exemption ?? "n/a"}, hasEvidence=${result.hasEvidence}, visual=${result.visual}, hasMedia=${result.hasMedia})`,
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
