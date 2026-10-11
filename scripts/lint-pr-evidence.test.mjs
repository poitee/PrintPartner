import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
  assert.match(result.errors.join("\n"), /Evidence is incomplete|Evidence block is empty/i);
});

test("fails when only Journey exercised is filled (Greptile P1)", () => {
  const result = lintPrEvidence(
    bodyWithEvidence(`Exemption: none

- Journey exercised: login
- Steps followed to produce the evidence:
- Result observed:
- Screenshot / recording / verify-skill output or trace:
`),
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /incomplete|journey name alone/i);
});

test("fails when multiline Exemption reason is the only filled text", () => {
  const result = lintPrEvidence(
    bodyWithEvidence(`Exemption: none

- Exemption reason (required when claiming an exemption):
  We exercised the journey carefully and things looked fine in review.

- Journey exercised:
- Steps followed to produce the evidence:
- Result observed:
- Screenshot / recording / verify-skill output or trace:
`),
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /incomplete|empty/i);
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

test("allows docs-only PRs that mention LAN hosts without targeting them (Greptile P1)", () => {
  const result = lintPrEvidence(
    bodyWithEvidence(`Exemption: docs-only

- Exemption reason: Document why http://192.168.200.80:8080 needs HTTPS and must not be used for automated verify.
`),
  );
  assert.equal(result.ok, true, result.errors.join("; "));
  assert.equal(result.exemption, "docs-only");
});

test("rejects unknown internal-refactor suffixes", () => {
  const result = lintPrEvidence(
    bodyWithEvidence(`Exemption: internal refactor with user-visible changes

- Exemption reason: renamed helpers
`),
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /Unknown Exemption/i);
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

test("passes when Steps are nested bullets under the Steps label (Greptile P1: Nested steps fail CI)", () => {
  const result = lintPrEvidence(
    bodyWithEvidence(`Exemption: none

- Journey exercised: Library → Builds
- Steps followed to produce the evidence:
  - Opened https://example.test
  - Clicked Builds
- Result observed: Builds table rendered without overlap
- Screenshot / recording / verify-skill output or trace: https://example.test/evidence.png
`),
  );
  assert.equal(result.ok, true, result.errors.join("; "));
});

test("fails docs-only PRs whose Steps verify against a .80/.81 host (Greptile P1: Banned verification targets pass)", () => {
  const result = lintPrEvidence(
    bodyWithEvidence(`Exemption: docs-only

- Exemption reason: Documentation update only.
- Steps followed to produce the evidence: ran automated verify against http://192.168.1.80:8080
`),
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /\.80\/\.81/);
});

test("fails when a freeform verification link outside labeled fields targets .80/.81 (Greptile P1: Banned verification targets pass)", () => {
  const result = lintPrEvidence(
    bodyWithEvidence(`Exemption: none

- Journey exercised: Library
- Steps followed to produce the evidence: opened local instance
- Result observed: ok
- Screenshot / recording / verify-skill output or trace: trace.json

https://192.168.200.81:8443/shot.png
`),
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /\.80\/\.81/);
});

for (const artifact of ["evidence", "screenshot", "recording", "verify-skill"]) {
  test(`fails when the artifact is only the category word "${artifact}" (Codex P1)`, () => {
    const result = lintPrEvidence(
      bodyWithEvidence(`Exemption: none

- Journey exercised: Library
- Steps followed to produce the evidence: opened local instance, clicked Builds
- Result observed: table rendered
- Screenshot / recording / verify-skill output or trace: ${artifact}
`),
    );
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /Evidence is incomplete/);
  });
}

for (const artifact of [
  "`screenshot`",
  "`evidence`",
  "`recording`",
  "`verify-skill`",
  "`` `screenshot` ``",
  "`ok`",
]) {
  test(`fails when the artifact is only inline code ${artifact} with no real content (Codex P1: backticked category words)`, () => {
    const result = lintPrEvidence(
      bodyWithEvidence(`Exemption: none

- Journey exercised: Library
- Steps followed to produce the evidence: opened local instance, clicked Builds
- Result observed: table rendered
- Screenshot / recording / verify-skill output or trace: ${artifact}
`),
    );
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /Evidence is incomplete/);
  });
}

for (const artifact of [
  "`node --test scripts/lint-pr-evidence.test.mjs`",
  "`evidence/run-42/trace`",
  "`tests 37 pass 37 fail 0`",
]) {
  test(`passes when the artifact is substantive inline code ${artifact} (Codex P1: backticked category words)`, () => {
    const result = lintPrEvidence(
      bodyWithEvidence(`Exemption: none

- Journey exercised: Library
- Steps followed to produce the evidence: opened local instance, clicked Builds
- Result observed: table rendered
- Screenshot / recording / verify-skill output or trace: ${artifact}
`),
    );
    assert.equal(result.ok, true, result.errors.join("; "));
  });
}

test("ignores URLs inside a multiline Exemption reason when looking for an artifact (Codex P2)", () => {
  const result = lintPrEvidence(
    bodyWithEvidence(`Exemption: none

- Exemption reason (required when claiming an exemption):
  See the run
  at https://example.test/evidence.png for the screenshot.

- Journey exercised: Library
- Steps followed to produce the evidence: opened local instance
- Result observed: table rendered
- Screenshot / recording / verify-skill output or trace:
`),
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /Evidence is incomplete/);
});

test("ignores a commented-out Evidence section (Greptile P2: Hidden evidence passes)", () => {
  const result = lintPrEvidence(`## Summary

<!--
## Evidence

Exemption: docs-only

- Exemption reason: hidden text
-->
`);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /Missing "## Evidence"/);
});

test("ignores an Evidence heading inside a fenced code block (Codex P2)", () => {
  const result = lintPrEvidence(`## Summary

\`\`\`md
## Evidence

Exemption: docs-only

- Exemption reason: example only
\`\`\`
`);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /Missing "## Evidence"/);
});

