import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  chooseNextAction,
  classifyChecks,
  evaluateSnapshot,
  isBotLogin,
  isMissingPrError,
  main,
  parseArgs,
  readGhResult,
  summarizeIssueComments,
  summarizeThreads,
  truncate,
} from "../.agents/skills/autopilot/scripts/pr-state.mjs";

const MERGEABLE_PR = {
  number: 9,
  url: "https://example.test/9",
  title: "x",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
};

function nextActionFor(overrides) {
  return chooseNextAction({ pr: MERGEABLE_PR, mergeStateStatus: "CLEAN", ...overrides });
}

test("parseArgs reads pr and fixture flags", () => {
  assert.deepEqual(parseArgs(["--pr", "12", "--fixture", "snap.json"]), {
    pr: 12,
    fixture: "snap.json",
    help: false,
  });
  assert.equal(parseArgs(["--help"]).help, true);
  assert.throws(() => parseArgs(["--nope"]), /Unknown argument/);
  assert.throws(() => parseArgs(["--pr", "nope"]), /integer/);
});

test("truncate keeps short comments and caps long ones", () => {
  assert.equal(truncate("  hello   world  "), "hello world");
  const long = "x".repeat(800);
  const clipped = truncate(long, 20);
  assert.equal(clipped.endsWith("…"), true);
  assert.ok(clipped.length <= 20);
});

test("bot logins are skipped for conversation comments", () => {
  assert.equal(isBotLogin("coderabbitai"), true);
  assert.equal(isBotLogin("github-actions[bot]"), true);
  assert.equal(isBotLogin("poitee"), false);
  const comments = summarizeIssueComments([
    { id: 1, html_url: "https://example.test/1", user: { login: "coderabbitai" }, body: "noise" },
    { id: 2, html_url: "https://example.test/2", user: { login: "poitee" }, body: "please fix the copy" },
  ]);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].author, "poitee");
});

test("summarizeThreads drops resolved threads and keeps the latest body", () => {
  const { unresolved, awaitingHuman } = summarizeThreads({
    reviewThreads: [
      {
        id: "TH_resolved",
        isResolved: true,
        path: "gone.ts",
        comments: { nodes: [{ body: "old", url: "https://example.test/r", author: { login: "bot" } }] },
      },
      {
        id: "TH_open",
        isResolved: false,
        isOutdated: false,
        path: "web/apps/web/src/App.tsx",
        comments: {
          nodes: [
            { body: "first", url: "https://example.test/1", author: { login: "reviewer" }, line: 10 },
            { body: "please rename this", url: "https://example.test/2", author: { login: "reviewer" }, line: 12 },
          ],
        },
      },
    ],
  });
  assert.equal(awaitingHuman.length, 0);
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].threadId, "TH_open");
  assert.equal(unresolved[0].line, 12);
  assert.match(unresolved[0].body, /rename/);
});

test("a thread the viewer answered last is awaiting a human, not a reply", () => {
  const reviewThreads = [
    {
      id: "TH_answered",
      isResolved: false,
      path: "web/apps/web/src/App.tsx",
      comments: {
        nodes: [
          { body: "please rename this", author: { login: "reviewer" } },
          { body: "renamed in abc1234", author: { login: "cursor[bot]" } },
        ],
      },
    },
    {
      id: "TH_waiting",
      isResolved: false,
      path: "web/apps/server/src/index.ts",
      comments: { nodes: [{ body: "this leaks the token", author: { login: "reviewer" } }] },
    },
  ];

  // `[bot]` suffix and viewer.login spelling differ for a GitHub App.
  const answered = summarizeThreads({ reviewThreads, viewerLogin: "cursor" });
  assert.deepEqual(answered.awaitingHuman.map((item) => item.threadId), ["TH_answered"]);
  assert.deepEqual(answered.unresolved.map((item) => item.threadId), ["TH_waiting"]);

  // Without a viewer login nothing can be attributed, so both stay actionable.
  const anonymous = summarizeThreads({ reviewThreads });
  assert.equal(anonymous.awaitingHuman.length, 0);
  assert.equal(anonymous.unresolved.length, 2);
});

