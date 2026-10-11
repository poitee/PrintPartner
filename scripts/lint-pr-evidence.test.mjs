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

const ARTIFACT_LABEL = "- Screenshot / recording / verify-skill output or trace:";

for (const artifact of ["[screenshot](# 'see evidence.png')", "[screenshot](# (see evidence.png))", '[screenshot](#  "evidence.png")']) {
  test(`fails when a placeholder link hides a filename in its title: ${artifact} (substitute review r1 P1: link titles)`, () => {
    const result = lintPrEvidence(
      bodyWithEvidence(`Exemption: none
- Steps followed to produce the evidence: opened local
- Result observed: rendered
${ARTIFACT_LABEL} ${artifact}
`),
    );
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /Evidence is incomplete/);
  });
}

test("passes a concrete link with a single-quoted title (substitute review r1 P1: link titles)", () => {
  const result = lintPrEvidence(
    bodyWithEvidence(`Exemption: none
- Steps followed to produce the evidence: opened local
- Result observed: rendered
${ARTIFACT_LABEL} [shot](https://example.test/shot.png 'Builds page')
`),
  );
  assert.equal(result.ok, true, result.errors.join("; "));
});

for (const [opener, body, closer] of [
  ["  - ```text", "    https://example.test/example.png", "    ```"],
  ["  > ```text", "  > https://example.test/example.png", "  > ```"],
  ["  1. ~~~", "     https://example.test/example.png", "     ~~~"],
]) {
  test(`ignores a fence opened inside a nested container: ${opener.trim()} (substitute review r1 P1: nested list fences)`, () => {
    const result = lintPrEvidence(
      bodyWithEvidence(`Exemption: none
- Steps followed to produce the evidence: opened local
- Result observed: rendered
${ARTIFACT_LABEL}
${opener}
${body}
${closer}
`),
    );
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /Evidence is incomplete/);
  });
}

test("ends a field after a fence, so an outer paragraph is not a lazy continuation (substitute review r1 P1: nested list fences)", () => {
  const result = lintPrEvidence(
    bodyWithEvidence(`Exemption: docs-only
- Exemption reason: Updated docs.
  \`\`\`text
  example
  \`\`\`
Verified against http://192.168.1.80:8080
`),
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /\.80\/\.81/);
});

test("treats a field label nested inside the Exemption reason as reason text (substitute review r1 P1: nested labels)", () => {
  const result = lintPrEvidence(
    bodyWithEvidence(`Exemption: none
- Steps followed to produce the evidence: opened local
- Result observed: rendered
- Exemption reason: Context only
  ${ARTIFACT_LABEL} https://example.test/context.png
`),
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /Evidence is incomplete/);
});

for (const block of ["  ### Background", "  ---", "  <div>"]) {
  test(`ends the Exemption reason at an outer paragraph after a nested ${block.trim()} (substitute review r1 P1: no lazy continuation after blocks)`, () => {
    const result = lintPrEvidence(
      bodyWithEvidence(`Exemption: docs-only
- Exemption reason: Updated docs.
${block}
Verified against http://192.168.1.80:8080
`),
    );
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /\.80\/\.81/);
  });
}

for (const tag of ["<fieldset>", "<iframe src=x>", "<dd>", "<?php", "<!DOCTYPE html>", "<center>"]) {
  test(`ends the Exemption reason at the outer HTML block ${tag} (substitute review r1 P1: HTML block boundaries)`, () => {
    const result = lintPrEvidence(
      bodyWithEvidence(`Exemption: docs-only
- Exemption reason: Updated docs.
${tag}
Verified against http://192.168.1.80:8080
`),
    );
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /\.80\/\.81/);
  });
}

test("checks lazy (unindented) continuation lines of the Exemption reason for .80/.81 (substitute review r2 P1: ambiguous lazy lines)", () => {
  const result = lintPrEvidence(
    bodyWithEvidence(`Exemption: docs-only
- Exemption reason: Document the prohibited host
http://192.168.1.80:8080 in the setup guide.
`),
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /indent every reason line/);
});

test("never counts lazy continuation lines of the Exemption reason as evidence (substitute review r2 P1: ambiguous lazy lines)", () => {
  const result = lintPrEvidence(
    bodyWithEvidence(`Exemption: none
- Steps followed to produce the evidence: opened local
- Result observed: rendered
- Exemption reason: context only
https://example.test/context.png
`),
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /Evidence is incomplete/);
});

test("trims artifact tokens in linear time (substitute review r1 P2: quadratic token cleanup)", () => {
  for (const noise of [`a${".".repeat(60000)}x`, `a${")".repeat(60000)}x`, `Exemption: a${" ".repeat(60000)}x`, `_ ${"_ ".repeat(30000)}x`]) {
    const started = performance.now();
    lintPrEvidence(
      bodyWithEvidence(`Exemption: none
- Steps followed to produce the evidence: opened local
- Result observed: rendered
${ARTIFACT_LABEL} ${noise}
`),
    );
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 1000, `lint took ${Math.round(elapsed)} ms for ${noise.slice(0, 12)}...`);
  }
});

