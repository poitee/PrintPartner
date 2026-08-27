#!/usr/bin/env node
/**
 * Print a compact Autopilot snapshot for the current (or given) GitHub PR.
 * Agents must refresh this at the start of every pass and follow nextAction.
 */

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const MAX_COMMENT_CHARS = 600;

export const BOT_LOGINS = new Set([
  "codecov",
  "codecov-commenter",
  "coderabbitai",
  "coderabbitai[bot]",
  "copilot",
  "copilot[bot]",
  "cursor",
  "cursor[bot]",
  "dependabot",
  "dependabot[bot]",
  "github-actions",
  "github-actions[bot]",
  "linear",
  "linear[bot]",
  "renovate",
  "renovate[bot]",
]);

const FAILING_CONCLUSIONS = new Set([
  "FAILURE",
  "CANCELLED",
  "CANCELED",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "STALE",
]);

const PENDING_STATUSES = new Set([
  "PENDING",
  "QUEUED",
  "IN_PROGRESS",
  "WAITING",
  "REQUESTED",
  "EXPECTED",
]);

export function isBotLogin(login) {
  if (!login) return false;
  return BOT_LOGINS.has(login.toLowerCase()) || login.toLowerCase().endsWith("[bot]");
}

export function truncate(text, max = MAX_COMMENT_CHARS) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function nodesOf(connectionOrArray) {
  if (!connectionOrArray) return [];
  if (Array.isArray(connectionOrArray)) return connectionOrArray;
  return connectionOrArray.nodes ?? [];
}

export function summarizeThreads(reviewThreads) {
  const unresolved = [];
  for (const thread of reviewThreads ?? []) {
    if (thread?.isResolved) continue;
    const comments = nodesOf(thread.comments);
    const latest = comments.at(-1) ?? comments[0] ?? {};
    const first = comments[0] ?? latest;
    unresolved.push({
      threadId: thread.id ?? null,
      path: thread.path ?? first.path ?? latest.path ?? null,
      line: latest.line ?? latest.originalLine ?? first.line ?? first.originalLine ?? null,
      url: latest.url ?? first.url ?? null,
      author: latest.author?.login ?? first.author?.login ?? null,
      body: truncate(latest.body ?? first.body ?? ""),
      outdated: Boolean(thread.isOutdated),
    });
  }
  return unresolved;
}

export function classifyChecks(statusCheckRollup) {
  const failing = [];
  const pending = [];
  const passed = [];
  for (const check of statusCheckRollup ?? []) {
    const name = check.name ?? check.context ?? "unknown";
    const status = String(check.status ?? check.state ?? "").toUpperCase();
    const conclusion = String(check.conclusion ?? "").toUpperCase();
    const entry = {
      name,
      status: status || null,
      conclusion: conclusion || null,
      url: check.detailsUrl ?? check.targetUrl ?? check.link ?? null,
    };
    if (FAILING_CONCLUSIONS.has(conclusion) || status === "FAILURE") {
      failing.push(entry);
    } else if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion) || status === "SUCCESS") {
      passed.push(entry);
    } else if (PENDING_STATUSES.has(status) || !conclusion) {
      pending.push(entry);
    } else {
      failing.push(entry);
    }
  }
  return { failing, pending, passed };
}

export function summarizeIssueComments(issueComments) {
  return (issueComments ?? [])
    .filter((comment) => !isBotLogin(comment.user?.login ?? comment.author?.login))
    .map((comment) => ({
      id: comment.id ?? comment.databaseId ?? null,
      url: comment.html_url ?? comment.url ?? null,
      author: comment.user?.login ?? comment.author?.login ?? null,
      body: truncate(comment.body ?? ""),
    }));
}

export function chooseNextAction({
  pr,
  conflicts,
  unresolvedComments,
  failingChecks,
  pendingChecks,
}) {
  if (!pr) return "no-pr";
  if (conflicts) return "conflicts";
  if (unresolvedComments.length > 0) return "comments";
  if (failingChecks.length > 0) return "ci";
  if (pendingChecks.length > 0) return "watch-ci";
  return "ready";
}

