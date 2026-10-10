import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  extractEvidenceSection,
  lintPrEvidence,
  main,
  VALID_EXEMPTIONS,
} from "./lint-pr-evidence.mjs";

function bodyWithEvidence(evidenceInner) {
  return `## Summary

Something changed.

## Evidence

${evidenceInner}

## Test plan

- [x] ran script tests
`;
}

const EMPTY_TEMPLATE_EVIDENCE = `<!-- REQUIRED: see docs/contributing/gate-evidence.md -->

Exemption: <none|docs-only|CI-only|dependency-only|internal refactor>

- Exemption reason (required when claiming an exemption):

- Journey exercised:
- Steps followed to produce the evidence:
- Result observed:
- Screenshot / recording / verify-skill output or trace:
`;

test("VALID_EXEMPTIONS lists the four named exemptions", () => {
  assert.deepEqual([...VALID_EXEMPTIONS].sort(), [
    "ci-only",
    "dependency-only",
    "docs-only",
    "internal refactor",
  ]);
});

test("extractEvidenceSection returns null when heading is missing", () => {
  assert.equal(extractEvidenceSection("## Summary\n\nok\n"), null);
});

test("fails when Evidence block is empty and Exemption is still the placeholder", () => {
  const result = lintPrEvidence(bodyWithEvidence(EMPTY_TEMPLATE_EVIDENCE));
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /placeholder|empty/i);
});

test("fails when Evidence is empty even with Exemption: none", () => {
  const result = lintPrEvidence(
    bodyWithEvidence(`Exemption: none

- Exemption reason (required when claiming an exemption):

- Journey exercised:
- Steps followed to produce the evidence:
- Result observed:
- Screenshot / recording / verify-skill output or trace:
`),
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /Evidence block is empty/i);
});

test("passes with Exemption: none and filled evidence fields", () => {
  const result = lintPrEvidence(
    bodyWithEvidence(`Exemption: none

- Journey exercised: Library → Builds
- Steps followed to produce the evidence: opened disposable local instance, clicked Builds
- Result observed: Builds table rendered without overlap
- Screenshot / recording / verify-skill output or trace: https://example.test/evidence.png
`),
  );
  assert.equal(result.ok, true, result.errors.join("; "));
  assert.equal(result.exemption, "none");
  assert.equal(result.hasEvidence, true);
});

test("passes docs-only exemption when a reason is given", () => {
  const result = lintPrEvidence(
    bodyWithEvidence(`Exemption: docs-only

- Exemption reason (required when claiming an exemption): Markdown-only contributing docs; no user-visible app change.
`),
  );
  assert.equal(result.ok, true, result.errors.join("; "));
  assert.equal(result.exemption, "docs-only");
});

test("passes CI-only exemption with a reason (case-insensitive)", () => {
  const result = lintPrEvidence(
    bodyWithEvidence(`Exemption: CI-only

- Exemption reason: Adds a GitHub Actions workflow that lints PR bodies; no product UI change.
`),
  );
  assert.equal(result.ok, true, result.errors.join("; "));
  assert.equal(result.exemption, "ci-only");
});

test("fails named exemption without a reason", () => {
  const result = lintPrEvidence(
    bodyWithEvidence(`Exemption: docs-only

- Exemption reason (required when claiming an exemption):

- Journey exercised:
`),
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /requires a non-empty Exemption reason/i);
});

test("fails when Evidence section is missing entirely", () => {
  const result = lintPrEvidence("## Summary\n\nNo evidence heading here.\n");
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /Missing "## Evidence"/);
});

test("fails empty PR body", () => {
  const result = lintPrEvidence("   \n");
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /empty/i);
});

test("fails unknown exemption values", () => {
  const result = lintPrEvidence(
    bodyWithEvidence(`Exemption: weekend-hack

- Exemption reason: because
`),
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /Unknown Exemption/i);
});

test("fails when evidence targets Chad's LAN .80/.81 hosts", () => {
  const result = lintPrEvidence(
    bodyWithEvidence(`Exemption: none

- Journey exercised: verify against live printer
- Steps followed to produce the evidence: hit http://192.168.200.80:8080/
- Result observed: ok
- Screenshot / recording / verify-skill output or trace: trace.json
`),
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /\.80\/\.81/);
});

test("CLI --body-file exits 0 for a valid exempt body", () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-evidence-"));
  const file = join(dir, "body.md");
  writeFileSync(
    file,
    bodyWithEvidence(`Exemption: CI-only

- Exemption reason: workflow-only change for PR evidence lint.
`),
  );
  const logs = [];
  const errors = [];
  const code = main(["--body-file", file], {
    log: (...args) => logs.push(args.join(" ")),
    error: (...args) => errors.push(args.join(" ")),
  });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(code, 0, errors.join("\n"));
  assert.match(logs.join("\n"), /OK/);
});

test("CLI --body-file exits 1 for an empty evidence template body", () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-evidence-"));
  const file = join(dir, "body.md");
  writeFileSync(file, bodyWithEvidence(EMPTY_TEMPLATE_EVIDENCE));
  const errors = [];
  const code = main(["--body-file", file], {
    log: () => {},
    error: (...args) => errors.push(args.join(" ")),
  });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(code, 1);
  assert.match(errors.join("\n"), /FAILED/);
});