for (const artifact of ["screenshot.tiff", "run.trace", "session.cast"]) {
  test(`passes when the artifact is the bare file ${artifact} (substitute review r1 P2: extension shortlist)`, () => {
    const result = lintPrEvidence(
      bodyWithEvidence(`Exemption: none
- Steps followed to produce the evidence: opened local
- Result observed: rendered
${ARTIFACT_LABEL} ${artifact}
`),
    );
    assert.equal(result.ok, true, result.errors.join("; "));
  });
}

for (const [name, block] of [
  ["a quoted fence", "\n  > ```text\n  > example\n  > ```\n"],
  ["an unclosed list fence", "\n  - ```text\n    example\n"],
  ["an unclosed indented fence", "  ```text\n  example\n"],
]) {
  test(`checks the paragraph after ${name} in the Exemption reason for .80/.81 (substitute review r2 P1: fence containers)`, () => {
    const result = lintPrEvidence(
      bodyWithEvidence(`Exemption: docs-only
- Exemption reason: Updated docs.
${block}
Verified against http://192.168.1.80:8080
`),
    );
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /\.80\/\.81/);
  });
}

for (const block of ["  > ### Background", "  - ### Background", "  Background\n  ===", "  <div>\n  Documentation"]) {
  test(`checks an outer line after ${JSON.stringify(block)} in the Exemption reason for .80/.81 (substitute review r2 P1: non-paragraph blocks)`, () => {
    const result = lintPrEvidence(
      bodyWithEvidence(`Exemption: docs-only
- Exemption reason: Updated docs.
${block}
Verified against http://192.168.1.80:8080
`),
    );
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /\.80\/\.81/);
  });
}

for (const artifact of [
  '[screenshot](# "the \\"before\\" evidence.png")',
  '[**screenshot [before]**](# "see evidence.png")',
  "[screenshot](# 'it\\'s https://example.test/x.png')",
  '[screenshot](#a(b) "evidence.png")',
  '[screenshot](# "unterminated evidence.png',
  "[screenshot][1]\n  [1]: # 'evidence.png'",
]) {
  test(`fails when a placeholder link hides an artifact in its title: ${JSON.stringify(artifact)} (substitute review r2 P1: escaped titles and nested labels)`, () => {
    const result = lintPrEvidence(
      bodyWithEvidence(`Exemption: none
- Steps followed to produce the evidence: opened local
- Result observed: rendered
${ARTIFACT_LABEL} ${artifact}
`),
    );
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /Evidence is incomplete/);
  });
}

for (const artifact of [
  '[**shot [before]**](https://example.test/shot.png "the \\"before\\" view")',
  "[shot](<evidence/shot one.png>)",
  "[shot][1]\n  [1]: https://example.test/shot.png",
  "[trace](evidence/run(42).zip)",
]) {
  test(`passes when a link with a concrete destination is ${JSON.stringify(artifact)} (substitute review r2 P1: escaped titles and nested labels)`, () => {
    const result = lintPrEvidence(
      bodyWithEvidence(`Exemption: none
- Steps followed to produce the evidence: opened local
- Result observed: rendered
${ARTIFACT_LABEL} ${artifact}
`),
    );
    assert.equal(result.ok, true, result.errors.join("; "));
  });
}

test("parses fence prefixes, link tails, and the Exemption line in linear time (substitute review r2 P2: exponential and quadratic scans)", () => {
  const cases = [
    `## Evidence\nExemption: docs-only\n- Exemption reason: docs\n${"-  ".repeat(20000)}x\n`,
    `## Evidence\nExemption: docs-only\n- Exemption reason: docs\n${"> 1. ".repeat(12000)}\`\`\`\n`,
    bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: a\n- Result observed: b\n${ARTIFACT_LABEL} [shot](${" ".repeat(60000)}x\n`),
    bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: a\n- Result observed: b\n${ARTIFACT_LABEL} ${"](".repeat(30000)}\n`),
    bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: a\n- Result observed: b\n${ARTIFACT_LABEL} ${'[a](# "'.repeat(9000)}\n`),
    `## Evidence\nExemption: a${" ".repeat(60000)}x\n- Exemption reason: Updated docs.\n`,
  ];
  for (const body of cases) {
    const started = performance.now();
    lintPrEvidence(body);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 1000, `lint took ${Math.round(elapsed)} ms for ${JSON.stringify(body.slice(0, 80))}`);
  }
});

test("checks text after a nested quote fence drops to an outer quote level for .80/.81 (substitute review r3 P1: nested quote fences)", () => {
  const result = lintPrEvidence(
    bodyWithEvidence(`Exemption: docs-only
- Exemption reason: Updated docs.

> > \`\`\`text
> > example
> Verified against http://192.168.1.80:8080
`),
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /\.80\/\.81/);
});