test("CLI runs when invoked with a relative script path (Bugbot: CI lint never runs)", () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const run = spawnSync(process.execPath, ["lint-pr-evidence.mjs"], {
    cwd: scriptsDir,
    env: { ...process.env, PR_BODY: bodyWithEvidence(EMPTY_TEMPLATE_EVIDENCE) },
    encoding: "utf8",
  });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /FAILED/);
});

test("fails when a URL sits on a continuation line of a same-line Exemption reason (Codex P2)", () => {
  const result = lintPrEvidence(
    bodyWithEvidence(`Exemption: none
- Exemption reason: context only
  See https://example.test/evidence.png

- Steps followed to produce the evidence: opened local
- Result observed: rendered
- Screenshot / recording / verify-skill output or trace:
`),
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /Evidence is incomplete/);
});

test("fails when a URL sits in a later paragraph of an Exemption reason (Codex P1: blank line truncates reason)", () => {
  const result = lintPrEvidence(
    bodyWithEvidence(`Exemption: none
- Exemption reason: context only

  See https://example.test/context.png

- Steps followed to produce the evidence: opened local
- Result observed: rendered
- Screenshot / recording / verify-skill output or trace:
`),
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /Evidence is incomplete/);
});

test("fails when a backticked command sits in a later paragraph of an Exemption reason (Codex P1: blank line truncates reason)", () => {
  const result = lintPrEvidence(
    bodyWithEvidence(`Exemption: none
- Exemption reason: context only


  Ran \`node --test scripts/lint-pr-evidence.test.mjs\` earlier.

- Steps followed to produce the evidence: opened local
- Result observed: rendered
- Screenshot / recording / verify-skill output or trace:
`),
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /Evidence is incomplete/);
});

