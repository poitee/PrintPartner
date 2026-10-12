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

function checkIdentityKey(check) {
  const suite = check.checkSuite;
  const run = suite?.workflowRun;
  if (!check.id || !check.name || !suite?.app?.id) return null;
  if (run?.workflow?.id && run?.event) {
    return JSON.stringify([suite.app.id, run.workflow.id, run.event, check.name]);
  }
  if (!run) return JSON.stringify([suite.app.id, check.name]);
  return null;
}

function attemptTimeForDedupe(check) {
  const run = check.checkSuite?.workflowRun;
  if (Number.isInteger(run?.runAttempt) && run.runAttempt >= 1) {
    return Date.parse(check.startedAt);
  }
  // gh pr checks orders non-workflow CheckRuns by start time and app/name identity.
  if (!run && check.checkSuite?.app?.id) return Date.parse(check.startedAt);
  return NaN;
}


function finishedMemberIds(connection, cache) {
  if (!connection || typeof connection !== "object") return null;
  if (cache.has(connection)) return cache.get(connection);
  const ids = finishedLatestSet(connection);
  const set = ids ? new Set(ids) : null;
  cache.set(connection, set);
  return set;
}

function checkIsFinishedLatestMember(check, cache) {
  const ids = finishedMemberIds(check.checkSuite?.currentRuns, cache);
  return Boolean(check.id && ids?.has(check.id));
}

function suiteMembershipIncomplete(check) {
  const currentRuns = check.checkSuite?.currentRuns;
  return Boolean(currentRuns?.nodes?.length && currentRuns.pageInfo?.hasNextPage !== false);
}

function orphanSupersededInMembership(check, memberKeys) {
  const key = checkIdentityKey(check);
  const suiteId = check.checkSuite?.id;
  if (!key || !suiteId) return false;
  return Boolean(memberKeys.get(suiteId)?.has(key));
}

function suppressorBounds(records) {
  const bounds = new Map();
  for (const record of records) {
    if (!record.key || !record.finishedMember || record.membershipIncomplete) continue;
    if (!record.suiteId || !Number.isFinite(record.attemptTime)) continue;
    let bound = bounds.get(record.key);
    if (!bound) {
      bound = { bestSuite: null, bestTime: -Infinity, secondSuite: null, secondTime: -Infinity };
      bounds.set(record.key, bound);
    }
    if (record.attemptTime > bound.bestTime && record.suiteId !== bound.bestSuite) {
      bound.secondSuite = bound.bestSuite;
      bound.secondTime = bound.bestTime;
      bound.bestSuite = record.suiteId;
      bound.bestTime = record.attemptTime;
    } else if (record.suiteId === bound.bestSuite) {
      if (record.attemptTime > bound.bestTime) bound.bestTime = record.attemptTime;
    } else if (record.attemptTime > bound.secondTime) {
      bound.secondSuite = record.suiteId;
      bound.secondTime = record.attemptTime;
    }
  }
  return bounds;
}

function newerSuiteSuppresses(record, bounds) {
  if (!record.key || !record.suiteId || !Number.isFinite(record.attemptTime)) return false;
  const bound = bounds.get(record.key);
  if (!bound?.bestSuite) return false;
  if (record.suiteId !== bound.bestSuite && bound.bestTime > record.attemptTime) return true;
  if (bound.secondSuite && record.suiteId !== bound.secondSuite && bound.secondTime > record.attemptTime) return true;
  return false;
}

