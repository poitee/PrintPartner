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
  "ERROR",
]);

// Legacy commit statuses carry a state instead of a conclusion.
const FAILING_STATUSES = new Set(["FAILURE", "ERROR"]);

const PASSING_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

const PENDING_STATUSES = new Set([
  "PENDING",
  "QUEUED",
  "IN_PROGRESS",
  "WAITING",
  "REQUESTED",
  "EXPECTED",
]);

// The only two merge states GitHub will merge from. DRAFT, BLOCKED, BEHIND,
// DIRTY, and UNKNOWN each mean the merge button is refused or not yet computed.
const READY_MERGE_STATES = new Set(["CLEAN", "UNSTABLE"]);

// gh returns 1 for a generic API error and 4 when authentication is required.
const GH_EXIT_ERROR = 1;

// `gh pr view --json ...,statusCheckRollup` on a busy PR overruns the 1 MiB
// spawnSync default, which truncates stdout into unparseable JSON.
const GH_MAX_BUFFER = 32 * 1024 * 1024;

export function isBotLogin(login) {
  if (!login) return false;
  return BOT_LOGINS.has(login.toLowerCase()) || login.toLowerCase().endsWith("[bot]");
}

export function truncate(text, max = MAX_COMMENT_CHARS) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

// A GitHub App comments as `cursor[bot]` while `viewer.login` reads `cursor`.
function normalizeLogin(login) {
  return String(login ?? "").toLowerCase().replace(/\[bot\]$/, "");
}

function nodesOf(connectionOrArray) {
  if (!connectionOrArray) return [];
  if (Array.isArray(connectionOrArray)) return connectionOrArray;
  return connectionOrArray.nodes ?? [];
}

/**
 * Split open review threads into ones still needing an answer and ones where
 * the viewer already replied last. The second group is waiting on a human, so
 * answering it again would only repeat the reply that is already there.
 */
export function summarizeThreads({ reviewThreads, viewerLogin = null } = {}) {
  const viewer = normalizeLogin(viewerLogin);
  const unresolved = [];
  const awaitingHuman = [];
  for (const thread of reviewThreads ?? []) {
    if (thread?.isResolved) continue;
    const comments = nodesOf(thread.comments);
    const latest = comments.at(-1) ?? comments[0] ?? {};
    const first = comments[0] ?? latest;
    const author = latest.author?.login ?? first.author?.login ?? null;
    const entry = {
      threadId: thread.id ?? null,
      path: thread.path ?? first.path ?? latest.path ?? null,
      line: latest.line ?? latest.originalLine ?? first.line ?? first.originalLine ?? null,
      url: latest.url ?? first.url ?? null,
      author,
      body: truncate(latest.body ?? first.body ?? ""),
      outdated: Boolean(thread.isOutdated),
    };
    if (viewer && normalizeLogin(author) === viewer) awaitingHuman.push(entry);
    else unresolved.push(entry);
  }
  return { unresolved, awaitingHuman };
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
    if (FAILING_CONCLUSIONS.has(conclusion) || FAILING_STATUSES.has(status)) {
      failing.push(entry);
    } else if (PASSING_CONCLUSIONS.has(conclusion) || status === "SUCCESS") {
      passed.push(entry);
    } else if (PENDING_STATUSES.has(status)) {
      pending.push(entry);
    } else {
      // Neither a known pending status nor a known outcome. Surface it as work
      // to look at rather than a check the agent can wait out.
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
  conflicts = false,
  mergeabilityUnknown = false,
  unresolvedComments = [],
  failingChecks = [],
  pendingChecks = [],
  isDraft = false,
  behind = false,
  mergeStateStatus = null,
}) {
  if (!pr) return "no-pr";
  if (conflicts) return "conflicts";
  // An unknown mergeability read can still turn out to be a conflict, so hold
  // comment and CI work until GitHub has computed it.
  if (mergeabilityUnknown) return "recheck";
  if (unresolvedComments.length > 0) return "comments";
  if (failingChecks.length > 0) return "ci";
  if (pendingChecks.length > 0) return "watch-ci";
  if (isDraft || mergeStateStatus === "DRAFT") return "draft";
  if (mergeStateStatus === "BLOCKED") return "blocked";
  // Merging the base last keeps the branch from going stale again mid-pass.
  if (behind) return "behind";
  if (!READY_MERGE_STATES.has(mergeStateStatus)) return "recheck";
  return "ready";
}