for (const opener of ["`<!--`", "\\<!--", "<!-- (unclosed)"]) {
  test(`does not let a literal ${opener} in the reason hide later verification (substitute review r3 P1: comment openers)`, () => {
    const result = lintPrEvidence(
      bodyWithEvidence(`Exemption: docs-only
- Exemption reason: Documented the literal ${opener} opener.

Verified against http://192.168.1.80:8080
`),
    );
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /\.80\/\.81/);
  });
}

test("still hides a multi-line inline comment from the artifact check (substitute review r3 P1 guard: comment openers)", () => {
  const result = lintPrEvidence(
    bodyWithEvidence(`Exemption: none
- Steps followed to produce the evidence: opened local
- Result observed: rendered
${ARTIFACT_LABEL} pending <!--
  https://example.test/shot.png
  -->
`),
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /Evidence is incomplete/);
});

for (const artifact of ["[`evidence.png`](#)", "[ evidence.png ](#)", "![run.trace](#)", "[a [nested `trace.json`]](#)", "[x\\] evidence.png](#)"]) {
  test(`fails when only placeholder link text names an artifact: ${artifact} (substitute review r3 P1: placeholder-link labels)`, () => {
    const result = lintPrEvidence(
      bodyWithEvidence(`Exemption: none
- Steps followed to produce the evidence: opened local
- Result observed: rendered
${ARTIFACT_LABEL} ${artifact}
`),
    );
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /Evidence is incomplete/);
  });
}

for (const definition of ['[1]: #\n  "evidence.png"', "[1]:\n  #\n  'evidence.png'", '[a\\]b]: # "evidence.png"', '[1]: # "multi\n  line evidence.png"']) {
  test(`fails when a reference definition hides an artifact in its title: ${JSON.stringify(definition)} (substitute review r3 P1: multiline reference titles)`, () => {
    const result = lintPrEvidence(
      bodyWithEvidence(`Exemption: none
- Steps followed to produce the evidence: opened local
- Result observed: rendered
${ARTIFACT_LABEL} [screenshot][1]

${definition}
`),
    );
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /Evidence is incomplete/);
  });
}

test("passes a reference definition whose destination is on the next line (substitute review r3 P1 guard)", () => {
  const result = lintPrEvidence(
    bodyWithEvidence(`Exemption: none
- Steps followed to produce the evidence: opened local
- Result observed: rendered
${ARTIFACT_LABEL} [screenshot][1]

[1]:
  https://example.test/shot.png
`),
  );
  assert.equal(result.ok, true, result.errors.join("; "));
});

for (const artifact of ["`TODO: attach screenshot`", "`tbd later`", "`FIXME add trace.json`", "TODO: attach trace.json"]) {
  test(`fails when the artifact is a placeholder note ${artifact} (substitute review r3 P1: TODO placeholders)`, () => {
    const result = lintPrEvidence(
      bodyWithEvidence(`Exemption: none
- Steps followed to produce the evidence: opened local
- Result observed: rendered
${ARTIFACT_LABEL} ${artifact}
`),
    );
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /Evidence is incomplete/);
  });
}

test("passes a link whose <…> destination escapes > (substitute review r3 P2: escaped angle brackets)", () => {
  const result = lintPrEvidence(
    bodyWithEvidence(`Exemption: none
- Steps followed to produce the evidence: opened local
- Result observed: rendered
${ARTIFACT_LABEL} [shot](<evidence/shot\\>one.png>)
`),
  );
  assert.equal(result.ok, true, result.errors.join("; "));
});

test("strips comments and link text in linear time (substitute review r3 P2: repeated comment stripping)", () => {
  const prefix = "## Evidence\nExemption: docs-only\n- Exemption reason: docs\n";
  const cases = [
    prefix + "<!<!--x-->--".repeat(5456),
    prefix + "<!--".repeat(16000),
    prefix + "`<!--` ".repeat(9000),
    bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: a\n- Result observed: b\n${ARTIFACT_LABEL} ${"\\".repeat(60000)}](#)\n`),
    bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: a\n- Result observed: b\n${ARTIFACT_LABEL} ${"[".repeat(30000)}${"](#)".repeat(8000)}\n`),
    bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: a\n- Result observed: b\n${ARTIFACT_LABEL} x\n\n${"[1]: #\n".repeat(9000)}`),
  ];
  for (const body of cases) {
    const started = performance.now();
    lintPrEvidence(body);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 1000, `lint took ${Math.round(elapsed)} ms for ${JSON.stringify(body.slice(55, 120))}`);
  }
});

