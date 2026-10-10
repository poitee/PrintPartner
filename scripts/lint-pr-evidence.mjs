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

/**
 * Read a template field value (same line and optional following freeform lines).
 */
function readField(sectionText, label) {
  const cleaned = stripHtmlComments(sectionText);
  const labelRe = fieldLabelPattern(label);
  const labeled = cleaned.match(
    new RegExp(`^[ \\t]*[-*][ \\t]*${labelRe}[ \\t]*:[ \\t]*(.*)$`, "im"),
  );
  if (!labeled) return "";
  const sameLine = labeled[1].trim();
  const lines = sameLine ? [sameLine] : [];
  const after = cleaned.slice(labeled.index + labeled[0].length);
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

function extractExemptionReason(sectionText) {
  return readField(sectionText, FIELD_LABELS.reason);
}

function looksLikeArtifact(value) {
  if (!value) return false;
  if (/!\[[^\]]*]\([^)]+\)/.test(value)) return true;
  if (/\[[^\]]+]\([^)]+\)/.test(value)) return true;
  if (/https?:\/\/\S+/i.test(value)) return true;
  if (/`[^`]+`/.test(value)) return true;
  // Paths / filenames commonly used for verify traces and screenshots.
  if (/\.(?:png|jpe?g|gif|webp|mp4|webm|mov|json|txt|log|md)\b/i.test(value)) {
    return true;
  }
  if (/(?:screenshot|recording|trace|verify[- ]skill|evidence)\b/i.test(value)) {
    return value.length >= 8;
  }
  return false;
}

/**
 * Evidence requires steps, observed result, and an artifact (not journey alone,
 * and not exemption-reason text).
 */
export function hasEvidenceContent(sectionText) {
  const steps = readField(sectionText, FIELD_LABELS.steps);
  const result = readField(sectionText, FIELD_LABELS.result);
  const artifact = readField(sectionText, FIELD_LABELS.artifact);

  if (!steps || !result || !looksLikeArtifact(artifact)) {
    // Also accept a markdown image / evidence URL elsewhere in the section
    // (outside Exemption / reason / journey-only stubs), but still require
    // steps + result so a journey name alone cannot pass.
    const cleaned = stripHtmlComments(sectionText)
      .replace(/^[ \t]*Exemption[ \t]*:.*$/gim, "")
      .replace(
        new RegExp(
          `^[ \\t]*[-*][ \\t]*${fieldLabelPattern(FIELD_LABELS.reason)}[ \\t]*:[ \\t]*.*$`,
          "gim",
        ),
        "",
      );

    // Drop multiline exemption-reason paragraphs that follow an empty reason label.
    // readField already consumed them when present; strip residual freeform that
    // sits only under the reason bullet by removing reason field text explicitly.
    const reason = extractExemptionReason(sectionText);
    let withoutReason = cleaned;
    if (reason) {
      withoutReason = withoutReason.split(reason).join("");
    }

    const freeformArtifact =
      /!\[[^\]]*]\([^)]+\)/.test(withoutReason) ||
      /\[[^\]]+]\(https?:\/\/[^)]+\)/.test(withoutReason) ||
      /https?:\/\/\S+/i.test(withoutReason) ||
      /\.(?:png|jpe?g|gif|webp|mp4|webm|mov)\b/i.test(withoutReason);

    return Boolean(steps && result && (looksLikeArtifact(artifact) || freeformArtifact));
  }

  return true;
}

/**
 * Fail only when verification evidence targets banned LAN hosts.
 * Docs/CI exemptions may mention those hosts without using them as targets.
 */
function targetsBannedLan(sectionText, exemptionValue) {
  if (exemptionValue && exemptionValue !== EXEMPTION_NONE) {
    return false;
  }
  const verificationText = [
    readField(sectionText, FIELD_LABELS.journey),
    readField(sectionText, FIELD_LABELS.steps),
    readField(sectionText, FIELD_LABELS.result),
    readField(sectionText, FIELD_LABELS.artifact),
  ].join("\n");
  return BANNED_LAN_IP.test(verificationText);
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

  if (targetsBannedLan(section, value)) {
    errors.push(
      "Evidence must not target Chad's LAN instances (.80/.81). Use a disposable local verify instance instead.",
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
