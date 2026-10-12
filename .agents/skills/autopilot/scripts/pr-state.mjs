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

function currentChecks(checks) {
  const candidates = checks.filter((check) => {
    const currentRuns = check.checkSuite?.currentRuns;
    if (!check.id || currentRuns?.pageInfo?.hasNextPage !== false || !currentRuns.nodes?.length) {
      return true;
    }
    return currentRuns.nodes.some((run) => run.id === check.id);
  });
  const records = candidates.map((check) => {
    const suite = check.checkSuite;
    const run = suite?.workflowRun;
    const key = check.id && check.name && suite?.app?.id && run?.workflow?.id && run?.event
      ? JSON.stringify([suite.app.id, run.workflow.id, run.event, check.name])
      : null;
    let attemptTime = NaN;
    // gh pr checks keeps the later check start. Workflow creation time is a
    // different clock, and runAttempt belongs to the whole run, including a
    // check a partial rerun did not start again. Missing and tied starts stay.
    if (Number.isInteger(run?.runAttempt) && run.runAttempt >= 1) {
      attemptTime = Date.parse(check.startedAt);
    }
    return { check, key, suiteId: suite?.id, attemptTime };
  });
  return records.filter((record) => !records.some((other) => {
    if (!record.key || record.key !== other.key) return false;
    if (!record.suiteId || !other.suiteId || record.suiteId === other.suiteId) return false;
    if (!Number.isFinite(record.attemptTime) || !Number.isFinite(other.attemptTime)) return false;
    return other.attemptTime > record.attemptTime;
  })).map(({ check }) => check);
}