// Sweep regressions for confirmed current-head review findings.
for (const reason of ["TODO", "TBD", "N/A", "none"]) {
  test(`rejects placeholder exemption reason ${reason}`, () => {
    assert.equal(lintPrEvidence(bodyWithEvidence(`Exemption: docs-only\n- Exemption reason: ${reason}`)).ok, false);
  });
}
for (const artifact of ["No screenshot.png was produced", "evidence/trace.zip was not generated", "`not provided`", "[unused]: evidence/shot.png", "without screenshot.png", "screenshot.png missing from run", "never uploaded screenshot.png", "did not produce trace.json", "screenshot.png absent", "screenshot.png unavailable", "unable to attach screenshot.png", "screenshot.png omitted", "screenshot.png not included", "N/A screenshot.png"]) {
  test(`rejects absent or unused artifact ${artifact}`, () => {
    const result = lintPrEvidence(bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n${ARTIFACT_LABEL} ${artifact}`));
    assert.equal(result.ok, false);
  });
}
test("quoted list fence ends when verification leaves the list item", () => {
  const result = lintPrEvidence(bodyWithEvidence('Exemption: docs-only\n- Exemption reason: Updated docs.\n\n> - ```text\n>   example\n> Verified against http://192.168.1.80:8080'));
  assert.equal(result.ok, false);
  assert.match(result.errors.join(";"), /\.80\/\.81/);
});
test("commented decoy heading cannot redirect the LAN scan", () => {
  const result = lintPrEvidence('## Evidence\nExemption: none\n- Steps followed to produce the evidence: see <!-- note\n## Evidence\ndecoy\nhttp://192.168.1.81\nend comment --> real steps curl http://192.168.1.80:8080\n- Result observed: ok\n- Screenshot / recording / verify-skill output or trace: https://example.test/trace.json');
  assert.equal(result.ok, false);
  assert.match(result.errors.join(";"), /\.80\/\.81/);
});
test("top-level Appendix cannot supply missing Evidence fields", () => {
  assert.equal(lintPrEvidence('## Evidence\n\n# Appendix\nExemption: docs-only\n- Exemption reason: Updated docs.').ok, false);
});
test("rejects a split Evidence heading", () => {
  assert.equal(lintPrEvidence('##\nEvidence\nExemption: docs-only\n- Exemption reason: Updated docs.').ok, false);
});
for (const spaces of [1, 2, 3]) {
  test(`accepts Evidence heading with ${spaces} leading spaces`, () => {
    assert.equal(lintPrEvidence(' '.repeat(spaces) + '## Evidence\nExemption: docs-only\n- Exemption reason: Updated docs.').ok, true);
  });
}
test("rejects duplicate Exemption declarations", () => {
  assert.equal(lintPrEvidence(bodyWithEvidence('Exemption: docs-only\nExemption: none\n- Exemption reason: Updated docs.')).ok, false);
});
test("flush fence closer closes an indented top-level fence", () => {
  assert.equal(lintPrEvidence('  ```text\nexample\n```\n## Evidence\nExemption: docs-only\n- Exemption reason: Updated docs.').ok, true);
});
for (const closer of ['> ```', '- ```']) {
  test(`container marker does not close a top-level fence: ${closer}`, () => {
    assert.equal(lintPrEvidence('```text\n' + closer + '\n## Evidence\nExemption: docs-only\n- Exemption reason: Updated docs.').ok, false);
  });
}


test("an unrelated denial clause does not suppress an explicit artifact citation", () => {
  const result = lintPrEvidence(bodyWithEvidence(`Exemption: none
- Steps followed to produce the evidence: ran locally
- Result observed: passed
${ARTIFACT_LABEL} Verified without redeploy; artifact at artifacts/screen.png`));
  assert.equal(result.ok, true, result.errors.join(";"));
});

for (const artifact of ["artifacts/missing/trace.json", "artifact at artifacts/not-a-screenshot.png", "https://example.com/missing/trace.json"]) {
  test(`denial words inside a cited target remain valid: ${artifact}`, () => {
    assert.equal(lintPrEvidence(bodyWithEvidence(`Exemption: none
- Steps followed to produce the evidence: ran locally
- Result observed: passed
${ARTIFACT_LABEL} ${artifact}`)).ok, true);
  });
}
for (const field of ["Steps followed to produce the evidence", "Result observed"]) {
  for (const placeholder of ["TODO", "TBD", "N/A", "** **", "none"]) {
    test(`rejects placeholder ${placeholder} in ${field}`, () => {
      const body = bodyWithEvidence(`Exemption: none
- Steps followed to produce the evidence: ran locally
- Result observed: passed
${ARTIFACT_LABEL} trace.json`).replace(`${field}: ${field.startsWith("Steps") ? "ran locally" : "passed"}`, `${field}: ${placeholder}`);
      assert.equal(lintPrEvidence(body).ok, false);
    });
  }
}

for (const artifact of ['](evidence/shot.png)', '\\](evidence/shot.png)', '[foo](#)\n\n[foo]: evidence/shot.png', '`[foo]`\n\n[foo]: evidence/shot.png', '\\[foo]\n\n[foo]: evidence/shot.png', '[foo][bar]\n\n[foo]: evidence/shot.png']) {
  test(`reference/opener regression rejects ${artifact}`, () => {
    assert.equal(lintPrEvidence(bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n${ARTIFACT_LABEL} ${artifact}`)).ok, false);
  });
}
for (const use of ['[shot]', '[shot][]', '[screen][shot]']) {
  test(`accepts actual reference use ${use}`, () => {
    assert.equal(lintPrEvidence(bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n${ARTIFACT_LABEL} ${use}\n\n[shot]: evidence/shot.png`)).ok, true);
  });
}

for (const prose of ['nothing attached', 'artifact forthcoming', 'evidence will follow', 'ran it successfully']) {
  test(`rejects arbitrary inline-code prose ${prose}`, () => {
    assert.equal(lintPrEvidence(bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n${ARTIFACT_LABEL} \`${prose}\``)).ok, false);
  });
}
for (const use of ['[preview][target]', '[target]', '[target][]']) {
  for (const placement of ['before', 'after']) {
    test(`rejects banned document-wide reference ${use} defined ${placement}`, () => {
      const evidence = bodyWithEvidence(`Exemption: docs-only\n- Exemption reason: Documentation update.\n- Steps followed to produce the evidence: checked ${use}`);
      const definition = '[target]: http://192.168.1.80:8080';
      const body = placement === 'before' ? definition + '\n\n' + evidence : evidence + '\n\n## Appendix\n' + definition;
      assert.equal(lintPrEvidence(body).ok, false);
    });
  }
}
test('unused banned document-wide definition is not a verification target', () => {
  assert.equal(lintPrEvidence('[target]: http://192.168.1.80:8080\n\n' + bodyWithEvidence('Exemption: docs-only\n- Exemption reason: Documentation update.')).ok, true);
});


