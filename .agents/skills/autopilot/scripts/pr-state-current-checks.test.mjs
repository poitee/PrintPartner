import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { evaluateSnapshot, main } from "./pr-state.mjs";

const fixturePath = new URL("./fixtures/pr263-evidence-checks.json", import.meta.url);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
for (const check of fixture.statusCheckRollup) check.checkSuite.workflowRun.runAttempt = 1;
const currentUrl = "https://github.com/poitee/PrintPartner/actions/runs/38186110586/job/114608658588";

function snapshotWithChecks(checks) {
  return { ...fixture, statusCheckRollup: checks };
}

function latestCheck() {
  return structuredClone(fixture.statusCheckRollup.at(-1));
}

test("retained PR263 Evidence results with first-attempt metadata evaluate through the fixture CLI", (context) => {
  const dir = mkdtempSync(join(tmpdir(), "pr-state-evidence-"));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "snapshot.json");
  writeFileSync(path, JSON.stringify(fixture));
  let output = "";
  assert.equal(main(["--fixture", path], {
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
  ["FUTURE_STATUS", null, "ci", "failingChecks"],
]) {
  test(`latest ${status}/${conclusion} stays actionable when its start time is missing`, () => {
    const checks = structuredClone(fixture.statusCheckRollup);
    Object.assign(checks.at(-1), { status, conclusion, startedAt: null, completedAt: null });
    for (const ordered of [checks, checks.toReversed()]) {
      const report = evaluateSnapshot(snapshotWithChecks(ordered));
      assert.equal(report.nextAction, action);
      assert.deepEqual(report[field].map((item) => item.url), [currentUrl]);
      assert.equal(report.passedCheckCount, 1);
    }
  });
}

test("a delayed first attempt with a later start stays pending ahead of a newer-created success", () => {
  const checks = structuredClone(fixture.statusCheckRollup);
  Object.assign(checks[0], { status: "IN_PROGRESS", conclusion: null,
    startedAt: "2026-10-12T03:00:00Z", completedAt: "2026-10-12T04:00:00Z" });
  const report = evaluateSnapshot(snapshotWithChecks(checks));
  assert.equal(report.nextAction, "watch-ci");
  assert.deepEqual(report.pendingChecks.map((check) => check.url), [checks[0].detailsUrl]);
  assert.equal(report.passedCheckCount, 0);
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

for (const ambiguity of ["identity", "start time", "tied start time"]) {
  test(`ambiguous ${ambiguity} retains the blocker`, () => {
    const old = structuredClone(fixture.statusCheckRollup[0]);
    if (ambiguity === "identity") delete old.checkSuite.app;
    if (ambiguity === "start time") old.startedAt = null;
    if (ambiguity === "tied start time") old.startedAt = latestCheck().startedAt;
    const report = evaluateSnapshot(snapshotWithChecks([old, latestCheck()]));
    assert.equal(report.nextAction, "ci");
    assert.equal(report.failingChecks.length, 1);
  });
}

test("GitHub latest attempt IDs preserve queued attempts without start times", () => {
  const old = latestCheck();
  old.id = "old-attempt";
  old.conclusion = "FAILURE";
  const pending = latestCheck();
  Object.assign(pending, { status: "QUEUED", conclusion: null, startedAt: null });
  const report = evaluateSnapshot(snapshotWithChecks([old, pending]));
  assert.equal(report.nextAction, "watch-ci");
  assert.deepEqual(report.failingChecks, []);
  assert.deepEqual(report.pendingChecks.map((check) => check.url), [currentUrl]);
});

for (const completeness of ["missing", "partial"]) {
  test(`a ${completeness} attempt list retains ambiguous same-suite blockers`, () => {
    const old = latestCheck();
    old.id = "old-attempt";
    old.conclusion = "FAILURE";
    old.startedAt = "2026-10-11T23:55:59Z";
    if (completeness === "missing") delete old.checkSuite.currentRuns;
    else old.checkSuite.currentRuns.pageInfo.hasNextPage = true;
    const report = evaluateSnapshot(snapshotWithChecks([old, latestCheck()]));
    assert.equal(report.nextAction, "ci");
    assert.equal(report.failingChecks.length, 1);
  });
}

test("legacy status contexts stay visible beside an identically named check run", () => {
  const report = evaluateSnapshot(snapshotWithChecks([
    latestCheck(), { __typename: "StatusContext", context: "Lint Evidence block", state: "ERROR" },
  ]));
  assert.equal(report.nextAction, "ci");
  assert.equal(report.failingChecks.length, 1);
  assert.equal(report.passedCheckCount, 1);
});


function rerunCheck({ status = "COMPLETED", conclusion = "FAILURE", startedAt = "2026-10-12T03:00:00Z" } = {}) {
  const check = structuredClone(fixture.statusCheckRollup[0]);
  Object.assign(check, { status, conclusion, startedAt });
  check.checkSuite.workflowRun.runAttempt = 2;
  return check;
}

for (const [status, conclusion, action, field] of [
  ["COMPLETED", "FAILURE", "ci", "failingChecks"],
  ["IN_PROGRESS", null, "watch-ci", "pendingChecks"],
  ["QUEUED", null, "watch-ci", "pendingChecks"],
]) {
  test(`an older workflow's later ${status} rerun fixture stays actionable`, () => {
    const rerun = rerunCheck({ status, conclusion });
    for (const checks of [[rerun, latestCheck()], [latestCheck(), rerun]]) {
      const report = evaluateSnapshot(snapshotWithChecks(checks));
      assert.equal(report.nextAction, action);
      assert.deepEqual(report[field].map((check) => check.url), [rerun.detailsUrl]);
      assert.equal(report.passedCheckCount, 0);
    }
  });
}

test("a later successful rerun supersedes a newer-created failed workflow", () => {
  const rerun = rerunCheck({ conclusion: "SUCCESS" });
  const newer = latestCheck();
  newer.conclusion = "FAILURE";
  const report = evaluateSnapshot(snapshotWithChecks([newer, rerun]));
  assert.equal(report.nextAction, "ready");
  assert.deepEqual(report.failingChecks, []);
  assert.equal(report.passedCheckCount, 1);
});

for (const [label, startedAt] of [["missing", null], ["invalid", "bad-date"], ["tied", fixture.statusCheckRollup.at(-1).startedAt]]) {
  test(`a rerun with ${label} start timing retains a queued blocker`, () => {
    const rerun = rerunCheck({ status: "QUEUED", conclusion: null, startedAt });
    const report = evaluateSnapshot(snapshotWithChecks([rerun, latestCheck()]));
    assert.equal(report.nextAction, "watch-ci");
    assert.deepEqual(report.pendingChecks.map((check) => check.url), [rerun.detailsUrl]);
    assert.equal(report.passedCheckCount, 1);
  });
}

for (const attempt of [undefined, null, 0, -1, 1.5, "1"]) {
  test(`unknown attempt metadata ${attempt} cannot hide a failing check`, () => {
    const rerun = rerunCheck();
    rerun.checkSuite.workflowRun.runAttempt = attempt;
    const report = evaluateSnapshot(snapshotWithChecks([rerun, latestCheck()]));
    assert.equal(report.nextAction, "ci");
    assert.deepEqual(report.failingChecks.map((check) => check.url), [rerun.detailsUrl]);
    assert.equal(report.passedCheckCount, 1);
  });
}

test("a rerun does not use its original creation time when start timing is absent", () => {
  const old = rerunCheck();
  old.checkSuite.workflowRun.runAttempt = 1;
  const newer = latestCheck();
  newer.checkSuite.workflowRun.runAttempt = 2;
  newer.startedAt = null;
  const report = evaluateSnapshot(snapshotWithChecks([old, newer]));
  assert.equal(report.nextAction, "ci");
  assert.deepEqual(report.failingChecks.map((check) => check.url), [old.detailsUrl]);
  assert.equal(report.passedCheckCount, 1);
});

for (const completeness of ["missing", "partial", "empty"]) {
  test(`a ${completeness} attempt list cannot discard a same-suite rerun blocker by timing`, () => {
    const old = rerunCheck({ startedAt: "2026-10-12T01:00:00Z" });
    const newer = structuredClone(old);
    newer.id = "another-attempt";
    newer.conclusion = "SUCCESS";
    newer.startedAt = "2026-10-12T03:00:00Z";
    for (const check of [old, newer]) {
      if (completeness === "missing") delete check.checkSuite.currentRuns;
      if (completeness === "partial") check.checkSuite.currentRuns.pageInfo.hasNextPage = true;
      if (completeness === "empty") check.checkSuite.currentRuns.nodes = [];
    }
    const report = evaluateSnapshot(snapshotWithChecks([old, newer]));
    assert.equal(report.nextAction, "ci");
    assert.deepEqual(report.failingChecks.map((check) => check.url), [old.detailsUrl]);
    assert.equal(report.passedCheckCount, 1);
  });
}

for (const conclusion of ["SUCCESS", "SKIPPED", "CANCELLED"]) {
  test(`an earlier-starting ${conclusion} does not mask a later-starting failure`, () => {
    const earlier = latestCheck();
    earlier.conclusion = conclusion;
    earlier.status = "COMPLETED";
    earlier.startedAt = "2026-10-11T23:56:01Z";
    earlier.checkSuite.workflowRun.createdAt = "2026-10-12T05:00:00Z";
    const failure = structuredClone(fixture.statusCheckRollup[0]);
    failure.conclusion = "FAILURE";
    failure.status = "COMPLETED";
    failure.startedAt = "2026-10-12T03:00:00Z";
    const report = evaluateSnapshot(snapshotWithChecks([earlier, failure]));
    assert.equal(report.nextAction, "ci");
    assert.deepEqual(report.failingChecks.map((check) => check.url), [failure.detailsUrl]);
    assert.equal(report.passedCheckCount, 0);
  });
}

test("a partial rerun's late surviving start does not drop a failure that started later", () => {
  const survivor = structuredClone(fixture.statusCheckRollup[0]);
  survivor.checkSuite.workflowRun.runAttempt = 2;
  Object.assign(survivor, {
    status: "COMPLETED",
    conclusion: "SUCCESS",
    startedAt: "2026-10-12T03:00:00Z",
  });
  const failure = latestCheck();
  failure.conclusion = "FAILURE";
  failure.startedAt = "2026-10-12T04:00:00Z";
  const report = evaluateSnapshot(snapshotWithChecks([survivor, failure]));
  assert.equal(report.nextAction, "ci");
  assert.deepEqual(report.failingChecks.map((check) => check.url), [currentUrl]);
  assert.equal(report.passedCheckCount, 0);
});

test("a later check start beats an earlier failure from a newer workflow", () => {
  const older = rerunCheck({ conclusion: "SUCCESS", startedAt: "2026-10-12T04:00:00Z" });
  const newer = latestCheck();
  newer.conclusion = "FAILURE";
  newer.startedAt = "2026-10-12T03:00:00Z";
  newer.checkSuite.workflowRun.createdAt = "2026-10-12T03:30:00Z";
  const report = evaluateSnapshot(snapshotWithChecks([newer, older]));
  assert.equal(report.nextAction, "ready");
  assert.deepEqual(report.failingChecks, []);
  assert.equal(report.passedCheckCount, 1);
});

test("a missing workflow creation time still orders by check start", () => {
  const failure = structuredClone(fixture.statusCheckRollup[0]);
  failure.startedAt = "2026-10-12T03:00:00Z";
  failure.checkSuite.workflowRun.createdAt = null;
  const report = evaluateSnapshot(snapshotWithChecks([failure, latestCheck()]));
  assert.equal(report.nextAction, "ci");
  assert.deepEqual(report.failingChecks.map((check) => check.url), [failure.detailsUrl]);
  assert.equal(report.passedCheckCount, 0);
});

const oldHead = "1111111111111111111111111111111111111111";
const newHead = "2222222222222222222222222222222222222222";
const movedFailureUrl = "https://github.com/poitee/PrintPartner/actions/runs/9001/job/2";

function runLiveFixture(context, mode = "pages") {
  const dir = mkdtempSync(join(tmpdir(), "pr-state-current-"));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const data = {
    ...fixture,
    mode,
    oldHead,
    newHead,
    pinnedHead: "46f4b164a93ddaac910d6680dda52903dc757327",
  };
  if (mode === "rerun" || mode === "queued-rerun") {
    data.statusCheckRollup = [rerunCheck({
      status: mode === "rerun" ? "COMPLETED" : "QUEUED",
      conclusion: mode === "rerun" ? "FAILURE" : null,
      startedAt: mode === "rerun" ? "2026-10-12T03:00:00Z" : null,
    }), latestCheck()];
  }
  if (mode === "delayed-first") {
    const checks = structuredClone(fixture.statusCheckRollup);
    Object.assign(checks[0], {
      status: "IN_PROGRESS",
      conclusion: null,
      startedAt: "2026-10-12T03:00:00Z",
      completedAt: null,
    });
    data.statusCheckRollup = checks;
    data.mode = "pages";
  }
  if (mode === "partial-rerun") {
    const survivor = structuredClone(fixture.statusCheckRollup[0]);
    survivor.checkSuite.workflowRun.runAttempt = 2;
    Object.assign(survivor, {
      status: "COMPLETED",
      conclusion: "SUCCESS",
      startedAt: "2026-10-12T03:00:00Z",
    });
    const failure = latestCheck();
    failure.conclusion = "FAILURE";
    failure.startedAt = "2026-10-12T04:00:00Z";
    data.statusCheckRollup = [survivor, failure];
    data.mode = "pages";
  }
  if (mode === "head-moved") {
    data.oldChecks = [latestCheck()];
    const failure = latestCheck();
    failure.conclusion = "FAILURE";
    failure.detailsUrl = movedFailureUrl;
    data.newChecks = [failure];
  }
  if (mode === "head-unstable") {
    data.oids = [
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "cccccccccccccccccccccccccccccccccccccccc",
      "dddddddddddddddddddddddddddddddddddddddd",
    ];
    data.greenChecks = [latestCheck()];
  }
  if (mode === "head-merge-unknown" || mode === "head-confirm-fail" || mode === "head-confirm-auth") {
    data.greenChecks = [latestCheck()];
  }
  const statePath = join(dir, "state.json");
  writeFileSync(statePath, JSON.stringify({ prViews: 0, checkOids: [], prOids: [] }));
  writeFileSync(join(dir, "data.json"), JSON.stringify(data));
  writeFileSync(join(dir, "gh"), `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const data = JSON.parse(readFileSync(process.env.PR_STATE_TEST_DATA, "utf8"));
const statePath = process.env.PR_STATE_TEST_STATE;
const state = JSON.parse(readFileSync(statePath, "utf8"));
function save() { writeFileSync(statePath, JSON.stringify(state)); }
const args = process.argv.slice(2);
let response;
if (args[0] === "repo") response = { nameWithOwner: "poitee/PrintPartner" };
else if (args[0] === "pr") {
  state.prViews += 1;
  let headRefOid = data.pinnedHead;
  let mergeable = data.pr.mergeable;
  let mergeStateStatus = data.pr.mergeStateStatus;
  if (data.mode === "head-moved") headRefOid = state.prViews === 1 ? data.oldHead : data.newHead;
  else if (data.mode === "head-unstable") headRefOid = data.oids[state.prViews - 1];
  else if (data.mode === "head-merge-unknown" && state.prViews > 1) {
    mergeable = "UNKNOWN";
    mergeStateStatus = "UNKNOWN";
  } else if ((data.mode === "head-confirm-fail" || data.mode === "head-confirm-auth") && state.prViews > 1) {
    state.prOids.push(headRefOid);
    save();
    if (data.mode === "head-confirm-auth") {
      process.stderr.write("authentication required");
      process.exit(4);
    }
    process.stderr.write("head reread failed");
    process.exit(1);
  }
  response = { ...data.pr, headRefOid, mergeable, mergeStateStatus };
  state.prOids.push(headRefOid);
  save();
} else if (args.some((arg) => arg.includes("reviewThreads(first:"))) {
  response = { data: { viewer: { login: "poitee" }, repository: { pullRequest: {
    reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
  } } } };
} else if (args[1] === "graphql") {
  if (data.mode === "auth") { process.stderr.write("authentication required"); process.exit(4); }
  if (data.mode === "errors") response = { errors: [{ message: "checks unavailable" }] };
  else {
    const oid = args.find((arg) => arg.startsWith("oid="))?.slice(4);
    state.checkOids.push(oid);
    save();
    const allowed = new Set([data.pinnedHead, data.oldHead, data.newHead, ...(data.oids ?? [])]);
    if (!allowed.has(oid)) process.exit(1);
    const query = args.find((arg) => arg.startsWith("query="));
    if (!query?.includes("runAttempt") || !query.includes("startedAt")) {
      process.stderr.write("missing attempt timing query fields"); process.exit(1);
    }
    let rollup = data.statusCheckRollup;
    if (data.mode === "head-moved") rollup = oid === data.oldHead ? data.oldChecks : data.newChecks;
    if (data.mode === "head-unstable" || data.mode === "head-merge-unknown" || data.mode === "head-confirm-fail" || data.mode === "head-confirm-auth") {
      rollup = data.greenChecks;
    }
    const last = args.includes("cursor=next");
    response = { data: { repository: { object: { statusCheckRollup: { contexts: {
      nodes: last ? [rollup.at(-1)] : rollup.slice(0, -1),
      pageInfo: { hasNextPage: !last, endCursor: last ? null : "next" },
    } } } } } };
  }
} else response = [];
process.stdout.write(JSON.stringify(response));
`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [new URL("./pr-state.mjs", import.meta.url).pathname, "--pr", "263"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      PR_STATE_TEST_DATA: join(dir, "data.json"),
      PR_STATE_TEST_STATE: statePath,
    },
  });
  result.statePath = statePath;
  return result;
}

test("live CLI includes the latest context from a later API page at the selected head", (context) => {
  const result = runLiveFixture(context);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.nextAction, "ready");
  assert.equal(report.passedCheckCount, 1);
  assert.deepEqual(report.failingChecks, []);
});

for (const [mode, exit, message] of [["auth", 4, /authentication required/], ["errors", 1, /checks unavailable/]]) {
  test(`live check ${mode} errors cannot turn into readiness or no-pr`, (context) => {
    const result = runLiveFixture(context, mode);
    assert.equal(result.status, exit);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, message);
  });
}

for (const [mode, action, field] of [["rerun", "ci", "failingChecks"], ["queued-rerun", "watch-ci", "pendingChecks"]]) {
  test(`paged live CLI fixture preserves a later ${mode} blocker`, (context) => {
    const result = runLiveFixture(context, mode);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.nextAction, action);
    assert.deepEqual(report[field].map((check) => check.url), [fixture.statusCheckRollup[0].detailsUrl]);
    assert.equal(report.passedCheckCount, mode === "rerun" ? 0 : 1);
  });
}