test("a reply of the viewer's own does not re-drive the comments action", () => {
  const report = evaluateSnapshot({
    pr: { number: 5, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", title: "x" },
    viewerLogin: "cursor[bot]",
    reviewThreads: [
      {
        id: "TH_answered",
        isResolved: false,
        comments: {
          nodes: [
            { body: "nit", author: { login: "reviewer" } },
            { body: "fixed", author: { login: "cursor[bot]" } },
          ],
        },
      },
    ],
    statusCheckRollup: [{ name: "Web CI", status: "COMPLETED", conclusion: "SUCCESS" }],
  });
  assert.equal(report.nextAction, "ready");
  assert.equal(report.unresolvedComments.length, 0);
  assert.equal(report.awaitingHumanComments.length, 1);

  const humanReplied = evaluateSnapshot({
    pr: { number: 5, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", title: "x" },
    viewerLogin: "cursor[bot]",
    reviewThreads: [
      {
        id: "TH_answered",
        isResolved: false,
        comments: {
          nodes: [
            { body: "nit", author: { login: "reviewer" } },
            { body: "fixed", author: { login: "cursor[bot]" } },
            { body: "still wrong", author: { login: "reviewer" } },
          ],
        },
      },
    ],
    statusCheckRollup: [{ name: "Web CI", status: "COMPLETED", conclusion: "SUCCESS" }],
  });
  assert.equal(humanReplied.nextAction, "comments");
});

test("classifyChecks splits failing, pending, and passed", () => {
  const { failing, pending, passed } = classifyChecks([
    { name: "Web CI", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://example.test/web" },
    { name: "Optional integration smoke", status: "IN_PROGRESS", conclusion: null },
    { name: "Validate manifests", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "skipped", status: "COMPLETED", conclusion: "SKIPPED" },
  ]);
  assert.deepEqual(failing.map((item) => item.name), ["Web CI"]);
  assert.deepEqual(pending.map((item) => item.name), ["Optional integration smoke"]);
  assert.deepEqual(passed.map((item) => item.name), ["Validate manifests", "skipped"]);
});

test("an errored check is failing, and only known pending statuses wait", () => {
  const { failing, pending, passed } = classifyChecks([
    // Legacy commit status: a state, no conclusion.
    { context: "legacy/errored", state: "ERROR", targetUrl: "https://example.test/legacy" },
    { name: "check-run errored", status: "COMPLETED", conclusion: "ERROR" },
    { context: "legacy/waiting", state: "PENDING" },
    { name: "no signal at all", status: "COMPLETED", conclusion: null },
  ]);
  assert.deepEqual(failing.map((item) => item.name), [
    "legacy/errored",
    "check-run errored",
    "no signal at all",
  ]);
  assert.deepEqual(pending.map((item) => item.name), ["legacy/waiting"]);
  assert.equal(passed.length, 0);
});

test("nextAction prefers conflicts, then unknown mergeability, then comments, then CI", () => {
  assert.equal(chooseNextAction({ pr: null }), "no-pr");
  assert.equal(
    nextActionFor({
      conflicts: true,
      mergeabilityUnknown: true,
      unresolvedComments: [{ threadId: "T" }],
      failingChecks: [{ name: "Web CI" }],
    }),
    "conflicts",
  );
  assert.equal(
    nextActionFor({
      mergeabilityUnknown: true,
      unresolvedComments: [{ threadId: "T" }],
      failingChecks: [{ name: "Web CI" }],
    }),
    "recheck",
  );
  assert.equal(
    nextActionFor({
      unresolvedComments: [{ threadId: "T" }],
      failingChecks: [{ name: "Web CI" }],
    }),
    "comments",
  );
  assert.equal(
    nextActionFor({ failingChecks: [{ name: "Web CI" }], pendingChecks: [{ name: "docker" }] }),
    "ci",
  );
  assert.equal(nextActionFor({ pendingChecks: [{ name: "docker" }] }), "watch-ci");
  assert.equal(nextActionFor({}), "ready");
});

test("nextAction never reports ready for a PR GitHub will refuse to merge", () => {
  assert.equal(nextActionFor({ isDraft: true }), "draft");
  assert.equal(nextActionFor({ mergeStateStatus: "DRAFT" }), "draft");
  assert.equal(nextActionFor({ mergeStateStatus: "BLOCKED" }), "blocked");
  assert.equal(nextActionFor({ behind: true, mergeStateStatus: "BEHIND" }), "behind");
  // An unrecognised or absent merge state is a read GitHub has not finished.
  assert.equal(nextActionFor({ mergeStateStatus: null }), "recheck");
  assert.equal(nextActionFor({ mergeStateStatus: "HAS_HOOKS" }), "recheck");
  // A draft outranks the merge state it also produces.
  assert.equal(nextActionFor({ isDraft: true, mergeStateStatus: "BLOCKED" }), "draft");
  // UNSTABLE means non-required checks are red, which GitHub still merges.
  assert.equal(nextActionFor({ mergeStateStatus: "UNSTABLE" }), "ready");
});

test("evaluateSnapshot reports ready only when mergeable, green, and triaged", () => {
  const report = evaluateSnapshot({
    pr: {
      number: 4,
      url: "https://github.com/poitee/PrintPartner/pull/4",
      title: "Fix MCP auth",
      isDraft: false,
      baseRefName: "main",
      headRefName: "fix/mcp",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
    },
    reviewThreads: [{ id: "TH_done", isResolved: true, comments: { nodes: [{ body: "fixed" }] } }],
    statusCheckRollup: [{ name: "Web CI", status: "COMPLETED", conclusion: "SUCCESS" }],
    issueComments: [{ user: { login: "coderabbitai" }, body: "summary" }],
  });
  assert.equal(report.nextAction, "ready");
  assert.equal(report.unresolvedComments.length, 0);
  assert.equal(report.awaitingHumanComments.length, 0);
  assert.equal(report.conversationComments.length, 0);
  assert.equal(report.failingChecks.length, 0);
});

test("evaluateSnapshot treats CONFLICTING as the conflicts action", () => {
  const report = evaluateSnapshot({
    pr: { number: 8, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", title: "x" },
    reviewThreads: [{ id: "TH_open", isResolved: false, comments: { nodes: [{ body: "nit" }] } }],
    statusCheckRollup: [{ name: "Web CI", conclusion: "FAILURE", status: "COMPLETED" }],
  });
  assert.equal(report.nextAction, "conflicts");
  assert.equal(report.conflicts, true);
});

test("evaluateSnapshot rechecks unknown mergeability before comments or CI", () => {
  const report = evaluateSnapshot({
    pr: { number: 8, mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN", title: "x" },
    reviewThreads: [{ id: "TH_open", isResolved: false, comments: { nodes: [{ body: "nit" }] } }],
    statusCheckRollup: [{ name: "Web CI", conclusion: "FAILURE", status: "COMPLETED" }],
  });
  assert.equal(report.nextAction, "recheck");
  assert.equal(report.conflicts, false);

  // A PR read that has no mergeability field yet is equally unknown.
  const missing = evaluateSnapshot({
    pr: { number: 8, title: "x" },
    reviewThreads: [],
    statusCheckRollup: [],
  });
  assert.equal(missing.nextAction, "recheck");
  assert.equal(missing.mergeable, "UNKNOWN");
});

test("evaluateSnapshot sends a behind branch to the base merge, not to ready", () => {
  const report = evaluateSnapshot({
    pr: { number: 3, mergeable: "MERGEABLE", mergeStateStatus: "BEHIND", title: "x" },
    reviewThreads: [],
    statusCheckRollup: [{ name: "Web CI", conclusion: "SUCCESS", status: "COMPLETED" }],
  });
  assert.equal(report.behind, true);
  assert.equal(report.nextAction, "behind");
});

test("evaluateSnapshot reports draft and blocked instead of ready", () => {
  const green = [{ name: "Web CI", conclusion: "SUCCESS", status: "COMPLETED" }];
  const draft = evaluateSnapshot({
    pr: { number: 3, isDraft: true, mergeable: "MERGEABLE", mergeStateStatus: "DRAFT", title: "x" },
    reviewThreads: [],
    statusCheckRollup: green,
  });
  assert.equal(draft.nextAction, "draft");
  assert.equal(draft.pr.isDraft, true);

  const blocked = evaluateSnapshot({
    pr: { number: 3, mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED", title: "x" },
    reviewThreads: [],
    statusCheckRollup: green,
  });
  assert.equal(blocked.nextAction, "blocked");
});

test("readGhResult names the launch failure instead of hiding it", () => {
  assert.throws(
    () =>
      readGhResult({
        args: ["pr", "view", "--json", "number"],
        result: {
          error: Object.assign(new Error("spawnSync gh ENOENT"), { code: "ENOENT" }),
          status: null,
          stdout: "",
          stderr: "",
        },
      }),
    (error) => {
      assert.equal(error.ghFailure, "launch");
      assert.match(error.message, /gh pr view --json could not run/);
      assert.match(error.message, /ENOENT/);
      assert.equal(isMissingPrError(error), false);
      return true;
    },
  );

  // A maxBuffer overrun arrives the same way, with truncated stdout attached.
  assert.throws(
    () =>
      readGhResult({
        args: ["pr", "view", "--json", "statusCheckRollup"],
        result: {
          error: Object.assign(new Error("spawnSync gh ENOBUFS"), { code: "ENOBUFS" }),
          status: null,
          stdout: '{"number":1,',
          stderr: "",
        },
      }),
    /ENOBUFS/,
  );
});

test("readGhResult reports the exit code and stderr of a failed gh call", () => {
  assert.throws(
    () =>
      readGhResult({
        args: ["api", "graphql", "-f", "query=..."],
        result: { status: 4, stdout: "", stderr: "gh: authentication required\n" },
      }),
    (error) => {
      assert.equal(error.ghFailure, "exit");
      assert.equal(error.exitCode, 4);
      assert.match(error.message, /exited 4: gh: authentication required/);
      // Exit code 4 is an auth failure and must never read as "no open PR".
      assert.equal(isMissingPrError(error), false);
      return true;
    },
  );

  assert.throws(
    () =>
      readGhResult({
        args: ["pr", "view", "999"],
        result: { status: 1, stdout: "", stderr: "GraphQL: Could not resolve to a PullRequest" },
      }),
    (error) => {
      // The old substring test missed this wording and threw instead.
      assert.equal(isMissingPrError(error), true);
      return true;
    },
  );

  assert.equal(
    isMissingPrError(new Error("no pull requests found for branch")),
    false,
    "a plain error carries no gh classification",
  );
});

test("readGhResult passes stdout through on success", () => {
  const stdout = '{"number":7}';
  assert.equal(
    readGhResult({ args: ["pr", "view", "--json", "number"], result: { status: 0, stdout } }),
    stdout,
  );
});

test("evaluateSnapshot with no PR reports no-pr", () => {
  const report = evaluateSnapshot({ pr: null });
  assert.equal(report.nextAction, "no-pr");
  assert.equal(report.pr, null);
  assert.equal(report.mergeable, null);
});

test("CLI --help explains the helper", () => {
  const chunks = [];
  const code = main(["--help"], {
    stdout: { write(text) { chunks.push(text); return true; } },
    stderr: { write() { return true; } },
  });
  assert.equal(code, 0);
  assert.match(chunks.join(""), /--fixture/);
});

test("CLI --fixture prints JSON for a saved snapshot", () => {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-pr-state-"));
  const fixture = join(dir, "snapshot.json");
  writeFileSync(
    fixture,
    JSON.stringify({
      pr: {
        number: 1,
        url: "https://github.com/poitee/PrintPartner/pull/1",
        title: "Demo",
        mergeable: "MERGEABLE",
        mergeStateStatus: "UNSTABLE",
      },
      reviewThreads: [],
      statusCheckRollup: [
        { name: "Web CI", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://example.test/log" },
      ],
    }),
  );
  const chunks = [];
  const code = main(["--fixture", fixture], {
    stdout: { write(text) { chunks.push(text); return true; } },
    stderr: { write() { return true; } },
  });
  assert.equal(code, 0);
  const report = JSON.parse(chunks.join(""));
  assert.equal(report.nextAction, "ci");
  assert.equal(report.failingChecks[0].name, "Web CI");
});