for (const placeholder of ['**TODO**', '[TODO](#)', '<em>TODO</em>', '[not provided](https://example.test/info)', '[**TBD**](# "details")', '<span title="explained">none</span>', 'T&#79;DO', 'T&#x4f;DO', '&nbsp;', '[TODO][details]']) {
  for (const field of ['Steps followed to produce the evidence', 'Result observed', 'Exemption reason']) {
    test(`rejects visible placeholder ${placeholder} in ${field}`, () => {
      const body = field === 'Exemption reason'
        ? bodyWithEvidence(`Exemption: docs-only\n- Exemption reason: ${placeholder}`)
        : bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n${ARTIFACT_LABEL} trace.json`).replace(`${field}: ${field.startsWith('Steps') ? 'ran locally' : 'passed'}`, `${field}: ${placeholder}`);
      assert.equal(lintPrEvidence(body).ok, false);
    });
  }
}
for (const reason of ['[Updated the guide](https://example.test/docs)', '<em>Adjusted workflow paths</em>', '`pnpm test` passed', 'CI only: updated action pins']) {
  test(`accepts substantive formatted exemption reason ${reason}`, () => {
    assert.equal(lintPrEvidence(bodyWithEvidence(`Exemption: ci-only\n- Exemption reason: ${reason}`)).ok, true);
  });
}

test('bounds malformed link-tail scanning in required fields', () => {
  const start = performance.now();
  lintPrEvidence(bodyWithEvidence('Exemption: docs-only\n- Exemption reason: ' + '[a]('.repeat(15000)));
  assert.ok(performance.now() - start < 1000);
});

for (const placeholder of ['ＴＯＤＯ', 'ⓣⓞⓓⓞ', 'T\u200bODO', 'TO\u200dDO', 'TODо', 'ΤΟDΟ', 'ТВD', 'Ｎ／Ａ', 'T\u0301ODO', '\u200b']) {
  for (const field of ['Steps followed to produce the evidence', 'Result observed', 'Exemption reason']) {
    test(`rejects Unicode placeholder ${JSON.stringify(placeholder)} in ${field}`, () => {
      const body = field === 'Exemption reason'
        ? bodyWithEvidence(`Exemption: docs-only\n- Exemption reason: ${placeholder}`)
        : bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n${ARTIFACT_LABEL} trace.json`).replace(`${field}: ${field.startsWith('Steps') ? 'ran locally' : 'passed'}`, `${field}: ${placeholder}`);
      assert.equal(lintPrEvidence(body).ok, false);
    });
  }
}
test('accepts substantive Unicode explanation', () => {
  assert.equal(lintPrEvidence(bodyWithEvidence('Exemption: docs-only\n- Exemption reason: 更新了用户指南。')).ok, true);
});