for (const identity of ["check", "suite"]) {
  test(`a missing ${identity} ID cannot discard a cross-suite blocker`, () => {
    const old = structuredClone(fixture.statusCheckRollup[0]);
    if (identity === "check") delete old.id;
    else delete old.checkSuite.id;
    const report = evaluateSnapshot(snapshotWithChecks([old, latestCheck()]));
    assert.equal(report.nextAction, "ci");
    assert.deepEqual(report.failingChecks.map((check) => check.url), [old.detailsUrl]);
    assert.equal(report.passedCheckCount, 1);
  });
}

test("live CLI keeps a delayed first-attempt pending check", (context) => {
  const result = runLiveFixture(context, "delayed-first");
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.nextAction, "watch-ci");
  assert.deepEqual(report.pendingChecks.map((check) => check.url), [fixture.statusCheckRollup[0].detailsUrl]);
  assert.equal(report.passedCheckCount, 0);
});

test("live CLI keeps a failure that started after a partial rerun's surviving check", (context) => {
  const result = runLiveFixture(context, "partial-rerun");
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.nextAction, "ci");
  assert.deepEqual(report.failingChecks.map((check) => check.url), [currentUrl]);
  assert.equal(report.passedCheckCount, 0);
});

test("live CLI refetches checks when the head changes and does not report the old green head", (context) => {
  const result = runLiveFixture(context, "head-moved");
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.nextAction, "ci");
  assert.deepEqual(report.failingChecks.map((check) => check.url), [movedFailureUrl]);
  assert.equal(report.passedCheckCount, 0);
  const state = JSON.parse(readFileSync(result.statePath, "utf8"));
  assert.deepEqual(state.prOids, [oldHead, newHead, newHead, newHead]);
  assert.equal(state.checkOids[0], oldHead);
  assert.ok(state.checkOids.includes(newHead));
});

test("live CLI rechecks when the head keeps moving", (context) => {
  const result = runLiveFixture(context, "head-unstable");
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.nextAction, "recheck");
  assert.equal(report.passedCheckCount, 0);
  assert.deepEqual(report.failingChecks, []);
  assert.equal(report.pr.number, 263);
  const state = JSON.parse(readFileSync(result.statePath, "utf8"));
  assert.equal(state.prOids.length, 4);
  assert.equal(new Set(state.prOids).size, 4);
});

test("live CLI rechecks when the head reread fails", (context) => {
  const result = runLiveFixture(context, "head-confirm-fail");
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.nextAction, "recheck");
  assert.equal(report.passedCheckCount, 0);
  assert.equal(report.pr.number, 263);
});

test("live CLI rechecks when the confirmed mergeability is unknown", (context) => {
  const result = runLiveFixture(context, "head-merge-unknown");
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.nextAction, "recheck");
  assert.equal(report.passedCheckCount, 1);
  assert.equal(report.pr.number, 263);
});

test("live CLI does not turn a failed head reread authentication into readiness", (context) => {
  const result = runLiveFixture(context, "head-confirm-auth");
  assert.equal(result.status, 4);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /authentication required/);
});