function currentChecks(checks) {
  const cache = new Map();
  const memberKeys = new Map();
  for (const check of checks) {
    if (!checkIsFinishedLatestMember(check, cache)) continue;
    const key = checkIdentityKey(check);
    const suiteId = check.checkSuite?.id;
    if (!key || !suiteId) continue;
    let keys = memberKeys.get(suiteId);
    if (!keys) {
      keys = new Set();
      memberKeys.set(suiteId, keys);
    }
    keys.add(key);
  }
  const candidates = checks.filter((check) => {
    const currentRuns = check.checkSuite?.currentRuns;
    const ids = finishedMemberIds(currentRuns, cache);
    if (!check.id || !ids) return true;
    if (ids.has(check.id)) return true;
    if (currentRuns.membershipAuthoritative === true) return !orphanSupersededInMembership(check, memberKeys);
    return false;
  });
  const records = candidates.map((check) => ({
    check,
    key: checkIdentityKey(check),
    suiteId: check.checkSuite?.id,
    attemptTime: attemptTimeForDedupe(check),
    membershipIncomplete: suiteMembershipIncomplete(check),
    finishedMember: checkIsFinishedLatestMember(check, cache),
  }));
  const bounds = suppressorBounds(records);
  return records.filter((record) => !newerSuiteSuppresses(record, bounds)).map(({ check }) => check);
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

// Published default from GitHub's Actions limits. Support can raise it, and
// this helper has no quota query, so a larger count stays unknown.
const CHECK_RUN_PAGE_SIZE = 100;
const DOCUMENTED_MAX_CHECK_RUNS_PER_SUITE = 50000;

const SUITE_LATEST_RUNS_QUERY = `
query($owner: String!, $name: String!, $oid: GitObjectID!, $suiteId: ID!, $cursor: String) {
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

function exactLatestIds(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) return null;
  const ids = [];
  const seen = new Set();
  for (const node of nodes) {
    if (!node || typeof node.id !== "string" || node.id.length === 0 || seen.has(node.id)) return null;
    seen.add(node.id);
    ids.push(node.id);
  }
  return ids;
}

function connectionCursor(pageInfo) {
  if (!pageInfo || typeof pageInfo.hasNextPage !== "boolean") return undefined;
  if (!pageInfo.hasNextPage) return null;
  if (typeof pageInfo.endCursor !== "string" || pageInfo.endCursor.length === 0) return undefined;
  return pageInfo.endCursor;
}

function parseConnectionPage(connection, { requireCount = false, nodeIds = false } = {}) {
  if (!connection) return null;
  const endCursor = connectionCursor(connection.pageInfo);
  if (endCursor === undefined) return null;
  if (requireCount) {
    const count = connection.totalCount;
    if (!Number.isInteger(count) || count < 0 || count > DOCUMENTED_MAX_CHECK_RUNS_PER_SUITE) return null;
  }
  let ids = null;
  if (nodeIds) {
    ids = exactLatestIds(connection.nodes);
    if (!ids) return null;
  }
  return {
    nodes: connection.nodes,
    ids,
    totalCount: connection.totalCount,
    hasNextPage: connection.pageInfo.hasNextPage,
    endCursor,
  };
}

function parseLatestConnection(connection) {
  return parseConnectionPage(connection, { requireCount: true, nodeIds: true });
}

function latestRunPageBudget(totalCount) {
  if (!Number.isInteger(totalCount) || totalCount < 0 || totalCount > DOCUMENTED_MAX_CHECK_RUNS_PER_SUITE) return null;
  return Math.ceil(totalCount / CHECK_RUN_PAGE_SIZE);
}

function sameLatestSeed(seed, page) {
  if (!page || page.totalCount !== seed.totalCount || page.hasNextPage !== seed.hasNextPage) return false;
  if (!page.ids || page.ids.length !== seed.ids.length) return false;
  for (let index = 0; index < seed.ids.length; index += 1) {
    if (page.ids[index] !== seed.ids[index]) return false;
  }
  return true;
}

function finishedLatestSet(connection) {
  const page = parseLatestConnection(connection);
  if (!page || page.hasNextPage || page.ids.length !== page.totalCount) return null;
  return page.ids;
}

function sameLatestPage(group) {
  const first = parseLatestConnection(group[0]?.checkSuite?.currentRuns);
  if (!first?.hasNextPage) return null;
  for (const check of group.slice(1)) {
    const page = parseLatestConnection(check.checkSuite?.currentRuns);
    if (!page?.hasNextPage || page.endCursor !== first.endCursor || page.totalCount !== first.totalCount) return null;
    if (page.ids.length !== first.ids.length || page.ids.some((id, index) => id !== first.ids[index])) return null;
  }
  return first;
}

function parseLatestRunPage(data, { oid, suiteId }) {
  if (!data || data.errors?.length) return null;
  const commit = data.data?.repository?.object;
  const suite = data.data?.node;
  if (!commit || commit.oid !== oid || !suite || suite.id !== suiteId || suite.commit?.oid !== oid) return null;
  return parseLatestConnection(suite.checkRuns);
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
  const args = [
    "api", "graphql", "-f", `query=${SUITE_LATEST_RUNS_QUERY}`,
    "-F", `owner=${owner}`,
    "-F", `name=${name}`,
    "-F", `oid=${oid}`,
    "-F", `suiteId=${suiteId}`,
  ];
  if (cursor) args.push("-F", `cursor=${cursor}`);
  return ghJson(args);
}

function followLatestTail({ owner, name, oid, suiteId, seed }) {
  const ids = seed.ids.slice();
  const seenIds = new Set(ids);
  const seenCursors = new Set();
  const totalCount = seed.totalCount;
  const budget = latestRunPageBudget(totalCount);
  if (budget == null) return null;
  let cursor = seed.endCursor;
  let pages = 1;
  let finished = !seed.hasNextPage;
  while (cursor) {
    if (pages >= budget) break;
    if (seenCursors.has(cursor)) break;
    seenCursors.add(cursor);
    let data;
    try {
      data = fetchSuiteLatestPage({ owner, name, oid, suiteId, cursor });
    } catch {
      break;
    }
    const page = parseLatestRunPage(data, { oid, suiteId });
    if (!page || page.totalCount !== totalCount) break;
    if (page.hasNextPage && (page.endCursor === cursor || seenCursors.has(page.endCursor))) break;
    if (page.ids.some((id) => seenIds.has(id))) break;
    for (const id of page.ids) seenIds.add(id);
    ids.push(...page.ids);
    pages += 1;
    if (!page.hasNextPage) {
      finished = true;
      break;
    }
    cursor = page.endCursor;
  }
  if (!finished || ids.length !== totalCount || seenIds.size !== ids.length) return null;
  return ids;
}

function sameIdList(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function completeLatestRunMembership(checks, { owner, name, oid }) {
  let mixed = false;
  for (const [suiteId, group] of groupChecksBySuite(checks)) {
    const seed = sameLatestPage(group);
    if (!seed) continue;
    const ids = followLatestTail({ owner, name, oid, suiteId, seed });
    if (!ids) continue;
    // Two full walks can still tear between pages, and the suite can change
    // after the second walk. CheckSuite.updatedAt is not a version token.
    let again = null;
    try {
      again = parseLatestRunPage(
        fetchSuiteLatestPage({ owner, name, oid, suiteId, cursor: null }),
        { oid, suiteId },
      );
    } catch {
      mixed = true;
      continue;
    }
    if (!sameLatestSeed(seed, again)) {
      mixed = true;
      continue;
    }
    const confirmed = followLatestTail({ owner, name, oid, suiteId, seed: again });
    if (!sameIdList(ids, confirmed)) {
      mixed = true;
      continue;
    }
    const currentRuns = {
      membershipAuthoritative: true,
      totalCount: seed.totalCount,
      pageInfo: { hasNextPage: false },
      nodes: ids.map((id) => ({ id })),
    };
    for (const check of group) check.checkSuite.currentRuns = currentRuns;
  }
  return mixed;
}

function checkBlocks(check) {
  const status = String(check?.status ?? check?.state ?? "").toUpperCase();
  const conclusion = String(check?.conclusion ?? "").toUpperCase();
  if (FAILING_CONCLUSIONS.has(conclusion) || FAILING_STATUSES.has(status)) return true;
  if (PENDING_STATUSES.has(status)) return true;
  if (PASSING_CONCLUSIONS.has(conclusion) || status === "SUCCESS") return false;
  return true;
}

function preferObservation(earlier, later) {
  if (later.length === 0) return earlier;
  if (earlier.some(checkBlocks) && !later.some(checkBlocks)) return earlier;
  return later;
}

function rollupSignature(checks) {
  return checks.map((check) => [
    check?.id ?? "",
    check?.context ?? "",
    check?.name ?? "",
    check?.status ?? "",
    check?.conclusion ?? "",
    check?.state ?? "",
    check?.detailsUrl ?? check?.targetUrl ?? "",
  ].join("\u0000")).join("\n");
}

function readStatusContexts({ owner, name, oid }) {
  const checks = [];
  let cursor = null;
  let paged = false;
  const seen = new Set();
  do {
    if (cursor) {
      if (seen.has(cursor)) return { checks, complete: false, paged, signature: rollupSignature(checks) };
      seen.add(cursor);
      paged = true;
    }
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
    if (commit.statusCheckRollup == null) {
      if (cursor == null && checks.length === 0) {
        return { checks, complete: true, paged: false, signature: "" };
      }
      return { checks, complete: false, paged, signature: rollupSignature(checks) };
    }
    const conn = commit.statusCheckRollup.contexts;
    const page = parseConnectionPage(conn);
    if (!page) {
      if (Array.isArray(conn?.nodes)) checks.push(...conn.nodes);
      return { checks, complete: false, paged, signature: rollupSignature(checks) };
    }
    if (Array.isArray(page.nodes)) checks.push(...page.nodes);
    cursor = page.endCursor;
  } while (cursor);
  return { checks, complete: true, paged, signature: rollupSignature(checks) };
}

function fetchChecksPaged({ owner, name, oid }) {
  const first = readStatusContexts({ owner, name, oid });
  const mixedMembership = completeLatestRunMembership(first.checks, { owner, name, oid });
  if (!mixedMembership && !(first.complete && first.paged)) {
    return { checks: first.checks, complete: first.complete, mixed: false };
  }
  const second = readStatusContexts({ owner, name, oid });
  const rollupChanged = Boolean(first.paged) && (!second.complete || second.signature !== first.signature);
  if (!mixedMembership && !rollupChanged) {
    return { checks: first.checks, complete: first.complete, mixed: false };
  }
  const checks = preferObservation(first.checks, second.checks);
  return {
    checks: checks.length > 0 ? checks : first.checks,
    complete: rollupChanged ? false : second.complete,
    mixed: true,
  };
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
    const loaded = fetchChecksPaged({ owner, name, oid: pr.headRefOid });

    let confirmed;
    try {
      confirmed = viewPullRequest(prNumber);
    } catch (error) {
      if (error?.exitCode === 4 || error?.ghFailure === "launch") throw error;
      return unknownHeadSnapshot(pr);
    }
    if (confirmed.headRefOid && confirmed.headRefOid === pr.headRefOid) {
      const report = evaluateSnapshot({
        pr: confirmed,
        reviewThreads: threads,
        statusCheckRollup: loaded.checks,
        issueComments,
        viewerLogin,
      });
      if ((loaded.mixed || !loaded.complete) && report.nextAction === "ready") {
        report.nextAction = "recheck";
      }
      return report;
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