for (const reason of ['![](#)', '![TODO](#)', '![**TBD**](#)', '![][missing]', '![TODO][missing]']) {
  test(`rejects empty/placeholder image reason ${reason}`, () => {
    assert.equal(lintPrEvidence(bodyWithEvidence(`Exemption: docs-only\n- Exemption reason: ${reason}`)).ok, false);
  });
}
for (const artifact of ['[shot](http://256.256.256.256)', 'http://256.256.256.256', '`http://256.256.256.256`', '[shot](https://)', '[shot](http://example.test:99999)', 'http://[invalid]']) {
  test(`rejects invalid HTTP evidence ${artifact}`, () => {
    assert.equal(lintPrEvidence(bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n${ARTIFACT_LABEL} ${artifact}`)).ok, false);
  });
}
for (const underline of ['====', '----']) {
  test(`Evidence ends before setext Test plan ${underline}`, () => {
    assert.equal(lintPrEvidence(`## Evidence\nExemption: none\n\nTest plan\n${underline}\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n${ARTIFACT_LABEL} https://example.test/shot.png`).ok, false);
  });
  test(`fields before setext boundary still supply valid Evidence ${underline}`, () => {
    assert.equal(lintPrEvidence(`## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n${ARTIFACT_LABEL} https://example.test/shot.png\n\nTest plan\n${underline}\nOther text`).ok, true);
  });
}
test('rejects duplicate visible Evidence sections', () => {
  const body = bodyWithEvidence('Exemption: docs-only\n- Exemption reason: Updated docs.') + '\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: http://192.168.1.80';
  assert.equal(lintPrEvidence(body).ok, false);
});
test('a fenced duplicate Evidence heading stays ignored', () => {
  assert.equal(lintPrEvidence(bodyWithEvidence('Exemption: docs-only\n- Exemption reason: Updated docs.') + '\n```text\n## Evidence\n```').ok, true);
});

for (const placeholder of ['&ZeroWidthSpace;', '&NoBreak;', '&NegativeThinSpace;', 'T&ZeroWidthSpace;ODO', '&MediumSpace;', '&ThickSpace;']) {
  for (const field of ['Steps followed to produce the evidence', 'Result observed', 'Exemption reason']) {
    test(`rejects named-entity placeholder ${placeholder} in ${field}`, () => {
      const body = field === 'Exemption reason'
        ? bodyWithEvidence(`Exemption: docs-only\n- Exemption reason: ${placeholder}`)
        : bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n${ARTIFACT_LABEL} trace.json`).replace(`${field}: ${field.startsWith('Steps') ? 'ran locally' : 'passed'}`, `${field}: ${placeholder}`);
      assert.equal(lintPrEvidence(body).ok, false);
    });
  }
}
for (const definition of ['[proof]: evidence/shot.png garbage', '[proof]: evidence/shot.png "title" garbage', '[proof]:\n  evidence/shot.png garbage', '[proof]: https://example.test/shot.png (title) garbage']) {
  test(`rejects invalid complete reference definition ${JSON.stringify(definition)}`, () => {
    assert.equal(lintPrEvidence(bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n${ARTIFACT_LABEL} [proof]\n\n${definition}`)).ok, false);
  });
}
for (const artifact of ['<span class="https://example.test/shot.png"></span>', '<span title="trace.json"></span>', '<span class=https://example.test/shot.png></span>', '<div data-artifact="https://example.test/shot.png"></div>']) {
  test(`ignores raw HTML artifact attributes ${artifact}`, () => {
    assert.equal(lintPrEvidence(bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n${ARTIFACT_LABEL} ${artifact}`)).ok, false);
  });
}
test('visible artifact URL inside an HTML span still counts', () => {
  assert.equal(lintPrEvidence(bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n${ARTIFACT_LABEL} <span>https://example.test/shot.png</span>`)).ok, true);
});
for (const definition of ['[proof]: evidence/shot.png "capture"', "[proof]: evidence/shot.png 'capture'", '[proof]: evidence/shot.png (capture)', '[proof]:\n  evidence/shot.png\n  "capture"', '[proof]: evidence/shot.png "multi\n  line capture"']) {
  test(`accepts complete reference title ${JSON.stringify(definition)}`, () => {
    assert.equal(lintPrEvidence(bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n${ARTIFACT_LABEL} [proof]\n\n${definition}`)).ok, true);
  });
}

for (const [definitions, ok] of [['[proof]: #\n[proof]: evidence/shot.png', false], ['[proof]: evidence/shot.png garbage\n[proof]: evidence/shot.png', true]]) {
  test(`first valid reference definition wins: ${JSON.stringify(definitions)}`, () => {
    assert.equal(lintPrEvidence(bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n${ARTIFACT_LABEL} [proof]\n\n${definitions}`)).ok, ok);
  });
}

for (const punctuation of ['.', '!', '…', '—', ':;()', '&rsquo;', '<em>...</em>', '[.](#)']) {
  for (const field of ['Steps followed to produce the evidence', 'Result observed', 'Exemption reason']) {
    test(`rejects punctuation-only ${punctuation} in ${field}`, () => {
      const body = field === 'Exemption reason'
        ? bodyWithEvidence(`Exemption: docs-only\n- Exemption reason: ${punctuation}`)
        : bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n${ARTIFACT_LABEL} trace.json`).replace(`${field}: ${field.startsWith('Steps') ? 'ran locally' : 'passed'}`, `${field}: ${punctuation}`);
      assert.equal(lintPrEvidence(body).ok, false);
    });
  }
}
for (const result of ['0', '✓ 3 checks', '成功', 'Готово']) {
  test(`accepts substantive Unicode letter/number result ${result}`, () => {
    assert.equal(lintPrEvidence(bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: ${result}\n${ARTIFACT_LABEL} trace.json`)).ok, true);
  });
}