test("passes when Exemption: none has a reason with a blank line and a real artifact in the artifact field", () => {
  const result = lintPrEvidence(
    bodyWithEvidence(`Exemption: none
- Exemption reason: context only

  Second paragraph of the reason.

- Steps followed to produce the evidence: opened local
- Result observed: rendered
- Screenshot / recording / verify-skill output or trace: \`node --test scripts/lint-pr-evidence.test.mjs\`
`),
  );
  assert.equal(result.ok, true, result.errors.join("; "));
  assert.equal(result.hasEvidence, true);
});

test("allows a LAN mention in a later paragraph of an Exemption reason (docs-only)", () => {
  const result = lintPrEvidence(
    bodyWithEvidence(`Exemption: docs-only
- Exemption reason: Document why this host is prohibited:

  http://192.168.1.80:8080 must never be used for verify.
`),
  );
  assert.equal(result.ok, true, result.errors.join("; "));
});

test("fails when a LAN target follows a blank line and an unindented sibling bullet (Codex P1 boundary still holds)", () => {
  const result = lintPrEvidence(
    bodyWithEvidence(`Exemption: docs-only
- Exemption reason: Document the setup.

- Steps followed to produce the evidence: curl http://192.168.1.80:8080/health
`),
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /LAN instances/);
});

test("allows a LAN mention on a continuation line of a same-line Exemption reason (Codex P2)", () => {
  const result = lintPrEvidence(
    bodyWithEvidence(`Exemption: docs-only
- Exemption reason: Document why this host is prohibited:
  http://192.168.1.80:8080 must never be used for verify.
`),
  );
  assert.equal(result.ok, true, result.errors.join("; "));
});

test("ignores an Evidence heading inside a fence closed by a longer fence (Codex P2)", () => {
  const result = lintPrEvidence(`## Summary

\`\`\`md
## Evidence

Exemption: docs-only

- Exemption reason: example only
\`\`\`\`
`);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /Missing "## Evidence"/);
});

test("ignores an Evidence heading inside an unclosed fence (Codex P2)", () => {
  const result = lintPrEvidence(`## Summary

\`\`\`md
## Evidence

Exemption: docs-only

- Exemption reason: example only
`);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /Missing "## Evidence"/);
});

test("ignores an Evidence heading inside a tilde fence (Codex P2)", () => {
  const result = lintPrEvidence(`## Summary

~~~md
## Evidence

Exemption: docs-only

- Exemption reason: example only
~~~
`);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /Missing "## Evidence"/);
});

test("fails when an unindented sibling bullet after the reason targets .80/.81 (Codex P1)", () => {
  const result = lintPrEvidence(
    bodyWithEvidence(`Exemption: docs-only
- Exemption reason: Update docs.
- Verification target: http://192.168.1.80:8080
`),
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /\.80\/\.81/);
});

test("does not let an HTML comment containing a fence opener hide Evidence (Codex P2)", () => {
  const result = lintPrEvidence(`<!--
\`\`\`
-->
## Evidence

Exemption: docs-only

- Exemption reason: Update docs.
`);
  assert.equal(result.ok, true, result.errors.join("; "));
});

test("treats triple-backtick inline code as a paragraph, not a fence (Codex P2)", () => {
  const result = lintPrEvidence(`\`\`\`inline code\`\`\`

## Evidence

Exemption: docs-only

- Exemption reason: Update docs.
`);
  assert.equal(result.ok, true, result.errors.join("; "));
});

test("reads a multi-paragraph artifact field whole (Bugbot: blank lines truncate field values)", () => {
  const result = lintPrEvidence(
    bodyWithEvidence(`Exemption: none
- Steps followed to produce the evidence: opened local
- Result observed: rendered
- Screenshot / recording / verify-skill output or trace: see below

  https://example.test/evidence.png
`),
  );
  assert.equal(result.ok, true, result.errors.join("; "));
});

