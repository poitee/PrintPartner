import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const repositoryTemplate = readFileSync(new URL("../.github/pull_request_template.md", import.meta.url), "utf8");

test("filled repository PR template passes evidence lint", () => {
  const filled = repositoryTemplate
    .replace("- Journey exercised:", "- Journey exercised: local lint verification")
    .replace("- Steps followed to produce the evidence:", "- Steps followed to produce the evidence: ran the lint self-tests locally")
    .replace("- Result observed:", "- Result observed: all tests passed")
    .replace("- Screenshot / recording / verify-skill output or trace:", "- Screenshot / recording / verify-skill output or trace: `node --test scripts/lint-pr-evidence.test.mjs`");
  const result = lintPrEvidence(filled);
  assert.equal(result.ok, true, result.errors.join("; "));
});

test("blank repository PR template fails with incomplete evidence", () => {
  const result = lintPrEvidence(repositoryTemplate);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /Evidence is incomplete/);
});

for (const suffix of ["80", "81"]) {
  const host = `http://192.168.200.${suffix}/`;
  for (const syntax of [
    `[x](${host}`,
    `[x] (${host})`,
    `[x] （${host}）`,
    `[target]: <${host}`,
    `[target] : ${host}`,
    `[target]: ${host} "unterminated title`,
    `[x](${host})`,
  ]) {
    test(`LAN scan rejects raw or malformed link syntax ${syntax}`, () => {
      const result = lintPrEvidence(bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n${syntax}`));
      assert.equal(result.ok, false);
      assert.match(result.errors.join("\n"), /LAN instances/);
    });
  }
  for (const malformed of ["[x](unfinished", "](unfinished", "[x](# \"unterminated title", "[x] (unfinished", "[x] （unfinished", "[broken]: <unfinished"]) {
    test(`LAN reference after malformed syntax remains checked: ${malformed}, .${suffix}`, () => {
      const result = lintPrEvidence(`[target]: ${host}\n\n` + bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n${malformed} [target]`));
      assert.equal(result.ok, false);
      assert.match(result.errors.join("\n"), /LAN instances/);
    });
  }
}

test("well-formed safe link does not resolve its label as a LAN reference", () => {
  const result = lintPrEvidence("[target]: http://192.168.200.80/\n\n" + bodyWithEvidence("Exemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[target](http://localhost:8080/)"));
  assert.equal(result.ok, true, result.errors.join("; "));
});

