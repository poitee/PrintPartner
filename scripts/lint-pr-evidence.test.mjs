import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { lintPrEvidence } from "./lint-pr-evidence.mjs";

test("empty Evidence fails with a missing, empty, or none exemption", () => {
  for (const field of ["", "Exemption:", "Exemption: none", "Exemption: NONE"]) {
    assert.equal(lintPrEvidence(`## Evidence\n \t\n${field}`).ok, false);
  }
});

test("empty Evidence passes with any exemption reason", () => {
  assert.equal(lintPrEvidence("## Evidence\nExemption: Documentation update only.").ok, true);
});

test("non-empty Evidence passes without required fields or artifacts", () => {
  for (const evidence of ["Verified locally.", "`screenshot`", "http://192.168.1.80", "<a href=\"http://3232235856\">checked</a>", "```text\nAll checks passed\n```", "### Checks\nPassed."]) {
    assert.equal(lintPrEvidence(`## Evidence\n${evidence}\nExemption: none`).ok, true);
  }
});

test("comments and template placeholders count as empty Evidence", () => {
  for (const evidence of ["<!-- attach evidence -->", "<!-- first\nsecond -->", "<paste evidence here>", "- TODO: attach evidence", "TBD", "placeholder", "```text\n```", "<!-- unclosed"]) {
    assert.equal(lintPrEvidence(`## Evidence\n${evidence}`).ok, false);
  }
  assert.equal(lintPrEvidence(readFileSync(new URL("../.github/pull_request_template.md", import.meta.url), "utf8")).ok, false);
});

test("missing Evidence heading fails without an exemption and passes with a reason", () => {
  assert.equal(lintPrEvidence("## Summary\nTested locally.\nExemption: none").ok, false);
  assert.equal(lintPrEvidence("## Exemption\nExemption: No runtime change.").ok, true);
});

test("other sections and exemption metadata do not fill Evidence", () => {
  assert.equal(lintPrEvidence("## Evidence\nExemption: none\n## Test plan\nPassed.").ok, false);
  assert.equal(lintPrEvidence("## Evidence\n# Background\nPassed.").ok, false);
});

test("commented or fenced headings and exemptions do not supply metadata", () => {
  assert.equal(lintPrEvidence("<!-- ## Evidence\nPassed.\nExemption: docs only -->").ok, false);
  assert.equal(lintPrEvidence("```text\n## Evidence\nPassed.\nExemption: docs only\n```").ok, false);
  assert.equal(lintPrEvidence("## Evidence\n<!-- empty -->\nExemption: <!-- reason -->").ok, false);
  assert.equal(lintPrEvidence("## Evidence\nExemption: <reason for exemption>").ok, false);
});

test("comments around real Evidence and CRLF headings are accepted", () => {
  assert.equal(lintPrEvidence("## Evidence\r\n<!-- note --> Verified locally.\r\n## Exemption\r\nExemption: none").ok, true);
});