export function classifyChecks(statusCheckRollup) {
  const failing = [];
  const pending = [];
  const passed = [];
  for (const check of currentChecks(statusCheckRollup ?? [])) {
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

const CHECKS_QUERY = `
query($owner: String!, $name: String!, $oid: GitObjectID!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    object(oid: $oid) {
      ... on Commit {
        statusCheckRollup {
          contexts(first: 100, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              __typename
              ... on CheckRun {
                id name status conclusion detailsUrl startedAt
                checkSuite {
                  id
                  app { id }
                  currentRuns: checkRuns(first: 100, filterBy: { checkType: LATEST }) {
                    totalCount
                    pageInfo { hasNextPage endCursor }
                    nodes { id }
                  }
                  workflowRun { createdAt runAttempt event workflow { id } }
                }
              }
              ... on StatusContext { context state targetUrl }
            }
          }
        }
      }
    }
  }
}
`;

// A cursor that repeats, stalls, or never ends would otherwise request forever.
const MAX_LATEST_RUN_PAGES = 20;

const SUITE_LATEST_RUNS_QUERY = `
query($owner: String!, $name: String!, $oid: GitObjectID!, $suiteId: ID!, $cursor: String!) {
  repository(owner: $owner, name: $name) {
    object(oid: $oid) {
      ... on Commit { oid }
    }
  }
  node(id: $suiteId) {
    ... on CheckSuite {
      id
      commit { oid }
      checkRuns(first: 100, after: $cursor, filterBy: { checkType: LATEST }) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes { id }
      }
    }
  }
}
`;

function latestRunIds(nodes) {
  if (!Array.isArray(nodes)) return null;
  const ids = [];
  for (const node of nodes) {
    if (!node || typeof node.id !== "string" || node.id.length === 0) return null;
    ids.push(node.id);
  }
  return ids;
}

function sameLatestPage(group) {
  const first = group[0]?.checkSuite?.currentRuns;
  if (!first || first.pageInfo?.hasNextPage !== true) return null;
  const cursor = first.pageInfo.endCursor;
  if (typeof cursor !== "string" || cursor.length === 0) return null;
  const ids = latestRunIds(first.nodes);
  if (!ids?.length) return null;
  for (const check of group.slice(1)) {
    const page = check.checkSuite?.currentRuns;
    if (page?.pageInfo?.hasNextPage !== true || page.pageInfo.endCursor !== cursor) return null;
    const other = latestRunIds(page.nodes);
    if (!other || other.length !== ids.length || other.some((id, index) => id !== ids[index])) return null;
  }
  const totalCount = Number.isInteger(first.totalCount) && first.totalCount >= 0 ? first.totalCount : null;
  return { ids, cursor, totalCount };
}

function parseLatestRunPage(data, { oid, suiteId }) {
  if (!data || data.errors?.length) return null;
  const commit = data.data?.repository?.object;
  const suite = data.data?.node;
  if (!commit || commit.oid !== oid || !suite || suite.id !== suiteId || suite.commit?.oid !== oid) return null;
  const connection = suite.checkRuns;
  const info = connection?.pageInfo;
  if (!connection || !info || typeof info.hasNextPage !== "boolean") return null;
  if (!Number.isInteger(connection.totalCount) || connection.totalCount < 0) return null;
  if (info.hasNextPage && (typeof info.endCursor !== "string" || info.endCursor.length === 0)) return null;
  const ids = latestRunIds(connection.nodes);
  if (!ids) return null;
  return {
    ids,
    totalCount: connection.totalCount,
    hasNextPage: info.hasNextPage,
    endCursor: info.hasNextPage ? info.endCursor : null,
  };
}

function groupChecksBySuite(checks) {
  const groups = new Map();
  for (const check of checks) {
    const suiteId = check?.checkSuite?.id;
    if (!suiteId) continue;
    if (!groups.has(suiteId)) groups.set(suiteId, []);
    groups.get(suiteId).push(check);
  }
  return groups;
}

function fetchSuiteLatestPage({ owner, name, oid, suiteId, cursor }) {
  return ghJson([
    "api", "graphql", "-f", `query=${SUITE_LATEST_RUNS_QUERY}`,
    "-F", `owner=${owner}`,
    "-F", `name=${name}`,
    "-F", `oid=${oid}`,
    "-F", `suiteId=${suiteId}`,
    "-F", `cursor=${cursor}`,
  ]);
}

function completeLatestRunMembership(checks, { owner, name, oid }) {
  for (const [suiteId, group] of groupChecksBySuite(checks)) {
    const seed = sameLatestPage(group);
    if (!seed) continue;
    const ids = seed.ids.slice();
    const seen = new Set();
    let cursor = seed.cursor;
    let totalCount = seed.totalCount;
    let pages = 1;
    let finished = false;
    while (cursor) {
      if (pages >= MAX_LATEST_RUN_PAGES) break;
      if (seen.has(cursor)) break;
      seen.add(cursor);
      let data;
      try {
        data = fetchSuiteLatestPage({ owner, name, oid, suiteId, cursor });
      } catch {
        break;
      }
      const page = parseLatestRunPage(data, { oid, suiteId });
      if (!page) break;
      if (page.hasNextPage && (page.endCursor === cursor || seen.has(page.endCursor))) break;
      if (totalCount === null) totalCount = page.totalCount;
      else if (page.totalCount !== totalCount) break;
      ids.push(...page.ids);
      pages += 1;
      if (!page.hasNextPage) {
        finished = true;
        break;
      }
      cursor = page.endCursor;
    }
    if (!finished || !Number.isInteger(totalCount) || ids.length !== totalCount) continue;
    const currentRuns = {
      pageInfo: { hasNextPage: false },
      nodes: ids.map((id) => ({ id })),
    };
    for (const check of group) check.checkSuite.currentRuns = currentRuns;
  }
}

function fetchChecksPaged({ owner, name, oid }) {
  const checks = [];
  let cursor = null;
  do {
    const args = [
      "api", "graphql", "-f", `query=${CHECKS_QUERY}`,
      "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `oid=${oid}`,
    ];
    if (cursor) args.push("-F", `cursor=${cursor}`);
    const data = ghJson(args);
    if (data?.errors?.length) {
      throw new Error(data.errors.map((item) => item.message).join("; "));
    }
    const commit = data?.data?.repository?.object;
    if (!commit) throw new Error("Could not read pull request head checks");
    const conn = commit.statusCheckRollup?.contexts;
    checks.push(...(conn?.nodes ?? []));
    cursor = conn?.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);
  completeLatestRunMembership(checks, { owner, name, oid });
  return checks;
}

const PR_VIEW_FIELDS =
  "number,title,url,isDraft,baseRefName,headRefName,mergeable,mergeStateStatus,headRefOid";

function viewPullRequest(prNumber) {
  return ghJson(
    prNumber
      ? ["pr", "view", String(prNumber), "--json", PR_VIEW_FIELDS]
      : ["pr", "view", "--json", PR_VIEW_FIELDS],
  );
}

function unknownHeadSnapshot(pr) {
  return evaluateSnapshot({
    pr: {
      ...(pr ?? {}),
      mergeable: "UNKNOWN",
      mergeStateStatus: "UNKNOWN",
    },
  });
}

export function fetchLiveSnapshot({ prNumber } = {}) {
  // Read the repository first. A missing token, an SSO-blocked token, or an
  // unreachable repository fails here and surfaces its own message, which is
  // what lets a later `pr view` failure mean "no such pull request".
  const repo = ghJson(["repo", "view", "--json", "nameWithOwner"]);
  const [owner, name] = String(repo.nameWithOwner).split("/");
  let seen = null;

  for (let read = 0; read < 2; read += 1) {
    let pr;
    try {
      pr = viewPullRequest(prNumber);
    } catch (error) {
      if (isMissingPrError(error)) return evaluateSnapshot({ pr: null });
      throw error;
    }
    seen = pr;

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
    const statusCheckRollup = fetchChecksPaged({ owner, name, oid: pr.headRefOid });

    let confirmed;
    try {
      confirmed = viewPullRequest(prNumber);
    } catch (error) {
      if (error?.exitCode === 4 || error?.ghFailure === "launch") throw error;
      return unknownHeadSnapshot(pr);
    }
    if (confirmed.headRefOid && confirmed.headRefOid === pr.headRefOid) {
      return evaluateSnapshot({
        pr: confirmed,
        reviewThreads: threads,
        statusCheckRollup,
        issueComments,
        viewerLogin,
      });
    }
  }

  return unknownHeadSnapshot(seen);
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
