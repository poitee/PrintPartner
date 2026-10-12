import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { evaluateSnapshot, main } from "./pr-state.mjs";

const fixturePath = new URL("./fixtures/pr263-evidence-checks.json", import.meta.url);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
const currentUrl = "https://github.com/poitee/PrintPartner/actions/runs/38186110586/job/114608658588";

function snapshotWithChecks(checks) {
  return { ...fixture, statusCheckRollup: checks };
}

function latestCheck() {
  return structuredClone(fixture.statusCheckRollup.at(-1));
}

test("retained PR263 Evidence results evaluate through the fixture CLI", () => {
  let output = "";
  assert.equal(main(["--fixture", fixturePath.pathname], {
    stdout: { write(chunk) { output += chunk; } },
  }), 0);
  const report = JSON.parse(output);
  assert.equal(report.nextAction, "ready");
  assert.deepEqual(report.failingChecks, []);
  assert.deepEqual(report.pendingChecks, []);
  assert.equal(report.passedCheckCount, 1);
});

for (const [status, conclusion, action, field] of [
  ["COMPLETED", "FAILURE", "ci", "failingChecks"],
  ["QUEUED", null, "watch-ci", "pendingChecks"],
  ["IN_PROGRESS", null, "watch-ci", "pendingChecks"],
  ["COMPLETED", "FUTURE_OUTCOME", "ci", "failingChecks"],
]) {
  test(`latest ${status}/${conclusion} stays actionable regardless of input order`, () => {
    const checks = structuredClone(fixture.statusCheckRollup);
    Object.assign(checks.at(-1), { status, conclusion, startedAt: null, completedAt: null });
    for (const ordered of [checks, checks.toReversed()]) {
      const report = evaluateSnapshot(snapshotWithChecks(ordered));
      assert.equal(report.nextAction, action);
      assert.deepEqual(report[field].map((item) => item.url), [currentUrl]);
      assert.equal(report.passedCheckCount, 0);
    }
  });
}

test("a stale pending run with a later start or completion cannot replace a newer run", () => {
  const checks = structuredClone(fixture.statusCheckRollup);
  Object.assign(checks[0], { status: "IN_PROGRESS", conclusion: null,
    startedAt: "2026-10-12T03:00:00Z", completedAt: "2026-10-12T04:00:00Z" });
  const report = evaluateSnapshot(snapshotWithChecks(checks));
  assert.equal(report.nextAction, "ready");
  assert.equal(report.passedCheckCount, 1);
});

for (const identity of ["app", "workflow", "event", "name"]) {
  test(`a distinct ${identity} keeps its failure despite the same display name`, () => {
    const other = structuredClone(fixture.statusCheckRollup[0]);
    if (identity === "app") other.checkSuite.app.id = "another-app";
    if (identity === "workflow") other.checkSuite.workflowRun.workflow.id = "another-workflow";
    if (identity === "event") other.checkSuite.workflowRun.event = "push";
    if (identity === "name") other.name = "Another requirement";
    const report = evaluateSnapshot(snapshotWithChecks([other, latestCheck()]));
    assert.equal(report.nextAction, "ci");
    assert.deepEqual(report.failingChecks.map((item) => item.url), [other.detailsUrl]);
    assert.equal(report.passedCheckCount, 1);
  });
}

for (const ambiguity of ["identity", "creation time", "tied creation time"]) {
  test(`ambiguous ${ambiguity} retains the blocker`, () => {
    const old = structuredClone(fixture.statusCheckRollup[0]);
    if (ambiguity === "identity") delete old.checkSuite.app;
    if (ambiguity === "creation time") old.checkSuite.workflowRun.createdAt = null;
    if (ambiguity === "tied creation time") {
      old.checkSuite.workflowRun.createdAt = latestCheck().checkSuite.workflowRun.createdAt;
    }
    const report = evaluateSnapshot(snapshotWithChecks([old, latestCheck()]));
    assert.equal(report.nextAction, "ci");
    assert.equal(report.failingChecks.length, 1);
  });
}

test("same-suite attempts use start time and retain an unstarted pending attempt", () => {
  const old = latestCheck();
  old.startedAt = "2026-10-11T23:55:59Z";
  old.conclusion = "FAILURE";
  let report = evaluateSnapshot(snapshotWithChecks([old, latestCheck()]));
  assert.equal(report.nextAction, "ready");
  const pending = latestCheck();
  Object.assign(pending, { status: "QUEUED", conclusion: null, startedAt: null });
  report = evaluateSnapshot(snapshotWithChecks([latestCheck(), pending]));
  assert.equal(report.nextAction, "watch-ci");
  assert.equal(report.pendingChecks.length, 1);
});

test("legacy status contexts stay visible beside an identically named check run", () => {
  const report = evaluateSnapshot(snapshotWithChecks([
    latestCheck(), { __typename: "StatusContext", context: "Lint Evidence block", state: "ERROR" },
  ]));
  assert.equal(report.nextAction, "ci");
  assert.equal(report.failingChecks.length, 1);
  assert.equal(report.passedCheckCount, 1);
});
