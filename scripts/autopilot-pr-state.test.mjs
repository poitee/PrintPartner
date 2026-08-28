import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  chooseNextAction,
  classifyChecks,
  evaluateSnapshot,
  isBotLogin,
  main,
  parseArgs,
  summarizeIssueComments,
  summarizeThreads,
  truncate,
} from "../.agents/skills/autopilot/scripts/pr-state.mjs";

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
  const unresolved = summarizeThreads([
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
  ]);
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].threadId, "TH_open");
  assert.equal(unresolved[0].line, 12);
  assert.match(unresolved[0].body, /rename/);
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

test("nextAction prefers conflicts, then comments, then CI", () => {
  const pr = { number: 9, url: "https://example.test/9", title: "x" };
  assert.equal(chooseNextAction({ pr: null, conflicts: false, unresolvedComments: [], failingChecks: [], pendingChecks: [] }), "no-pr");
  assert.equal(
    chooseNextAction({
      pr,
      conflicts: true,
      unresolvedComments: [{ threadId: "T" }],
      failingChecks: [{ name: "Web CI" }],
      pendingChecks: [],
    }),
    "conflicts",
  );
  assert.equal(
    chooseNextAction({
      pr,
      conflicts: false,
      unresolvedComments: [{ threadId: "T" }],
      failingChecks: [{ name: "Web CI" }],
      pendingChecks: [],
    }),
    "comments",
  );
  assert.equal(
    chooseNextAction({
      pr,
      conflicts: false,
      unresolvedComments: [],
      failingChecks: [{ name: "Web CI" }],
      pendingChecks: [{ name: "docker" }],
    }),
    "ci",
  );
  assert.equal(
    chooseNextAction({
      pr,
      conflicts: false,
      unresolvedComments: [],
      failingChecks: [],
      pendingChecks: [{ name: "docker" }],
    }),
    "watch-ci",
  );
  assert.equal(
    chooseNextAction({
      pr,
      conflicts: false,
      unresolvedComments: [],
      failingChecks: [],
      pendingChecks: [],
    }),
    "ready",
  );
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

test("evaluateSnapshot flags behind without making it the next action", () => {
  const report = evaluateSnapshot({
    pr: { number: 3, mergeable: "MERGEABLE", mergeStateStatus: "BEHIND", title: "x" },
    reviewThreads: [],
    statusCheckRollup: [{ name: "Web CI", conclusion: "SUCCESS", status: "COMPLETED" }],
  });
  assert.equal(report.behind, true);
  assert.equal(report.nextAction, "ready");
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

test("skill documents the helper and never-merge rule", () => {
  const skill = readFileSync(new URL("../.agents/skills/autopilot/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /^name: autopilot$/m);
  assert.match(skill, /pr-state\.mjs/);
  assert.match(skill, /Never merge the PR/);
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