export function evaluateSnapshot(snapshot = {}) {
  const pr = snapshot.pr ?? null;
  const { unresolved, awaitingHuman } = summarizeThreads({
    reviewThreads: snapshot.reviewThreads,
    viewerLogin: snapshot.viewerLogin ?? null,
  });
  const checks = classifyChecks(snapshot.statusCheckRollup);
  const conversationComments = summarizeIssueComments(snapshot.issueComments);
  const mergeable = pr ? (pr.mergeable ?? "UNKNOWN") : null;
  const mergeStateStatus = pr?.mergeStateStatus ?? null;
  const conflicts =
    mergeable === "CONFLICTING" ||
    mergeStateStatus === "DIRTY" ||
    Boolean(snapshot.conflicts);
  const mergeabilityUnknown = Boolean(pr) && !conflicts && mergeable === "UNKNOWN";
  const behind = mergeStateStatus === "BEHIND" || Boolean(snapshot.behind);
  const isDraft = Boolean(pr?.isDraft);
  const nextAction = chooseNextAction({
    pr,
    conflicts,
    mergeabilityUnknown,
    unresolvedComments: unresolved,
    failingChecks: checks.failing,
    pendingChecks: checks.pending,
    isDraft,
    behind,
    mergeStateStatus,
  });

  return {
    nextAction,
    mergeable,
    mergeStateStatus,
    conflicts,
    behind,
    pr: pr
      ? {
          number: pr.number,
          url: pr.url ?? pr.html_url ?? null,
          title: pr.title ?? null,
          isDraft,
          baseRefName: pr.baseRefName ?? pr.base ?? null,
          headRefName: pr.headRefName ?? pr.head ?? null,
        }
      : null,
    unresolvedComments: unresolved,
    awaitingHumanComments: awaitingHuman,
    conversationComments,
    failingChecks: checks.failing,
    pendingChecks: checks.pending,
    passedCheckCount: checks.passed.length,
  };
}

/**
 * Turn a spawnSync result into stdout or a labelled error. spawnSync reports a
 * missing binary and an ENOBUFS overrun through `result.error` with a null
 * status, so that has to be read before the exit code.
 */
export function readGhResult({ args, result }) {
  const label = `gh ${args.slice(0, 3).join(" ")}`;
  if (result.error) {
    const error = new Error(`${label} could not run: ${result.error.message}`);
    error.ghFailure = "launch";
    error.exitCode = null;
    error.ghArgs = args;
    error.cause = result.error;
    throw error;
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    const cause = result.signal ? `killed by ${result.signal}` : `exited ${result.status}`;
    const error = new Error(`${label} ${cause}: ${detail || "no output"}`);
    error.ghFailure = "exit";
    error.exitCode = result.status ?? GH_EXIT_ERROR;
    error.ghArgs = args;
    throw error;
  }
  return result.stdout;
}

/**
 * True when a `gh pr view` failure means the pull request itself is absent.
 * Only sound once repository access has been probed: an unreachable repository
 * or an unauthorized token fails with the same exit code.
 */
export function isMissingPrError(error) {
  return error?.ghFailure === "exit" && error.exitCode === GH_EXIT_ERROR;
}

function runGh(args) {
  const result = spawnSync("gh", args, { encoding: "utf8", maxBuffer: GH_MAX_BUFFER });
  return readGhResult({ args, result });
}

function ghJson(args) {
  return JSON.parse(runGh(args));
}

const THREADS_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  viewer { login }
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
  let viewerLogin = null;
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
    if (data?.errors?.length) {
      throw new Error(data.errors.map((item) => item.message).join("; "));
    }
    viewerLogin = data?.data?.viewer?.login ?? viewerLogin;
    const conn = data?.data?.repository?.pullRequest?.reviewThreads;
    threads.push(...(conn?.nodes ?? []));
    const page = conn?.pageInfo;
    cursor = page?.hasNextPage ? page.endCursor : null;
  } while (cursor);
  return { threads, viewerLogin };
}

export function fetchLiveSnapshot({ prNumber } = {}) {
  // Read the repository first. A missing token, an SSO-blocked token, or an
  // unreachable repository fails here and surfaces its own message, which is
  // what lets a later `pr view` failure mean "no such pull request".
  const repo = ghJson(["repo", "view", "--json", "nameWithOwner"]);
  const [owner, name] = String(repo.nameWithOwner).split("/");

  const fields =
    "number,title,url,isDraft,baseRefName,headRefName,mergeable,mergeStateStatus,statusCheckRollup";
  let pr;
  try {
    pr = ghJson(
      prNumber
        ? ["pr", "view", String(prNumber), "--json", fields]
        : ["pr", "view", "--json", fields],
    );
  } catch (error) {
    if (isMissingPrError(error)) return evaluateSnapshot({ pr: null });
    throw error;
  }

  const { threads, viewerLogin } = fetchReviewThreadsPaged({
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
    reviewThreads: threads,
    statusCheckRollup: pr.statusCheckRollup ?? [],
    issueComments,
    viewerLogin,
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
