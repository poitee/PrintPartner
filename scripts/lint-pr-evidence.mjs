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

/** Chad's LAN instances (.80/.81) must never be targeted by automated verification. */
const BANNED_LAN_IP = /\b192\.168(?:\.\d+){1,2}\.(?:80|81)\b/;

function stripHtmlComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, "");
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
  const match = body.match(/^##\s+Evidence\s*$/im);
  if (!match || match.index == null) return null;
  const start = match.index + match[0].length;
  const rest = body.slice(start);
  const nextHeading = rest.search(/^##\s+/m);
  const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  return section;
}

function parseExemption(sectionText) {
  const cleaned = stripHtmlComments(sectionText);
  const match = cleaned.match(/^[ \t]*Exemption[ \t]*:[ \t]*(.+?)[ \t]*$/im);
  if (!match) return { raw: null, value: null };
  const raw = match[1].trim();
  if (!raw || PLACEHOLDER_EXEMPTION.test(raw)) {
    return { raw, value: null };
  }
  const lower = raw.toLowerCase();
  if (lower === EXEMPTION_NONE) return { raw, value: EXEMPTION_NONE };
  // Accept the longer phrasing from the docs.
  if (
    lower === "internal refactor with no user-visible change" ||
    lower.startsWith("internal refactor")
  ) {
    return { raw, value: "internal refactor" };
  }
  if (VALID_EXEMPTIONS.includes(lower)) return { raw, value: lower };
  return { raw, value: null, unknown: true };
}

function extractExemptionReason(sectionText) {
  const cleaned = stripHtmlComments(sectionText);
  // Keep colon spacing on the same line so the next bullet is not treated as the reason.
  const labeled = cleaned.match(
    /^[ \t]*[-*][ \t]*Exemption reason(?:[ \t]*\([^)]*\))?[ \t]*:[ \t]*(.*)$/im,
  );
  if (labeled) {
    const sameLine = labeled[1].trim();
    if (sameLine) return sameLine;
    // Collect following non-empty lines until the next field-style bullet.
    const after = cleaned.slice(labeled.index + labeled[0].length);
    const lines = [];
    for (const line of after.split("\n")) {
      if (/^[ \t]*[-*][ \t]+\S[^:]*:[ \t]*/.test(line)) break;
      if (/^[ \t]*Exemption[ \t]*:/i.test(line)) break;
      if (/^[ \t]*##[ \t]+/.test(line)) break;
      const trimmed = line.trim();
      if (!trimmed) {
        if (lines.length) break;
        continue;
      }
      lines.push(trimmed);
    }
    return lines.join(" ").trim();
  }
  return "";
}

const EMPTY_FIELD =
  /^\s*[-*]\s+(?:Journey exercised|Steps followed to produce the evidence|Result observed|Screenshot\s*\/\s*recording\s*\/\s*verify-skill output or trace|Exemption reason(?:\s*\([^)]*\))?)\s*:\s*$/i;

function hasEvidenceContent(sectionText) {
  const cleaned = stripHtmlComments(sectionText)
    .replace(/^\s*Exemption\s*:.*$/gim, "")
    .replace(
      /^\s*[-*]\s*Exemption reason(?:\s*\([^)]*\))?\s*:.*$/gim,
      "",
    );

  const meaningful = cleaned
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !EMPTY_FIELD.test(line))
    .filter((line) => !/^[-*]\s*$/.test(line));

  if (meaningful.length === 0) return false;

  // A filled field value, markdown media/link, or freeform paragraph counts.
  for (const line of meaningful) {
    if (/!\[[^\]]*]\([^)]+\)/.test(line)) return true;
    if (/\[[^\]]+]\(https?:\/\/[^)]+\)/.test(line)) return true;
    if (/https?:\/\/\S+/.test(line)) return true;
    if (/`[^`]+`/.test(line)) return true;
    if (/^\s*[-*]\s+[^:]+:\s+\S+/.test(line)) return true;
    if (!/^\s*[-*]\s+/.test(line) && line.length >= 8) return true;
  }
  return meaningful.some((line) => line.replace(/^[-*]\s*/, "").length >= 12);
}

function mentionsBannedLan(text) {
  return BANNED_LAN_IP.test(text);
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

  if (mentionsBannedLan(body)) {
    errors.push(
      "Evidence must not target Chad's LAN instances (.80/.81). Use a disposable local verify instance instead.",
    );
  }

  const { raw, value, unknown } = parseExemption(section);
  const reason = extractExemptionReason(section);
  const hasEvidence = hasEvidenceContent(section);

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
        "Evidence block is empty. Attach/link verify output, tests, or screenshots/recording, or claim a named Exemption with a reason.",
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