export function evaluateSnapshot(snapshot = {}) {
  const pr = snapshot.pr ?? null;
  const unresolvedComments = summarizeThreads(snapshot.reviewThreads);
  const checks = classifyChecks(snapshot.statusCheckRollup);
  const conversationComments = summarizeIssueComments(snapshot.issueComments);
  const mergeable = pr?.mergeable ?? null;
  const mergeStateStatus = pr?.mergeStateStatus ?? null;
  const conflicts =
    mergeable === "CONFLICTING" ||
    mergeStateStatus === "DIRTY" ||
    Boolean(snapshot.conflicts);
  const behind = mergeStateStatus === "BEHIND" || Boolean(snapshot.behind);
  const nextAction = chooseNextAction({
    pr,
    conflicts,
    unresolvedComments,
    failingChecks: checks.failing,
    pendingChecks: checks.pending,
  });

  return {
    nextAction,
    mergeable: mergeable ?? (pr ? "UNKNOWN" : null),
    mergeStateStatus: mergeStateStatus ?? null,
    conflicts,
    behind,
    pr: pr
      ? {
          number: pr.number,
          url: pr.url ?? pr.html_url ?? null,
          title: pr.title ?? null,
          isDraft: Boolean(pr.isDraft),
          baseRefName: pr.baseRefName ?? pr.base ?? null,
          headRefName: pr.headRefName ?? pr.head ?? null,
        }
      : null,
    unresolvedComments,
    conversationComments,
    failingChecks: checks.failing,
    pendingChecks: checks.pending,
    passedCheckCount: checks.passed.length,
  };
}

function runGh(args) {
  const result = spawnSync("gh", args, { encoding: "utf8" });
  if (result.status !== 0) {
    const err = new Error((result.stderr || result.stdout || "gh failed").trim());
    err.exitCode = result.status ?? 1;
    err.ghArgs = args;
    throw err;
  }
  return result.stdout;
}

function ghJson(args) {
  return JSON.parse(runGh(args));
}

const THREADS_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          comments(first: 20) {
            nodes {
              databaseId
              body
              url
              path
              line
              originalLine
              author { login }
            }
          }
        }
      }
    }
  }
}
`;

function fetchReviewThreadsPaged({ owner, name, number }) {
  const threads = [];
  let cursor = null;
  do {
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${THREADS_QUERY}`,
      "-F",
      `owner=${owner}`,
      "-F",
      `name=${name}`,
      "-F",
      `number=${number}`,
    ];
    if (cursor) args.push("-F", `cursor=${cursor}`);
    const data = ghJson(args);
    const conn = data?.data?.repository?.pullRequest?.reviewThreads;
    if (data?.errors?.length) {
      throw new Error(data.errors.map((item) => item.message).join("; "));
    }
    threads.push(...(conn?.nodes ?? []));
    const page = conn?.pageInfo;
    cursor = page?.hasNextPage ? page.endCursor : null;
  } while (cursor);
  return threads;
}

export function fetchLiveSnapshot({ prNumber } = {}) {
  let pr;
  try {
    const fields =
      "number,title,url,isDraft,baseRefName,headRefName,mergeable,mergeStateStatus,statusCheckRollup";
    pr = ghJson(
      prNumber
        ? ["pr", "view", String(prNumber), "--json", fields]
        : ["pr", "view", "--json", fields],
    );
  } catch (error) {
    const message = String(error.message || error);
    if (/no pull requests found|could not find|not found/i.test(message)) {
      return evaluateSnapshot({ pr: null });
    }
    throw error;
  }

  const repo = ghJson(["repo", "view", "--json", "nameWithOwner"]);
  const [owner, name] = String(repo.nameWithOwner).split("/");
  const reviewThreads = fetchReviewThreadsPaged({
    owner,
    name,
    number: pr.number,
  });
  let issueComments = [];
  try {
    issueComments = ghJson([
      "api",
      `repos/${owner}/${name}/issues/${pr.number}/comments`,
    ]);
    if (!Array.isArray(issueComments)) issueComments = [];
  } catch {
    issueComments = [];
  }

  return evaluateSnapshot({
    pr,
    reviewThreads,
    statusCheckRollup: pr.statusCheckRollup ?? [],
    issueComments,
  });
}

export function renderReport(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function printHelp() {
  return `Usage: node pr-state.mjs [--pr <number>] [--fixture <path>]

Print a compact Autopilot JSON snapshot for a GitHub pull request.

  --pr N         Pull request number (default: PR for the current branch)
  --fixture PATH Evaluate a saved snapshot instead of calling gh
`;
}

export function parseArgs(argv) {
  const args = { pr: null, fixture: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--help" || token === "-h") args.help = true;
    else if (token === "--pr") {
      args.pr = Number(argv[i + 1]);
      i += 1;
    } else if (token === "--fixture") {
      args.fixture = argv[i + 1];
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  if (args.pr != null && !Number.isInteger(args.pr)) {
    throw new Error("--pr must be an integer");
  }
  return args;
}

export function main(argv = process.argv.slice(2), io = process) {
  const args = parseArgs(argv);
  if (args.help) {
    io.stdout.write(printHelp());
    return 0;
  }
  const report = args.fixture
    ? evaluateSnapshot(JSON.parse(readFileSync(args.fixture, "utf8")))
    : fetchLiveSnapshot({ prNumber: args.pr });
  io.stdout.write(renderReport(report));
  return 0;
}

const isDirect =
  Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isDirect) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.exitCode ?? 1;
  }
}