test("fenced verification commands reject every recognized banned LAN host form", () => {
  const targets = [
    "http://192.168.1.80:8080/", "http://192.168.200.81/",
    "http://192.168.1.%38%30/", "http://0300.0250.1.0120/",
    "http://3232235856/", "http://0xc0a80151/", "http://192.168.337/",
    "http://[::ffff:c0a8:150]/", "http://[::ffff:192.168.1.81]/",
    "http://[0:0:0:0:0:ffff:c0a8:151]/", "//192.168.1.81/",
    "http:3232235856", "http:/3232235856", "https:0xc0a80151",
    "http://192&#46;168&#46;1&#46;80/", String.raw`http://192\.168\.1\.81/`,
  ];
  for (const target of targets) {
    for (const [open, prefix, close] of [
      ["```sh", "", "```"], ["~~~sh", "", "~~~"],
      ["> ```sh", "> ", "> ```"], ["- ```sh", "  ", "  ```"],
      ["```sh", "", ""],
    ]) {
      const result = lintPrEvidence(bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: ran a local command\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n${open}\n${prefix}curl ${target}\n${close}`));
      assert.equal(result.ok, false, `${open}: ${target}`);
      assert.match(result.errors.join("\n"), /LAN instances/);
    }
  }
});

test("malformed hidden-element closers cannot hide later banned LAN references", () => {
  for (const tag of ["script", "style", "template", "head", "title"]) {
    for (const suffix of ["80", "81"]) {
      const result = lintPrEvidence(`[target]: http://192.168.200.${suffix}/\n\n` + bodyWithEvidence(`Exemption: docs-only\n- Exemption reason: Updated docs.\n- Journey exercised: <${tag}>hidden</${tag}\n<span>[target]</span>`));
      assert.equal(result.ok, false, `${tag}, .${suffix}`);
      assert.match(result.errors.join("\n"), /LAN instances/);
    }
  }
});

test("safe fenced commands cannot introduce metadata or section boundaries", () => {
  const result = lintPrEvidence(bodyWithEvidence("Exemption: none\n- Steps followed to produce the evidence: ran a local command\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\n## Evidence\nExemption: docs-only\ncurl http://localhost:8080/\n```"));
  assert.equal(result.ok, true, result.errors.join("; "));
});

test("fenced LAN commands outside Evidence remain outside the scan", () => {
  const result = lintPrEvidence(bodyWithEvidence("Exemption: docs-only\n- Exemption reason: Updated docs.") + "\n```sh\ncurl http://192.168.1.80/\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});

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

for (const definition of ['[foo]: /target "title\nExemption: docs-only\n- Exemption reason: Updated docs.\n"', '[foo]: /target\n  "title\nExemption: docs-only\n- Exemption reason: Updated docs.\n"']) {
  test(`reference definition title cannot supply exemption metadata ${JSON.stringify(definition)}`, () => {
    assert.equal(lintPrEvidence(bodyWithEvidence(definition)).ok, false);
  });
  test(`real exemption after reference title remains valid ${JSON.stringify(definition)}`, () => {
    assert.equal(lintPrEvidence(bodyWithEvidence(definition + '\n\nExemption: docs-only\n- Exemption reason: Actually updated docs.')).ok, true);
  });
}
for (const tag of ['<span title="', "<span title='", '<custom-tag data-proof="']) {
  const quote=tag.at(-1);
  test(`multiline inline HTML attributes cannot supply exemption ${tag}`, () => {
    assert.equal(lintPrEvidence(bodyWithEvidence(`Intro ${tag}\nExemption: docs-only\n- Exemption reason: Updated docs.\n${quote}>visible`)).ok, false);
  });
  test(`multiline inline HTML attributes cannot supply result ${tag}`, () => {
    assert.equal(lintPrEvidence(bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: ran locally\nIntro ${tag}\n- Result observed: passed\n${quote}>visible\n${ARTIFACT_LABEL} trace.json`)).ok, false);
  });
  test(`real declarations after multiline inline tag stay visible ${tag}`, () => {
    assert.equal(lintPrEvidence(bodyWithEvidence(`Intro ${tag}\nplaceholder\n${quote}>visible\nExemption: docs-only\n- Exemption reason: Updated docs.`)).ok, true);
  });
}

for (const journey of ['<span title="[proof]">journey</span>', '<span data-proof="[shot][proof]">journey</span>']) {
  test(`HTML attribute references cannot credit unused definition ${journey}`, () => {
    assert.equal(lintPrEvidence(bodyWithEvidence(`Exemption: none\n- Journey exercised: ${journey}\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n${ARTIFACT_LABEL} [proof]: evidence/shot.png`)).ok, false);
  });
}
for (const space of ['&#10;', '&#9;', '&#13;', '&NewLine;', '&Tab;']) {
  test(`rejects URL parser ignored whitespace ${space}`, () => {
    assert.equal(lintPrEvidence(bodyWithEvidence(`Exemption: docs-only\n- Exemption reason: Updated docs.\n- Journey exercised: <a href="http://3232${space}235856/">preview</a>`)).ok, false);
  });
}
for (const [open,close] of [['<?php','?>'],['<!DOCTYPE','>'],['<![CDATA[',']]>']]) {
  test(`inline HTML declaration cannot introduce exemption ${open}`, () => {
    assert.equal(lintPrEvidence(bodyWithEvidence(`Intro ${open}\nExemption: docs-only\n${close}\n- Exemption reason: Updated docs.`)).ok, false);
  });
  test(`real exemption after inline declaration remains valid ${open}`, () => {
    assert.equal(lintPrEvidence(bodyWithEvidence(`Intro ${open}\nexample\n${close}\nExemption: docs-only\n- Exemption reason: Updated docs.`)).ok, true);
  });
}
for (const ticks of ['`','``']) {
  test(`multiline code span cannot introduce exemption ${ticks}`, () => {
    assert.equal(lintPrEvidence(bodyWithEvidence(`${ticks}example\nExemption: docs-only\n${ticks}\n- Exemption reason: Updated docs.`)).ok, false);
  });
  test(`multiline code span cannot introduce a field ${ticks}`, () => {
    assert.equal(lintPrEvidence(bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: ran locally\n${ticks}example\n- Result observed: passed\n${ticks}\n${ARTIFACT_LABEL} trace.json`)).ok, false);
  });
}
for (const tag of ['style','script','template','head','title']) {
  test(`hidden element ${tag} cannot supply artifact`, () => {
    assert.equal(lintPrEvidence(bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n${ARTIFACT_LABEL} <${tag}>https://example.test/shot.png</${tag}>`)).ok, false);
  });
  test(`hidden element ${tag} cannot supply exemption reason`, () => {
    assert.equal(lintPrEvidence(bodyWithEvidence(`Exemption: docs-only\n- Exemption reason: <${tag}>Updated docs</${tag}>`)).ok, false);
  });
}
test('rendered reference label after raw tag remains valid proof', () => {
  assert.equal(lintPrEvidence(bodyWithEvidence(`Exemption: none\n- Journey exercised: <span title="example">[proof]</span>\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n${ARTIFACT_LABEL} [proof]: evidence/shot.png`)).ok, true);
});
test('real declaration after multiline code span stays visible', () => {
  assert.equal(lintPrEvidence(bodyWithEvidence('`example\nnot metadata`\nExemption: docs-only\n- Exemption reason: Updated docs.')).ok, true);
});
test('visible prose survives surrounding non-rendering elements', () => {
  assert.equal(lintPrEvidence(bodyWithEvidence('Exemption: docs-only\n- Exemption reason: Updated <style>hidden</style> docs.')).ok, true);
});
test('nested template content cannot supply artifact', () => {
  assert.equal(lintPrEvidence(bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n${ARTIFACT_LABEL} <template><template>hidden</template>https://example.test/shot.png</template>`)).ok, false);
});

for (const target of ['http:3232235856','http:/3232235856','https:0xc0a80151']) {
  test(`rejects normalized slashless HTTP target ${target}`, () => {
    assert.equal(lintPrEvidence(bodyWithEvidence(`Exemption: docs-only\n- Exemption reason: Updated docs.\n- Journey exercised: [preview](${target})`)).ok, false);
  });
}
for (const child of ['style','script','title']) {
  test(`raw text child ${child} keeps template inert`, () => {
    assert.equal(lintPrEvidence(bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n${ARTIFACT_LABEL} <template><${child}></template>https://example.test/shot.png</${child}></template>`)).ok, false);
  });
}
test('raw HTML decoy heading cannot truncate verification LAN scan', () => {
  assert.equal(lintPrEvidence(bodyWithEvidence('Exemption: docs-only\n- Exemption reason: Updated docs.\n\n<div>\n## Evidence\n</div>\n\n<div><a href="http://3232235856/">preview</a></div>')).ok, false);
});
test('raw HTML decoy heading cannot hide later mapped LAN target', () => {
  assert.equal(lintPrEvidence(bodyWithEvidence('Exemption: docs-only\n- Exemption reason: Updated docs.\n\n<div>\n## Other\n</div>\n\n<div><a href="http://[::ffff:c0a8:151]/">preview</a></div>')).ok, false);
});
test('raw LAN scan stops at actual outer section boundary', () => {
  assert.equal(lintPrEvidence(bodyWithEvidence('Exemption: docs-only\n- Exemption reason: Updated docs.\n\n<div>\n## Evidence\n</div>\n\n## Background\n<div><a href="http://3232235856/">old deployment</a></div>')).ok, true);
});
test('reference definition cannot supply exemption reason', () => {
  assert.equal(lintPrEvidence(bodyWithEvidence('Exemption: docs-only\n- Exemption reason:\n  [reason]: /updated-docs')).ok, false);
});
for (const field of ['Steps followed to produce the evidence','Result observed']) {
  test(`reference definition cannot supply required field ${field}`, () => {
    const steps=field.startsWith('Steps')?'\n  [steps]: /ran-locally':'ran locally';
    const result=field.startsWith('Result')?'\n  [result]: /passed':'passed';
    assert.equal(lintPrEvidence(bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: ${steps}\n- Result observed: ${result}\n${ARTIFACT_LABEL} trace.json`)).ok, false);
  });
}
test('visible reason after reference definition remains substantive', () => {
  assert.equal(lintPrEvidence(bodyWithEvidence('Exemption: docs-only\n- Exemption reason:\n  [reason]: /updated-docs\n\n  Updated docs.')).ok, true);
});
test('visible artifact after nested hidden raw-text child remains valid', () => {
  assert.equal(lintPrEvidence(bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n${ARTIFACT_LABEL} <template><style>hidden</style></template> https://example.test/shot.png`)).ok, true);
});
test('safe slashless HTTP verification target remains allowed', () => {
  assert.equal(lintPrEvidence(bodyWithEvidence('Exemption: docs-only\n- Exemption reason: Updated docs.\n- Journey exercised: [preview](http:example.test)')).ok, true);
});

for (const artifact of ['[][proof]', '[ ][proof]', String.raw`\![][proof]`]) {
  test(`empty full-reference link cannot supply artifact ${artifact}`, () => {
    assert.equal(lintPrEvidence(bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n${ARTIFACT_LABEL} ${artifact}\n\n[proof]: https://example.test/shot.png`)).ok, false);
  });
}
test('empty-alt full-reference image remains visible proof', () => {
  assert.equal(lintPrEvidence(bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n${ARTIFACT_LABEL} ![][proof]\n\n[proof]: https://example.test/shot.png`)).ok, true);
});
for (const entity of ['&#x2F','&#47']) {
  test(`HTML target decodes semicolonless numeric slash ${entity}`, () => {
    assert.equal(lintPrEvidence(bodyWithEvidence(`Exemption: docs-only\n- Exemption reason: Updated docs.\n- Journey exercised: <a href="http:${entity}/3232235856">preview</a>`)).ok, false);
  });
}
for (const definition of ['[ref]: /target', '[ref]: /target "title\nmore title"', '> [ref]: /target']) {
  test(`reference block boundary allows type-7 HTML ${JSON.stringify(definition)}`, () => {
    assert.equal(lintPrEvidence(`${definition}\n<span>\n## Evidence\nExemption: docs-only\n- Exemption reason: Updated docs.\n</span>`).ok, false);
  });
}
test('invalid reference prefix remains paragraph text before inline span', () => {
  assert.equal(lintPrEvidence('[ref]: /target garbage\n<span>\n## Evidence\nExemption: docs-only\n- Exemption reason: Updated docs.').ok, true);
});

test("fenced exemption-like lines cannot suppress literal LAN targets", () => {
  for (const target of ["http://192.168.1.80/", "http://0xc0a80151/"]) {
    for (const command of [
      `- Exemption reason: command output\n  curl ${target}`,
      `Exemption: curl ${target}`,
    ]) {
      const result = lintPrEvidence(bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n\`\`\`text\n${command}\n\`\`\``));
      assert.equal(result.ok, false, command);
      assert.match(result.errors.join("\n"), /LAN instances/);
    }
  }
});

test("indented verification commands reject literal LAN targets", () => {
  for (const target of ["http://192.168.1.80/", "http://0xc0a80151/"]) {
    for (const command of [
      `Verification command:\n\n    curl ${target}\n    echo done`,
      `- Verification command:\n\n      curl ${target}\n      echo done`,
      `Verification command:\n\n    echo start\n    curl ${target}`,
      `Verification command:\n\n\tcurl ${target}`,
      `Verification command:\n\n    Exemption: curl ${target}`,
      `Verification command:\n\n    - Exemption reason: command output\n      curl ${target}`,
    ]) {
      const result = lintPrEvidence(bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n${command}`));
      assert.equal(result.ok, false, command);
      assert.match(result.errors.join("\n"), /LAN instances/);
    }
  }
});

test("literal code labels do not resolve document-wide LAN references", () => {
  for (const code of ["```text\n[target]\n```", "Verification command:\n\n    [target]", "- Verification command:\n\n      [target]"]) {
    const result = lintPrEvidence("[target]: http://192.168.1.80/\n\n" + bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n${code}`));
    assert.equal(result.ok, true, result.errors.join("; "));
  }
  const result = lintPrEvidence("[target]: http://192.168.1.80/\n\n" + bodyWithEvidence("Exemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[target]"));
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /LAN instances/);
});

test("indented LAN commands outside Evidence remain outside the scan", () => {
  const result = lintPrEvidence(bodyWithEvidence("Exemption: docs-only\n- Exemption reason: Updated docs.") + "\nVerification command:\n\n    curl http://192.168.1.80/\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});

test("safe indented code cannot introduce metadata or section boundaries", () => {
  const result = lintPrEvidence(bodyWithEvidence("Exemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\nVerification command:\n\n    ## Evidence\n    Exemption: docs-only\n    curl http://localhost:8080/"));
  assert.equal(result.ok, true, result.errors.join("; "));
});

test("real exemption reasons retain literal code mentions", () => {
  for (const code of ["  ```text\n  http://192.168.1.80/\n  ```", "      http://192.168.1.80/"]) {
    const result = lintPrEvidence(bodyWithEvidence(`Exemption: docs-only\n- Exemption reason: Document the prohibited host.\n\n${code}`));
    assert.equal(result.ok, true, result.errors.join("; "));
  }
});

test("a top-level fence ends a real exemption reason before indented code", () => {
  for (const code of ["  curl http://192.168.1.80/", "  Exemption: curl http://0xc0a80151/", "  - Exemption reason: output\n    curl http://192.168.1.81/"]) {
    for (const gap of ["\n", "\n\n"]) {
      const result = lintPrEvidence(bodyWithEvidence(`Exemption: docs-only\n- Exemption reason: Updated docs.${gap}\`\`\`text\n${code}\n\`\`\``));
      assert.equal(result.ok, false, code);
      assert.match(result.errors.join("\n"), /LAN instances/);
    }
  }
});

for (const [name, open, close] of [
  ["processing instruction", "<?php", "?>"],
  ["declaration", "<!DOCTYPE", ">"],
  ["CDATA", "<![CDATA[", "]]>"],
]) {
  test(`raw HTML ${name} retains fake Evidence across blank lines`, () => {
    const body = `${open}\n\n## Evidence\nExemption: docs-only\n- Exemption reason: Updated docs.`;
    const result = lintPrEvidence(body);
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /Missing "## Evidence" section/);
    const run = spawnSync(process.execPath, [fileURLToPath(new URL("./lint-pr-evidence.mjs", import.meta.url)), "--stdin"], { input: body, encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /Missing "## Evidence" section/);
  });

  test(`raw HTML ${name} ends on its terminator before real Evidence`, () => {
    for (const block of [`${open} example ${close}`, `${open}\n\nexample\n${close}`]) {
      const result = lintPrEvidence(`${block}\n## Evidence\nExemption: docs-only\n- Exemption reason: Updated docs.`);
      assert.equal(result.ok, true, result.errors.join("; "));
    }
  });

  test(`raw HTML ${name} keeps fake metadata hidden until its terminator`, () => {
    const result = lintPrEvidence(`${open}\n\n## Evidence\nExemption: invalid\n${close}\n## Evidence\nExemption: docs-only\n- Exemption reason: Updated docs.`);
    assert.equal(result.ok, true, result.errors.join("; "));
  });
}

test("ordinary HTML blocks still end on blank lines", () => {
  for (const tag of ["<div>", "<span>"]) {
    const result = lintPrEvidence(`${tag}\n\n## Evidence\nExemption: docs-only\n- Exemption reason: Updated docs.`);
    assert.equal(result.ok, true, result.errors.join("; "));
  }
});

for (const suffix of ["80", "81"]) {
  test(`scheme-less numeric host ${suffix} is rejected in verification code`, () => {
    for (const target of [`192.168.${suffix}:8080/`, `192.168.${suffix}/health`, `192.168.${suffix}:8080`, `192.168.${suffix}`]) {
      for (const command of [
        `Verification command:\n\n    curl ${target}`,
        `- Verification command:\n\n      curl '${target}'`,
        `\`\`\`sh\ncurl "${target}"\n\`\`\``,
        `Ran \`curl ${target}\`.`,
        `Target (${target}),`,
      ]) {
        const body = bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n${ARTIFACT_LABEL} trace.json\n\n${command}`);
        const result = lintPrEvidence(body);
        assert.equal(result.ok, false, command);
        assert.match(result.errors.join("\n"), /LAN instances/);
      }
    }
    const body = bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n${ARTIFACT_LABEL} trace.json\n\n    curl 192.168.${suffix}:8080/`);
    const run = spawnSync(process.execPath, [fileURLToPath(new URL("./lint-pr-evidence.mjs", import.meta.url)), "--stdin"], { input: body, encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /LAN instances/);
  });
}

test("scheme-less numeric scanning preserves safe targets and non-host text", () => {
  for (const text of [
    "curl 192.168.82:8080/", "curl 127.1:8080/", "curl 10.0.80:8080/",
    "curl 192.168.80.example.test:8080/", "curl https://example.test/192.168.80:8080/",
    "cat evidence/192.168.80/trace.json", "Build 3232235600 passed.",
    "Version release192.168.80 is recorded.", "192.168.80-release", "192.168.80:99999/",
  ]) {
    const result = lintPrEvidence(bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n${ARTIFACT_LABEL} trace.json\n\n\`\`\`text\n${text}\n\`\`\``));
    assert.equal(result.ok, true, `${text}: ${result.errors.join("; ")}`);
  }
});

test("scheme-less host scanning preserves reasons and document reference scope", () => {
  for (const text of ["192.168.80:8080/", "192.168.81:8080/"]) {
    for (const code of [`  \`\`\`text\n  curl ${text}\n  \`\`\``, `      curl ${text}`]) {
      const result = lintPrEvidence(bodyWithEvidence(`Exemption: docs-only\n- Exemption reason: Document the prohibited target.\n\n${code}`));
      assert.equal(result.ok, true, result.errors.join("; "));
    }
    const result = lintPrEvidence(bodyWithEvidence("Exemption: docs-only\n- Exemption reason: Updated docs.") + `\n    curl ${text}`);
    assert.equal(result.ok, true, result.errors.join("; "));
  }
  const base = bodyWithEvidence(`Exemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n${ARTIFACT_LABEL} trace.json\n\n\`\`\`text\n[target]\n\`\`\``);
  assert.equal(lintPrEvidence(`[target]: http://192.168.0.80/\n\n${base}`).ok, true);
  const real = lintPrEvidence(`[target]: http://192.168.0.80/\n\n${base.replace("```text\n[target]\n```", "[target]")}`);
  assert.equal(real.ok, false);
  assert.match(real.errors.join("\n"), /LAN instances/);
});

for (const suffix of ["80", "81"]) {
  const base = "## Evidence\nExemption: docs-only\n- Exemption reason: Updated docs.\n\n";
  const host = `http://192.168.1.${suffix}/`;
  for (const [name, payload] of [
    ["shell continuation", "```sh\ncurl http://192.168.1.\\\n" + suffix + ":8080/\n```"],
    ["scheme-less shell continuation", "```sh\ncurl 192.168.\\\n" + suffix + ":8080/\n```"],
    ["double-quoted shell continuation", '```sh\ncurl "http://192.168.1.\\\n' + suffix + '/"\n```'],
    ["comment suffix", "<!-- note -->curl " + host],
    ["multiline comment suffix", "<!-- note\nmore -->curl " + host],
    ["comment suffix declaration", "<!-- note -->Exemption: curl " + host],
    ["comment suffix reason", "<!-- note -->- Exemption reason: curl " + host],
    ["raw pre declaration", "<pre>\nExemption: curl " + host + "\n</pre>"],
    ["raw pre reason", "<pre>\n- Exemption reason: sample\n  curl " + host + "\n</pre>"],
    ["raw pre indented label", "<pre>\n    Exemption: curl " + host + "\n</pre>"],
    ["raw block declaration", "<div>\nExemption: curl " + host + "\n</div>"],
    ["raw block fake fence reason", "<pre>\n```\n- Exemption reason: sample\n  curl " + host + "\n```\n</pre>"],
  ]) {
    test(`literal payload context rejects ${name} .${suffix}`, () => {
      const result = lintPrEvidence(base + payload);
      assert.equal(result.ok, false);
      assert.match(result.errors.join("\n"), /LAN instances/);
    });
  }
}

for (const [name, payload] of [
  ["hidden comment", "<!-- curl http://192.168.1.80/ -->curl http://localhost:8080/"],
  ["continued local host", "```sh\ncurl http://local\\\nhost:8080/\n```"],
  ["continued safe numeric host", "```sh\ncurl 192.168.\\\n82/\n```"],
  ["continued safe path", "```sh\ncurl https://example.test/192.168.\\\n80/\n```"],
  ["single-quoted literal newline", "```sh\nprintf '%s' 'http://192.168.1.\\\n80/'\n```"],
  ["separate numeric arguments", "```sh\nprintf '%s' 192.168.1.\\\n 80/\n```"],
  ["safe raw label", "<pre>\nExemption: curl http://localhost:8080/\n</pre>"],
]) {
  test(`literal payload context preserves ${name}`, () => {
    const result = lintPrEvidence("## Evidence\nExemption: docs-only\n- Exemption reason: Updated docs.\n\n" + payload);
    assert.equal(result.ok, true, result.errors.join("; "));
  });
}

for (const payload of [
  "  <pre>\n  Exemption: http://192.168.1.80/\n  </pre>",
  "  <!-- note -->http://192.168.1.80/",
  "  <!-- note\n  -->http://192.168.1.80/",
  "  ```sh\n  curl http://192.168.1.\\\n  80/\n  ```",
]) {
  test(`literal payload context keeps actual reason ownership ${JSON.stringify(payload)}`, () => {
    const result = lintPrEvidence("## Evidence\nExemption: docs-only\n- Exemption reason: Document the prohibited host.\n\n" + payload);
    assert.equal(result.ok, true, result.errors.join("; "));
  });
}

for (const [name, payload, ok] of [
  ["raw hidden comment", "<pre>\n<!-- http://192.168.1.80/ -->\ncurl http://localhost/\n</pre>", true],
  ["raw multiline comment", "<pre>\n<!-- hidden\nhttp://192.168.1.80/\n-->curl http://localhost/\n</pre>", true],
  ["separate fences", "```sh\ncurl http://192.168.1.\\\n```\n```text\n80/\n```", true],
  ["suffix second comment", "<!-- note -->safe <!--\nhttp://192.168.1.80/\n-->", true],
  ["suffix fake indentation", "<!-- note -->  Exemption: curl http://192.168.1.80/", false],
  ["suffix empty boundary", "<!-- note -->\n  Exemption: curl http://192.168.1.80/", false],
]) {
  test(`literal payload boundary preserves ${name}`, () => {
    const result = lintPrEvidence("## Evidence\nExemption: docs-only\n- Exemption reason: Updated docs.\n" + payload);
    assert.equal(result.ok, ok, result.errors.join("; "));
    if (!ok) assert.match(result.errors.join("\n"), name === "suffix empty boundary" ? /exactly one Exemption/ : /LAN instances/);
  });
}

for (const [name, payload, ok] of [
  ["comment apostrophe", "# don't run remotely\ncurl http://192.168.1.\\\n80/", false],
  ["escaped backslash", "curl http://192.168.1.\\\\\n80/", true],
  ["CRLF continuation", "curl http://192.168.1.\\\r\n81/", false],
]) {
  test(`shell continuation context handles ${name}`, () => {
    const result = lintPrEvidence("## Evidence\nExemption: docs-only\n- Exemption reason: Updated docs.\n\n```sh\n" + payload + "\n```");
    assert.equal(result.ok, ok, result.errors.join("; "));
    if (!ok) assert.match(result.errors.join("\n"), /LAN instances/);
  });
}

test("r4 regression shell-double-fragment-80", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl http://192.168.1.8\"0\":8080/\n```");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r4 regression shell-single-fragment-80", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl http://192.168.1.8'0':8080/\n```");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r4 regression shell-mixed-fragments-80", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl 'http://'\"192.168.\"1.8'0':8080/\n```");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r4 regression shell-schemeless-fragment-80", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl 192.168.8\"0\":8080/\n```");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r4 regression shell-quoted-argument-80", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl \"http://192.168.1.8\"'0/' \n```");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r4 regression shell-continuation-fragment-80", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl http://192.168.1.8\\\n\"0\":8080/\n```");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r4 regression shell-double-fragment-81", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl http://192.168.1.8\"1\":8080/\n```");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r4 regression shell-single-fragment-81", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl http://192.168.1.8'1':8080/\n```");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r4 regression shell-mixed-fragments-81", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl 'http://'\"192.168.\"1.8'1':8080/\n```");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r4 regression shell-schemeless-fragment-81", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl 192.168.8\"1\":8080/\n```");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r4 regression shell-quoted-argument-81", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl \"http://192.168.1.8\"'1/' \n```");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r4 regression shell-continuation-fragment-81", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl http://192.168.1.8\\\n\"1\":8080/\n```");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r4 regression shell-safe-separate-arguments", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl http://192.168.1.8 \"0\":8080/\n```");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r4 regression shell-safe-quoted-space", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl \"http://192.168.1.8 0\":8080/\n```");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r4 regression shell-safe-prose", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nThe prefix http://192.168.1.8 and \"0\":8080/ are separate examples.\n```");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r4 regression shell-safe-quoted-prose", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nprintf '%s' 'prefix http://192.168.1.8'\"0\"\n```");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r4 regression shell-safe-escaped-quote", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl http://192.168.1.8\\\"0\\\":8080/\n```");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r4 regression shell-safe-unclosed-quote", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl http://192.168.1.8\"0:8080/\n```");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r4 regression shell-safe-safe-target", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl http://192.168.1.8\"2\":8080/\n```");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r4 regression shell-safe-single-literal-backslash", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl 'http://192.168.1.8\\2/'\n```");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r4 regression shell-safe-separate-command", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl http://192.168.1.8; echo \"0\":8080/\n```");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r4 regression title-double-80-False", () => {
  const result = lintPrEvidence("[outer]: https://example.test/outer \"title\n[target]: https://example.test/safe\nend\"\n\n[target]: http://192.168.1.80/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[target]");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r4 regression title-double-80-True", () => {
  const result = lintPrEvidence("[outer]: https://example.test/outer\n\"title\n[target]: https://example.test/safe\nend\"\n\n[target]: http://192.168.1.80/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[target]");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r4 regression title-double-81-False", () => {
  const result = lintPrEvidence("[outer]: https://example.test/outer \"title\n[target]: https://example.test/safe\nend\"\n\n[target]: http://192.168.1.81/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[target]");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r4 regression title-double-81-True", () => {
  const result = lintPrEvidence("[outer]: https://example.test/outer\n\"title\n[target]: https://example.test/safe\nend\"\n\n[target]: http://192.168.1.81/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[target]");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r4 regression title-single-80-False", () => {
  const result = lintPrEvidence("[outer]: https://example.test/outer 'title\n[target]: https://example.test/safe\nend'\n\n[target]: http://192.168.1.80/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[target]");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r4 regression title-single-80-True", () => {
  const result = lintPrEvidence("[outer]: https://example.test/outer\n'title\n[target]: https://example.test/safe\nend'\n\n[target]: http://192.168.1.80/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[target]");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r4 regression title-single-81-False", () => {
  const result = lintPrEvidence("[outer]: https://example.test/outer 'title\n[target]: https://example.test/safe\nend'\n\n[target]: http://192.168.1.81/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[target]");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r4 regression title-single-81-True", () => {
  const result = lintPrEvidence("[outer]: https://example.test/outer\n'title\n[target]: https://example.test/safe\nend'\n\n[target]: http://192.168.1.81/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[target]");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r4 regression title-parenthesized-80-False", () => {
  const result = lintPrEvidence("[outer]: https://example.test/outer (title\n[target]: https://example.test/safe\nend)\n\n[target]: http://192.168.1.80/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[target]");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r4 regression title-parenthesized-80-True", () => {
  const result = lintPrEvidence("[outer]: https://example.test/outer\n(title\n[target]: https://example.test/safe\nend)\n\n[target]: http://192.168.1.80/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[target]");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r4 regression title-parenthesized-81-False", () => {
  const result = lintPrEvidence("[outer]: https://example.test/outer (title\n[target]: https://example.test/safe\nend)\n\n[target]: http://192.168.1.81/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[target]");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r4 regression title-parenthesized-81-True", () => {
  const result = lintPrEvidence("[outer]: https://example.test/outer\n(title\n[target]: https://example.test/safe\nend)\n\n[target]: http://192.168.1.81/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[target]");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r4 regression title-first-safe", () => {
  const result = lintPrEvidence("[target]: https://example.test/first\n\n[outer]: https://example.test/outer \"title\n[target]: http://192.168.1.80/\nend\"\n\n[target]: http://192.168.1.81/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[target]");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r4 regression title-first-banned", () => {
  const result = lintPrEvidence("[target]: http://192.168.1.80/\n\n[target]: https://example.test/safe\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[target]");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r4 regression title-duplicate-outer-title", () => {
  const result = lintPrEvidence("[outer]: https://example.test/first\n\n[outer]: https://example.test/duplicate \"title\n[target]: https://example.test/safe\nend\"\n\n[target]: http://192.168.1.80/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[target]");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r4 regression title-invalid-title", () => {
  const result = lintPrEvidence("[outer]: https://example.test/outer \"unterminated\n\n[target]: http://192.168.1.80/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[target]");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r4 regression title-unused-reference", () => {
  const result = lintPrEvidence("[outer]: https://example.test/outer \"title\n[target]: https://example.test/safe\nend\"\n\n[target]: http://192.168.1.80/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[outer]");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r4 regression exact-shell-quote", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl http://192.168.1.8\"0\":8080/\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r4 regression exact-reference-title", () => {
  const result = lintPrEvidence("[outer]: https://example.test/outer \"title\n[target]: https://example.test/safe\nend\"\n\n[target]: http://192.168.1.80/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[target]\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});

test("r5 regression exact-ansi-c", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl http://192.168.1.$'80':8080/\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r5 regression exact-unicode-fold", () => {
  const result = lintPrEvidence("[SS]: http://192.168.1.80/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[ẞ]\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r5 regression exact-multiline-label", () => {
  const result = lintPrEvidence("[Foo\n  bar]: http://192.168.1.80/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[Baz][Foo bar]\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r5 regression ansi-octal-80", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl http://192.168.1.$'\\070\\060':8080/\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r5 regression ansi-hex-80", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl http://192.168.1.$'\\x38\\x30':8080/\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r5 regression ansi-unicode-80", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl http://192.168.1.$'\\u0038\\U00000030':8080/\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r5 regression ansi-mixed-80", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl http://192.168.1.$'8'\"0\":8080/\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r5 regression ansi-nul-80", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl http://192.168.1.$'8\\0ignored'0:8080/\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r5 regression ansi-nul-hex-80", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl http://192.168.1.$'8\\x00ignored'0:8080/\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r5 regression ansi-control-nul-80", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl http://192.168.1.$'8\\c@ignored'0:8080/\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r5 regression ansi-schemeless-80", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl 192.168.$'80':8080/\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r5 regression ansi-escaped-quote-80", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl $'http://192.168.1.8\\'ignored'0:8080/\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r5 regression ansi-octal-81", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl http://192.168.1.$'\\070\\061':8080/\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r5 regression ansi-hex-81", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl http://192.168.1.$'\\x38\\x31':8080/\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r5 regression ansi-unicode-81", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl http://192.168.1.$'\\u0038\\U00000031':8080/\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r5 regression ansi-mixed-81", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl http://192.168.1.$'8'\"1\":8080/\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r5 regression ansi-nul-81", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl http://192.168.1.$'8\\0ignored'1:8080/\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r5 regression ansi-nul-hex-81", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl http://192.168.1.$'8\\x00ignored'1:8080/\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r5 regression ansi-control-nul-81", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl http://192.168.1.$'8\\c@ignored'1:8080/\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r5 regression ansi-schemeless-81", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl 192.168.$'81':8080/\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r5 regression ansi-escaped-quote-81", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl $'http://192.168.1.8\\'ignored'1:8080/\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r5 regression ansi-safe-separate", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl http://192.168.1.8 $'0':8080/\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r5 regression ansi-safe-double-context", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl \"http://192.168.1.$'80':8080/\"\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r5 regression ansi-safe-single-context", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl 'http://192.168.1.$80':8080/\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r5 regression ansi-safe-escaped-dollar", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl http://192.168.1.\\$'80':8080/\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r5 regression ansi-safe-unknown-escape", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl http://192.168.1.$'8\\q0':8080/\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r5 regression ansi-safe-unknown-numeric", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl http://192.168.1.$'8\\80':8080/\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r5 regression ansi-safe-missing-hex", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl http://192.168.1.$'8\\x0g':8080/\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r5 regression ansi-safe-literal-backslash", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl http://192.168.1.$'8\\\\0':8080/\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r5 regression ansi-safe-newline", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl http://192.168.1.$'8\\n0':8080/\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r5 regression ansi-safe-tab", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl http://192.168.1.$'8\\t0':8080/\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r5 regression ansi-safe-control", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl http://192.168.1.$'8\\cA0':8080/\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r5 regression ansi-safe-escape", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl http://192.168.1.$'8\\e0':8080/\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r5 regression ansi-safe-nul-safe", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl http://192.168.1.$'8\\0ignored'2:8080/\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r5 regression ansi-safe-empty", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl http://192.168.1.$'':8080/\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r5 regression ansi-safe-unfinished", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl http://192.168.1.$'80:8080/\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r5 regression ansi-safe-prose", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nThe prefix http://192.168.1.8 and $'0' are separate examples.\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r5 regression ansi-safe-quoted-prose", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nprintf '%s' $'prefix http://192.168.1.8'0\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r5 regression ansi-safe-safe-local", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl $'http://127.0.0.\\061':8080/\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r5 regression ansi-safe-dynamic", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl http://192.168.1.$HOST:8080/\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r5 regression fold-sharp-s", () => {
  const result = lintPrEvidence("[Straße]: http://192.168.1.81/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[x][STRASSE]\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r5 regression fold-sigma", () => {
  const result = lintPrEvidence("[ΟΣ]: http://192.168.1.81/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[x][οσ]\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r5 regression fold-final-sigma", () => {
  const result = lintPrEvidence("[οσ]: http://192.168.1.81/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[x][ος]\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r5 regression fold-ligature", () => {
  const result = lintPrEvidence("[ﬃ]: http://192.168.1.81/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[x][FFI]\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r5 regression fold-long-s", () => {
  const result = lintPrEvidence("[ſ]: http://192.168.1.81/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[x][S]\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r5 regression fold-cherokee", () => {
  const result = lintPrEvidence("[Ꭰ]: http://192.168.1.81/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[x][ꭰ]\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r5 regression fold-dotted-i", () => {
  const result = lintPrEvidence("[İ]: http://192.168.1.81/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[x][i̇]\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r5 regression fold-armenian", () => {
  const result = lintPrEvidence("[և]: http://192.168.1.81/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[x][ԵՒ]\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r5 regression fold-greek-expand", () => {
  const result = lintPrEvidence("[ΐ]: http://192.168.1.81/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[x][ΐ]\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r5 regression fold-safe-dotless", () => {
  const result = lintPrEvidence("[ı]: http://192.168.1.80/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[x][I]\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r5 regression fold-safe-width", () => {
  const result = lintPrEvidence("[Ａ]: http://192.168.1.80/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[x][a]\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r5 regression fold-safe-circle", () => {
  const result = lintPrEvidence("[ⓐ]: http://192.168.1.80/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[x][a]\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r5 regression fold-safe-accent", () => {
  const result = lintPrEvidence("[é]: http://192.168.1.80/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[x][e]\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r5 regression fold-safe-canonical", () => {
  const result = lintPrEvidence("[é]: http://192.168.1.80/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[x][é]\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r5 regression fold-first-safe", () => {
  const result = lintPrEvidence("[Straße]: https://example.test/first\n[STRASSE]: http://192.168.1.80/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[straße]");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r5 regression fold-first-banned", () => {
  const result = lintPrEvidence("[STRASSE]: http://192.168.1.80/\n[Straße]: https://example.test/second\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[straße]");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r5 regression span-next-destination", () => {
  const result = lintPrEvidence("[Foo\n bar]:\n <http://192.168.1.81/>\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[Foo bar]\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r5 regression span-many-lines", () => {
  const result = lintPrEvidence("[Foo\n bar\n baz]: http://192.168.1.80/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[x][Foo bar baz]\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r5 regression span-multiline-use", () => {
  const result = lintPrEvidence("[Foo bar]: http://192.168.1.80/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[x][Foo\n bar]\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r5 regression span-shortcut-use", () => {
  const result = lintPrEvidence("[Foo bar]: http://192.168.1.80/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[Foo\n bar]\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r5 regression span-escaped-close", () => {
  const result = lintPrEvidence("[Foo\\]\n bar]: http://192.168.1.80/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[x][Foo\\] bar]\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r5 regression span-escaped-open", () => {
  const result = lintPrEvidence("[Foo\\[\n bar]: http://192.168.1.80/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[x][Foo\\[ bar]\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r5 regression span-title", () => {
  const result = lintPrEvidence("[Foo\n bar]: https://example.test/outer \"title\n[target]: https://example.test/fake\nend\"\n[target]: http://192.168.1.80/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[target]\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r5 regression span-title-heading", () => {
  const result = lintPrEvidence("[Foo\n bar]: https://example.test/outer \"title\n## Evidence\nExemption: ci-only\nend\"\n[target]: http://192.168.1.80/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[target]\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r5 regression span-title-duplicate", () => {
  const result = lintPrEvidence("[Foo bar]: https://example.test/first\n[Foo\n bar]: https://example.test/outer \"title\n[target]: https://example.test/fake\nend\"\n[target]: http://192.168.1.80/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[target]\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r5 regression span-blank-invalid-title", () => {
  const result = lintPrEvidence("[outer\n label]: https://example.test/outer \"unterminated\n\n[target]: http://192.168.1.80/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[target]\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r5 regression span-safe-safe", () => {
  const result = lintPrEvidence("[Foo\n bar]: http://127.0.0.1/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[Foo bar]\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r5 regression span-safe-unused", () => {
  const result = lintPrEvidence("[Foo\n bar]: http://192.168.1.80/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[other]\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r5 regression span-safe-blank-label", () => {
  const result = lintPrEvidence("[Foo\n\n bar]: http://192.168.1.80/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[Foo bar]\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r5 regression span-safe-nested", () => {
  const result = lintPrEvidence("[Foo[\n bar]: http://192.168.1.80/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[Foo[ bar]\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r5 regression span-safe-empty", () => {
  const result = lintPrEvidence("[ \n ]: http://192.168.1.80/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[ ]\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r5 regression span-safe-missing-colon", () => {
  const result = lintPrEvidence("[Foo\n bar] http://192.168.1.80/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[Foo bar]\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r5 regression span-safe-bad-tail", () => {
  const result = lintPrEvidence("[Foo\n bar]: http://192.168.1.80/ garbage\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[Foo bar]\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r5 regression span-safe-escaped-use", () => {
  const result = lintPrEvidence("[Foo\n bar]: http://192.168.1.80/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n\\[Foo bar]\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r5 regression span-safe-inline-code", () => {
  const result = lintPrEvidence("[Foo\n bar]: http://192.168.1.80/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n`[Foo bar]`\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r5 regression span-safe-title-only", () => {
  const result = lintPrEvidence("[outer\n label]: https://example.test/outer \"title\n[target]: http://192.168.1.80/\nend\"\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[target]\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r5 regression span-safe-first-safe", () => {
  const result = lintPrEvidence("[Foo bar]: https://example.test/first\n[Foo\n bar]: http://192.168.1.80/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[Foo bar]\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r5 regression span-code-definition", () => {
  const result = lintPrEvidence("```md\n[Foo\n bar]: http://192.168.1.80/\n```\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[Foo bar]");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r5 regression span-html-definition", () => {
  const result = lintPrEvidence("<script>\n[Foo\n bar]: http://192.168.1.80/\n</script>\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[Foo bar]");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r5 regression span-reason-use", () => {
  const result = lintPrEvidence("[Foo\n bar]: http://192.168.1.80/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n- Exemption reason: historical\n  [Foo bar]");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r5 regression ansi-reason", () => {
  const result = lintPrEvidence("## Evidence\nExemption: ci-only\n- Exemption reason: parser-only tooling\n  `curl http://192.168.1.$'80':8080/`");
  assert.equal(result.ok, true, result.errors.join("; "));
});

test("r5 regression ansi-boundary-hex-limit", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl http://192.168.1.$'\\x380':8080/\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r5 regression ansi-boundary-octal-limit", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl http://192.168.1.$'\\0700':8080/\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r5 regression ansi-boundary-unicode-limit", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl http://192.168.1.$'\\u00380':8080/\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r5 regression ansi-boundary-unicode-wide-limit", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl http://192.168.1.$'\\U000000380':8080/\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r5 regression ansi-boundary-byte-wrap-nul", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl http://192.168.1.$'\\400ignored'80:8080/\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r5 regression ansi-boundary-nul-empty", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl http://192.168.1.$'\\0ignored'80:8080/\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r5 regression ansi-quote-continuation", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nprintf '%s' $'escaped\\' quote'\ncurl http://192.168.1.8\\\n\"0\":8080/\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r5 regression ansi-safe-quote-newline", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl $'http://192.168.1.8\\'\n0':8080/\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r5 regression fold-deseret", () => {
  const result = lintPrEvidence("[𐐀]: http://192.168.1.80/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[𐐨]");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r5 regression fold-osage", () => {
  const result = lintPrEvidence("[𐒰]: http://192.168.1.80/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[𐓘]");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r5 regression fold-new17", () => {
  const result = lintPrEvidence("[𖺠]: http://192.168.1.80/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[𖺻]");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r5 regression span-max", () => {
  const result = lintPrEvidence("[xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\ny]: http://192.168.1.80/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx y]");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r5 regression span-overlong", () => {
  const result = lintPrEvidence("[xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\ny]: http://192.168.1.80/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx y]");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r5 regression span-blank-use", () => {
  const result = lintPrEvidence("[foo bar]: http://192.168.1.80/\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[foo\n\nbar]");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r5 regression span-overlong-title-later", () => {
  const result = lintPrEvidence("[xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx]: https://example.test/outer \"title\n[target]: http://192.168.1.80/\nend\"\n\n## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n[target]");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});

test("r6-exact-brace", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl http://192.168.1.{80,82}/\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r6-exact-decimal", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl 3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r6-exact-hex", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl 0xc0a80150\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r6-octal", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl 030052000520\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r6-decimal81", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl 3232235857\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r6-lan200", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl 3232286800\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r6-quoted-list", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl \"http://192.168.1.{82,80}/\"\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r6-range", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl \"http://192.168.1.[79-82]/\"\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r6-range-step", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl \"http://192.168.1.[78-82:2]/\"\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r6-range-padding", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl \"http://192.168.1.[0117-0122]/\"\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r6-cartesian", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl \"http://192.168.{1,2}.[80-82]/\"\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r6-numeric-list", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl \"{3232235856,2130706433}\"\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r6-numeric-range", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl \"[3232235855-3232235857]\"\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r6-bare-range", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl 192.168.1.[79-82]\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r6-quoted-ansi", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl $'3232235856'\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r6-url", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl --url 3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r6-url-equals", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl --url=0xc0a80150\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r6-url-glob", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl --url=\"http://192.168.1.{80,82}/\"\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r6-options", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl -sSI 3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r6-attached-data", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl -d3232235856 0xc0a80150\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r6-data-before", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl --data 2130706433 3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r6-data-equals", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl --data=3232235856 0xc0a80150\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r6-separator", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nprintf ok;curl 3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r6-pipeline", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nprintf ok|curl 3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r6-assignment", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nX=1 curl 3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r6-absolute", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\n/usr/bin/curl 3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r6-continuation", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl \\\n  3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r6-end-options", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl -- 3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r6-globoff-unquoted", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl -g http://192.168.1.{80,82}/\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r6-bash-sequence", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl -g http://192.168.1.{79..82}/\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r6-globoff-after-shell", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl http://192.168.1.{80,82}/ --globoff\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r6-no-globoff", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl --globoff --no-globoff \"http://192.168.1.{80,82}/\"\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r6-next", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl -g 127.0.0.1 --next \"http://192.168.1.{80,82}/\"\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r6-safe-decimal", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl 2130706433\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r6-safe-hex", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl 0x7f000001\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r6-safe-octal", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl 017700000001\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r6-ordinary", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\necho 3232235856\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r6-numeric-prose", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nThe curl run used 3232235856 records.\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r6-quoted-command", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\necho \"curl 3232235856\"\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r6-data", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl --data 3232235856 127.0.0.1\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r6-data-short", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl -d 3232235856 127.0.0.1\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r6-data-attached", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl -sd3232235856 127.0.0.1\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r6-header", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl -H 3232235856 127.0.0.1\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r6-timeout", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl --max-time 3232235856 127.0.0.1\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r6-output", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl -o 3232235856 127.0.0.1\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r6-output-attached", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl -o3232235856 127.0.0.1\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r6-writeout", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl --write-out 3232235856 127.0.0.1\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r6-safe-list", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl \"http://192.168.1.{82,83}/\"\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r6-safe-range", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl \"http://192.168.1.[82-85]/\"\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r6-safe-step", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl \"http://192.168.1.[79-82:3]/\"\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r6-globoff", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl -g \"http://192.168.1.{80,82}/\"\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r6-globoff-long", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl --globoff \"http://192.168.1.[79-82]/\"\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r6-globoff-after", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl \"http://192.168.1.{80,82}/\" -g\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r6-boundary", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl 127.0.0.1;echo 3232235856\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r6-comment", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl 127.0.0.1 # curl 3232235856\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r6-ipv6", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl \"http://[::1]/[1-3]\"\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r6-ipv6-mapped-safe", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl \"http://[::ffff:7f00:1]/\"\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r6-bad-range", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl \"http://192.168.1.[82-79]/\"\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r6-bad-step", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl \"http://192.168.1.[79-82:0]/\"\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r6-unclosed", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl \"http://192.168.1.{80,82/\"\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r6-empty-list", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl \"http://192.168.1.{}/\"\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r6-nested-curl", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl \"http://192.168.1.{{80,82},83}/\"\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r6-escaped-brace-off", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl -g http://192.168.1.\\{80,82\\}/\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r6-bare-option-value", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl --user 3232235856 127.0.0.1\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r6-transfer-config", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl --next -g \"http://192.168.1.{80,82}/\"\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r6-single-list", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl \"http://192.168.1.{80}/\"\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r6-empty-arm", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl \"http://192.168.1.8{0,}/\"\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r6-shell-empty-arm", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl -g http://192.168.1.8{0,}/\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r6-shell-nested", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl -g http://192.168.1.{8{0,1},82}/\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r6-large-path", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl \"http://127.0.0.1/[0-1000000]\"\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r6-host-bound", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl \"http://192.168.1.[0-1000000]/\"\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r6-safe-numeric-prose", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nThere were 3232235856 curl samples.\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r6-quote-fragment", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl 3232235'856'\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r6-end-options-data", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl --data 3232235856 -- 2130706433\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r6-brace-data", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl --data \"{3232235856,2130706433}\" 127.0.0.1\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r6-data-url-glob", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl --data \"http://192.168.1.{80,82}/\" 127.0.0.1\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r6-boundary-newline", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl 127.0.0.1\necho 3232235856\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r6-range-character", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl \"http://[a-c]0a80150/\"\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r6-malformed-whitespace", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl $'3232235856\\t'\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r6-option-curl", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nprintf curl 3232235856\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r6-one-slash-glob", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl \"http:/192.168.1.{82,80}/\"\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r6-three-slash-glob", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl \"http:///192.168.1.{82,80}/\"\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r6-empty-data-target", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl --data \"\" 3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r6-empty-url-target", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl --url \"\" 3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r6-empty-data-safe", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl -d \"\" 2130706433\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r6-empty-data-single", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl -d '' 0xc0a80150\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r6-url-after-next", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl 127.0.0.1 --next --url 3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});

test("r7-direct-decimal", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl 3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-direct-safe", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl -d 3232235856 2130706433\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-env-decimal", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nenv curl 3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-env-safe", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nenv curl -d 3232235856 2130706433\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-command-decimal", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncommand curl 3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-command-safe", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncommand curl -d 3232235856 2130706433\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-exec-decimal", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nexec curl 3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-exec-safe", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nexec curl -d 3232235856 2130706433\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-nice-decimal", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nnice curl 3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-nice-safe", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nnice curl -d 3232235856 2130706433\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-nohup-decimal", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nnohup curl 3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-nohup-safe", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nnohup curl -d 3232235856 2130706433\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-timeout-decimal", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ntimeout 2 curl 3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-timeout-safe", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ntimeout 2 curl -d 3232235856 2130706433\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-env-ignore-decimal", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nenv -i curl 3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-env-ignore-safe", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nenv -i curl -d 3232235856 2130706433\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-env-unset-decimal", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nenv -u UNUSED curl 3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-env-unset-safe", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nenv -u UNUSED curl -d 3232235856 2130706433\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-env-chdir-decimal", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nenv -C . curl 3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-env-chdir-safe", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nenv -C . curl -d 3232235856 2130706433\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-env-long-decimal", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nenv --ignore-environment --unset=UNUSED --chdir=. curl 3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-env-long-safe", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nenv --ignore-environment --unset=UNUSED --chdir=. curl -d 3232235856 2130706433\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-env-assign-decimal", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nenv COUNT=3232235856 curl 3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-env-assign-safe", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nenv COUNT=3232235856 curl -d 3232235856 2130706433\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-shell-assign-decimal", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nCOUNT=3232235856 env curl 3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-shell-assign-safe", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nCOUNT=3232235856 env curl -d 3232235856 2130706433\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-command-default-decimal", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncommand -p curl 3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-command-default-safe", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncommand -p curl -d 3232235856 2130706433\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-command-end-decimal", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncommand -- curl 3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-command-end-safe", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncommand -- curl -d 3232235856 2130706433\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-exec-options-decimal", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nexec -cl -a custom curl 3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-exec-options-safe", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nexec -cl -a custom curl -d 3232235856 2130706433\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-exec-attached-decimal", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nexec -acustom curl 3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-exec-attached-safe", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nexec -acustom curl -d 3232235856 2130706433\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-env-end-decimal", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nenv -- COUNT=3232235856 curl 3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-env-end-safe", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nenv -- COUNT=3232235856 curl -d 3232235856 2130706433\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-env-dash-decimal", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nenv - curl 3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-env-dash-safe", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nenv - curl -d 3232235856 2130706433\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-nested-decimal", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncommand env -i nice -n 0 timeout --foreground 2 curl 3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-nested-safe", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncommand env -i nice -n 0 timeout --foreground 2 curl -d 3232235856 2130706433\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-builtin-command-decimal", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nbuiltin command curl 3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-builtin-command-safe", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nbuiltin command curl -d 3232235856 2130706433\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-builtin-exec-decimal", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nbuiltin exec curl 3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-builtin-exec-safe", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nbuiltin exec curl -d 3232235856 2130706433\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-command-builtin-decimal", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncommand builtin command curl 3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-command-builtin-safe", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncommand builtin command curl -d 3232235856 2130706433\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-exec-env-decimal", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nexec env curl 3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-exec-env-safe", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nexec env curl -d 3232235856 2130706433\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-env-env-decimal", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nenv env curl 3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-env-env-safe", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nenv env curl -d 3232235856 2130706433\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-path-env-decimal", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\n/usr/bin/env /usr/bin/curl 3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-path-env-safe", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\n/usr/bin/env /usr/bin/curl -d 3232235856 2130706433\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-quoted-decimal", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\n'env' 'curl' 3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-quoted-safe", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\n'env' 'curl' -d 3232235856 2130706433\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-nice-options-decimal", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nnice --adjustment=0 env curl 3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-nice-options-safe", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nnice --adjustment=0 env curl -d 3232235856 2130706433\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-nohup-end-decimal", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nnohup -- curl 3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-nohup-end-safe", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nnohup -- curl -d 3232235856 2130706433\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-timeout-options-decimal", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ntimeout -s TERM -k 1 --preserve-status 2 curl 3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-timeout-options-safe", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ntimeout -s TERM -k 1 --preserve-status 2 curl -d 3232235856 2130706433\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-direct-hex", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl 0xc0a80150\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-direct-octal", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl 030052000520\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-direct-glob", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl \"http://192.168.1.{82,80}/\"\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-direct-url", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl --url=3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-direct-data-glob", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncurl --data \"http://192.168.1.{80,82}/\" 2130706433\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-env-hex", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nenv curl 0xc0a80150\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-env-octal", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nenv curl 030052000520\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-env-glob", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nenv curl \"http://192.168.1.{82,80}/\"\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-env-url", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nenv curl --url=3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-env-data-glob", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nenv curl --data \"http://192.168.1.{80,82}/\" 2130706433\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-command-hex", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncommand curl 0xc0a80150\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-command-octal", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncommand curl 030052000520\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-command-glob", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncommand curl \"http://192.168.1.{82,80}/\"\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-command-url", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncommand curl --url=3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-command-data-glob", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncommand curl --data \"http://192.168.1.{80,82}/\" 2130706433\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-exec-hex", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nexec curl 0xc0a80150\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-exec-octal", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nexec curl 030052000520\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-exec-glob", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nexec curl \"http://192.168.1.{82,80}/\"\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-exec-url", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nexec curl --url=3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-exec-data-glob", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nexec curl --data \"http://192.168.1.{80,82}/\" 2130706433\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-nice-hex", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nnice curl 0xc0a80150\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-nice-octal", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nnice curl 030052000520\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-nice-glob", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nnice curl \"http://192.168.1.{82,80}/\"\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-nice-url", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nnice curl --url=3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-nice-data-glob", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nnice curl --data \"http://192.168.1.{80,82}/\" 2130706433\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-nohup-hex", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nnohup curl 0xc0a80150\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-nohup-octal", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nnohup curl 030052000520\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-nohup-glob", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nnohup curl \"http://192.168.1.{82,80}/\"\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-nohup-url", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nnohup curl --url=3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-nohup-data-glob", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nnohup curl --data \"http://192.168.1.{80,82}/\" 2130706433\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-timeout-hex", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ntimeout 2 curl 0xc0a80150\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-timeout-octal", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ntimeout 2 curl 030052000520\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-timeout-glob", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ntimeout 2 curl \"http://192.168.1.{82,80}/\"\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-timeout-url", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ntimeout 2 curl --url=3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-timeout-data-glob", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ntimeout 2 curl --data \"http://192.168.1.{80,82}/\" 2130706433\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-lookup-short", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncommand -v curl 3232235856\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-lookup-long", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncommand -V curl 3232235856\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-lookup-cluster", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncommand -pv curl 3232235856\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-env-builtin", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nenv command curl 3232235856\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-env-exec", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nenv exec curl 3232235856\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-exec-command", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nexec command curl 3232235856\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-nice-builtin", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nnice command curl 3232235856\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-timeout-builtin", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ntimeout 2 command curl 3232235856\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-builtin-curl", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nbuiltin curl 3232235856\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-builtin-env", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nbuiltin env curl 3232235856\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-path-command", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\n/usr/bin/command curl 3232235856\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-path-exec", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\n/usr/bin/exec curl 3232235856\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-echo", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\necho env curl 3232235856\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-printf", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nprintf '%s' command curl 3232235856\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-assignment-only", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nenv COUNT=3232235856\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-env-option-value", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nenv -u 3232235856 curl 2130706433\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-exec-argv0", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nexec -a curl printf 3232235856\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-command-assignment", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncommand COUNT=1 curl 3232235856\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-exec-assignment", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nexec COUNT=1 curl 3232235856\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-env-help", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nenv --help curl 3232235856\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-command-invalid", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncommand -x curl 3232235856\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-exec-invalid", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nexec -x curl 3232235856\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-env-null", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nenv -0 curl 3232235856\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-env-empty", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nenv \"\" curl 3232235856\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-env-split-unsupported", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nenv -S 'curl 3232235856'\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-unknown", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nunknown-launcher curl 3232235856\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-dynamic", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nenv \"$PROGRAM\" 3232235856\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-boundary", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nenv curl 2130706433; echo 3232235856\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-nested-lookup", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nbuiltin command -v curl 3232235856\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-external-builtin", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nenv builtin command curl 3232235856\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-exec-no-command", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nexec -a curl\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-env-option-curl", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nenv -u curl printf 3232235856\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-nested-quotes", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncommand env 'curl' 3232235'856'\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-after-boundary", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\necho safe; command curl 3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-url-after-data", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nenv curl --data 3232235856 --url 0xc0a80150\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-globoff-shell", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nenv curl -g http://192.168.1.{82,80}/\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-range", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncommand curl \"http://192.168.1.[80-82]/\"\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-deep", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ncommand command command command command command command command command command command command command command command command command command command command command command command command command command command command command command command command command command command command command command command command command command command command command command command command command command command command command command command command command command command command command command command command command command command command command command command command command command command command command command command command curl 3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});

test("r7-env-empty-name", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nenv '=value' curl 3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-env-short-attached", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nenv -ivuUNUSED curl 3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-env-argv0", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nenv --argv0=custom curl 3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-env-signal", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nenv --ignore-signal=PIPE curl 3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-builtin-end", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nbuiltin -- command curl 3232235856\n```\n");
  assert.equal(result.ok, false, result.errors.join("; "));
  assert.match(result.errors.join("\n"), /LAN instances/);
});
test("r7-env-missing-option", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nenv -u\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-exec-missing-argv0", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nexec -a\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-timeout-invalid", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\ntimeout nonsense curl 3232235856\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
test("r7-env-assignment-option", () => {
  const result = lintPrEvidence("## Evidence\nExemption: none\n- Steps followed to produce the evidence: ran locally\n- Result observed: passed\n- Screenshot / recording / verify-skill output or trace: trace.json\n\n```sh\nenv A=B -u UNUSED curl 3232235856\n```\n");
  assert.equal(result.ok, true, result.errors.join("; "));
});