for (const marker of ["+", "1.", "2)"]) {
  test(`fails when a "${marker}" list item after the reason targets .80/.81 (Codex P1: every list marker is a field boundary)`, () => {
    const result = lintPrEvidence(
      bodyWithEvidence(`Exemption: docs-only
- Exemption reason: Update docs.
${marker} Verification target: http://192.168.1.80:8080
`),
    );
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /\.80\/\.81/);
  });
}

for (const artifact of ["[screenshot](#)", "[evidence](TODO)", "[evidence.png](#)", "![screenshot](tbd)", "[trace](<>)"]) {
  test(`fails when the artifact is the placeholder link ${artifact} (Codex P1: placeholder Markdown links)`, () => {
    const result = lintPrEvidence(
      bodyWithEvidence(`Exemption: none
- Steps followed to produce the evidence: opened local
- Result observed: rendered
- Screenshot / recording / verify-skill output or trace: ${artifact}
`),
    );
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /Evidence is incomplete/);
  });
}

for (const artifact of ["[run](https://example.test/run/1)", "![shot](./evidence/shot.png)", "[trace](evidence/trace.zip)"]) {
  test(`passes when the artifact is the concrete link ${artifact} (Codex P1: placeholder Markdown links)`, () => {
    const result = lintPrEvidence(
      bodyWithEvidence(`Exemption: none
- Steps followed to produce the evidence: opened local
- Result observed: rendered
- Screenshot / recording / verify-skill output or trace: ${artifact}
`),
    );
    assert.equal(result.ok, true, result.errors.join("; "));
  });
}

for (const artifact of ["evidence/trace.zip", "recording.mkv", "screenshot.svg"]) {
  test(`passes when the artifact is the path ${artifact} (Codex P2: artifact paths outside the extension shortlist)`, () => {
    const result = lintPrEvidence(
      bodyWithEvidence(`Exemption: none
- Steps followed to produce the evidence: opened local
- Result observed: rendered
- Screenshot / recording / verify-skill output or trace: ${artifact}
`),
    );
    assert.equal(result.ok, true, result.errors.join("; "));
  });
}

test("scans long unmatched backtick and bracket runs in linear time (Codex P1: bound inline-code scanning)", () => {
  for (const noise of ["`".repeat(60000), "` `` ".repeat(12000), "[".repeat(60000), "[a](".repeat(15000)]) {
    const started = performance.now();
    const result = lintPrEvidence(
      bodyWithEvidence(`Exemption: none
- Steps followed to produce the evidence: opened local
- Result observed: rendered
- Screenshot / recording / verify-skill output or trace: ${noise}
`),
    );
    const elapsed = performance.now() - started;
    assert.equal(result.ok, false);
    assert.ok(elapsed < 1000, `lint took ${Math.round(elapsed)} ms for ${noise.slice(0, 8)}...`);
  }
});

test("ends the Exemption reason at an outer blockquote that targets .80/.81 (Codex P1: every list marker is a field boundary)", () => {
  const result = lintPrEvidence(
    bodyWithEvidence(`Exemption: docs-only
- Exemption reason: Update docs.
> Verified against http://192.168.1.80:8080
`),
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /\.80\/\.81/);
});

test("keeps a heading inside the Exemption reason's content column in the reason (Bugbot: blank lines truncate field values)", () => {
  const result = lintPrEvidence(
    bodyWithEvidence(`Exemption: none
- Exemption reason: context only

  ### Background

  https://example.test/context.png

- Steps followed to produce the evidence: opened local
- Result observed: rendered
- Screenshot / recording / verify-skill output or trace:
`),
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /Evidence is incomplete/);
});

test("ends an ordered-list field at an unindented paragraph after a blank line (Bugbot: blank lines truncate field values)", () => {
  const result = lintPrEvidence(
    bodyWithEvidence(`Exemption: docs-only
1. Exemption reason: Update docs.

  Verified against http://192.168.1.80:8080
`),
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /\.80\/\.81/);
});