for (const host of ['192.168.1.%38%30:8080', '0300.0250.1.0120', '3232235856', '0xc0a80150', '192.168.337', '192.168.1.81']) {
  test(`rejects normalized banned LAN host ${host}`, () => {
    assert.equal(lintPrEvidence(bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: curl http://${host}/a.png\n- Result observed: passed\n${ARTIFACT_LABEL} https://example.test/shot.png`)).ok, false);
  });
  test(`rejects normalized banned reference destination ${host}`, () => {
    assert.equal(lintPrEvidence('[target]: http://' + host + '/a.png\n\n' + bodyWithEvidence('Exemption: docs-only\n- Exemption reason: Updated docs.\n- Steps followed to produce the evidence: [target]')).ok, false);
  });
}
for (const tag of ['pre', 'script', 'style', 'textarea', 'div']) {
  test(`ignores Evidence heading inside raw HTML block ${tag}`, () => {
    assert.equal(lintPrEvidence(`<${tag}>\n## Evidence\nExemption: docs-only\n- Exemption reason: Updated docs.\n</${tag}>`).ok, false);
  });
  test(`raw HTML ${tag} content cannot supply missing artifact`, () => {
    assert.equal(lintPrEvidence(bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n${ARTIFACT_LABEL} screenshot\n\n<${tag}>\nhttps://example.test/shot.png\n</${tag}>`)).ok, false);
  });
}
for (const indentation of ['    ', '\t']) {
  test(`ignores indented code declarations ${JSON.stringify(indentation)}`, () => {
    assert.equal(lintPrEvidence('## Evidence\n' + indentation + 'Exemption: docs-only\n' + indentation + '- Exemption reason: changed docs').ok, false);
  });
}
for (const artifact of ['[](https://example.test/shot.png)', '[ ](https://example.test/shot.png)', '[&ZeroWidthSpace;](https://example.test/shot.png)']) {
  test(`rejects invisible non-image artifact link ${artifact}`, () => {
    assert.equal(lintPrEvidence(bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n${ARTIFACT_LABEL} ${artifact}`)).ok, false);
  });
}
test('empty-alt image artifact still renders and counts', () => {
  assert.equal(lintPrEvidence(bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n${ARTIFACT_LABEL} ![](https://example.test/shot.png)`)).ok, true);
});

for (const label of [' ', '&ZeroWidthSpace;']) {
  test(`rejects invisible reference-link artifact label ${label}`, () => {
    assert.equal(lintPrEvidence(bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n${ARTIFACT_LABEL} [${label}][proof]\n\n[proof]: https://example.test/shot.png`)).ok, false);
  });
}

for (const definition of ['> [target]: http://192.168.1.%38%30:8080', '- [target]: http://3232235856/', '1. [target]: http://0300.0250.1.0120/', '> - [target]: http://192.168.1.80/', '> [target]:\n> http://192.168.1.%38%30:8080', '- [target]:\n  http://192.168.1.80/']) {
  test(`rejects banned reference in block container ${JSON.stringify(definition)}`, () => {
    assert.equal(lintPrEvidence(definition + '\n\n' + bodyWithEvidence('Exemption: docs-only\n- Exemption reason: Updated docs.\n- Journey exercised: [preview][target]')).ok, false);
  });
}
for (const comment of ['<!-- hidden -->## Evidence', '<!-- hidden\nend -->## Evidence', '> <!-- hidden -->\n-->## Evidence']) {
  test(`block comment closing suffix cannot supply Evidence ${JSON.stringify(comment)}`, () => {
    assert.equal(lintPrEvidence(comment + '\nExemption: docs-only\n- Exemption reason: Updated docs.').ok, false);
  });
}
test('genuinely inline comment preserves its rendered suffix', () => {
  assert.equal(lintPrEvidence(bodyWithEvidence('Exemption: docs-only\n- Exemption reason: Updated <!-- hidden --> docs.')).ok, true);
});
test('unused quoted reference destination cannot supply proof', () => {
  assert.equal(lintPrEvidence(bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n${ARTIFACT_LABEL} screenshot\n\n> [unused]: https://example.test/shot.png`)).ok, false);
});

for (const definition of ['> [proof]: https://example.test/shot.png', '- [proof]: evidence/shot.png', '> [proof]:\n> https://example.test/shot.png']) {
  test(`accepts used valid container reference ${JSON.stringify(definition)}`, () => {
    assert.equal(lintPrEvidence(bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n${ARTIFACT_LABEL} [proof]\n\n${definition}`)).ok, true);
  });
}

for (const artifact of [String.raw`\![](https://example.test/shot.png)`, String.raw`\\\![](https://example.test/shot.png)`]) {
  test(`escaped image marker cannot credit invisible link ${artifact}`, () => {
    assert.equal(lintPrEvidence(bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n${ARTIFACT_LABEL} ${artifact}`)).ok, false);
  });
}
for (const host of ['3232235856', '0xc0a80151', '192.168.1.%38%30']) {
  for (const target of [`[preview](//${host}/)`, `//${host}/`]) {
    test(`rejects normalized protocol-relative target ${target}`, () => {
      assert.equal(lintPrEvidence(bodyWithEvidence(`Exemption: docs-only\n- Exemption reason: Updated docs.\n- Journey exercised: ${target}`)).ok, false);
    });
  }
  test(`rejects protocol-relative reference ${host}`, () => {
    assert.equal(lintPrEvidence(`[target]: //${host}/\n\n` + bodyWithEvidence('Exemption: docs-only\n- Exemption reason: Updated docs.\n- Journey exercised: [target]')).ok, false);
  });
}
for (const tag of ['<span>', '</span>', '<custom-tag data-proof="yes">', '<span data-proof="a > b">']) {
  test(`type-7 raw HTML hides fake Evidence ${tag}`, () => {
    assert.equal(lintPrEvidence(`${tag}\n## Evidence\nExemption: docs-only\n- Exemption reason: Updated docs.\n</span>`).ok, false);
  });
}
for (const definition of ['[foo]: /target "title\n  ## Evidence\n  "', '[foo]:\n  /target\n  "title\n  ## Evidence\n  "', '> [foo]: /target "title\n> ## Evidence\n> "']) {
  test(`reference title cannot supply Evidence ${JSON.stringify(definition)}`, () => {
    assert.equal(lintPrEvidence(definition + '\nExemption: docs-only\n- Exemption reason: Updated docs.').ok, false);
  });
  test(`reference title heading does not duplicate real Evidence ${JSON.stringify(definition)}`, () => {
    assert.equal(lintPrEvidence(definition + '\n\n' + bodyWithEvidence('Exemption: docs-only\n- Exemption reason: Updated docs.')).ok, true);
  });
}
test('type-7 inline tag cannot interrupt an ordinary paragraph', () => {
  assert.equal(lintPrEvidence('Intro\n<span>\n' + bodyWithEvidence('Exemption: docs-only\n- Exemption reason: Updated docs.')).ok, true);
});
test('even escaped backslashes leave the image marker active', () => {
  assert.equal(lintPrEvidence(bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n${ARTIFACT_LABEL} ${String.raw`\\![](https://example.test/shot.png)`}`)).ok, true);
});
for (const tag of ['<span>', '<custom-tag title="proof">']) {
  test(`type-7 HTML content cannot supply missing artifact ${tag}`, () => {
    assert.equal(lintPrEvidence(bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n${ARTIFACT_LABEL} screenshot\n\n${tag}\nhttps://example.test/shot.png\n</span>`)).ok, false);
  });
}
test('safe protocol-relative verification remains allowed', () => {
  assert.equal(lintPrEvidence(bodyWithEvidence('Exemption: docs-only\n- Exemption reason: Updated docs.\n- Journey exercised: [preview](//example.test/)')).ok, true);
});

for (const host of ['[::ffff:c0a8:150]', '[::ffff:192.168.1.80]', '[0:0:0:0:0:ffff:c0a8:151]']) {
  test(`rejects IPv4-mapped banned LAN target ${host}`, () => {
    assert.equal(lintPrEvidence(bodyWithEvidence(`Exemption: docs-only\n- Exemption reason: Updated docs.\n- Journey exercised: [preview](http://${host}/)`)).ok, false);
  });
  test(`rejects IPv4-mapped banned LAN reference ${host}`, () => {
    assert.equal(lintPrEvidence(`[target]: //${host}/\n\n` + bodyWithEvidence('Exemption: docs-only\n- Exemption reason: Updated docs.\n- Journey exercised: [target]')).ok, false);
  });
}
for (const wrapper of ['[x]', '![x]']) {
  test(`multiline link title cannot declare exemption ${wrapper}`, () => {
    assert.equal(lintPrEvidence(bodyWithEvidence(`${wrapper}(https://example.test "title\nExemption: docs-only\n- Exemption reason: Updated docs.\n")`)).ok, false);
  });
  test(`multiline link title cannot supply required result ${wrapper}`, () => {
    assert.equal(lintPrEvidence(bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: ran locally\n${wrapper}(https://example.test "title\n- Result observed: passed\n")\n${ARTIFACT_LABEL} trace.json`)).ok, false);
  });
  test(`multiline link title cannot supply Evidence heading ${wrapper}`, () => {
    assert.equal(lintPrEvidence(`${wrapper}(https://example.test "title\n## Evidence\n")\nExemption: docs-only\n- Exemption reason: Updated docs.`).ok, false);
  });
}
test('safe mapped IPv6 target remains allowed', () => {
  assert.equal(lintPrEvidence(bodyWithEvidence('Exemption: docs-only\n- Exemption reason: Updated docs.\n- Journey exercised: http://[::ffff:c000:201]/')).ok, true);
});
test('valid multiline title does not hide actual declarations', () => {
  assert.equal(lintPrEvidence(bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n${ARTIFACT_LABEL} [trace](https://example.test/a.png "first\nsecond")`)).ok, true);
});
