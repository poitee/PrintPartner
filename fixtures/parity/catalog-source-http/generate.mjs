// Node String() and GitHub/category normalization for Source create and patch.
// Run from the repo root: node fixtures/parity/catalog-source-http/generate.mjs [--check]
import { readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const output = join(here, "node.json");

function slice(file, startMarker, endMarker) {
  const source = readFileSync(join(root, file), "utf8");
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Error(`missing ${startMarker}`);
  return source.slice(start, end).replaceAll("export ", "");
}

const githubFile = "web/apps/server/src/services/github-sync.ts";
const github = stripTypeScriptTypes(
  `${slice(githubFile, "function decodeGithubPathSegment", "async function resolveGithubRefName")}\n${slice(githubFile, "export function normalizeGithubSourceLocation", "export async function listGithubBranches")}`,
  { mode: "transform" },
);
const categories = stripTypeScriptTypes(
  slice("web/packages/contracts/src/source-category-tree.ts", "export const CATEGORY_PATH_SEPARATOR", "export function categoryLeafName"),
  { mode: "transform" },
);
const { normalizeGithubSourceLocation } = runInNewContext(`${github}\n({normalizeGithubSourceLocation})`, { URL });
const { normalizeCategoryPath } = runInNewContext(`${categories}\n({normalizeCategoryPath})`);

const trim = (value) => value.trim();
const text = (body, key) => (body[key] != null ? String(body[key]) : undefined);
function command(body, patch) {
  const sourceKind = text(body, "source_kind");
  const kind = (sourceKind ?? "github").toLowerCase();
  const requestedUrl = text(body, "url");
  const requestedBranch = text(body, "branch");
  const githubLocation = requestedUrl && (kind === "github" || kind === "git")
    ? normalizeGithubSourceLocation(requestedUrl, requestedBranch)
    : null;
  const metadata = body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
    ? body.metadata
    : undefined;
  return {
    name: patch ? text(body, "name") : String(body.name ?? ""),
    url: githubLocation?.url ?? requestedUrl,
    branch: githubLocation?.branch ?? requestedBranch,
    tag: patch ? (body.tag !== undefined ? (body.tag != null ? String(body.tag) : null) : undefined) : text(body, "tag"),
    source_kind: sourceKind,
    role: text(body, "role"),
    metadata,
  };
}
function summary(row) {
  const metadata = row.metadata ? { ...row.metadata } : null;
  const category = metadata && typeof metadata.category === "string" ? trim(metadata.category) || null : null;
  const sync = metadata?.sync_required === true || typeof metadata?.sync_error === "string";
  const status = metadata?.remote_update_status;
  return {
    name: row.name,
    url: row.url,
    source_kind: row.source_kind,
    source_type: row.source_type,
    role: row.role,
    category,
    branch: row.branch,
    tag: row.tag,
    content_available: true,
    last_synced_at: null,
    last_commit_sha: null,
    current_source_revision_id: null,
    docs_url: null,
    manifest_community_slug: null,
    metadata,
    naming_use_defaults: true,
    update_status: sync ? "unknown" : (status === "up_to_date" || status === "updates_available" || status === "unknown" ? status : null),
    update_checked_at: typeof metadata?.remote_checked_at === "string" ? metadata.remote_checked_at : null,
    doc_count: 0,
  };
}
function created(body) {
  const input = command(body, false);
  const kind = (input.source_kind ?? "github").toLowerCase();
  return summary({
    name: trim(input.name),
    url: input.url ?? "",
    branch: input.branch ?? "main",
    tag: input.tag != null && trim(input.tag) ? trim(input.tag) : null,
    source_kind: kind,
    source_type: kind === "github" || kind === "git" ? "git" : "local",
    role: input.role ?? "unassigned",
    metadata: input.metadata ?? null,
  });
}
function patched(previous, body) {
  const input = command(body, true);
  const row = {
    name: input.name != null ? trim(input.name) : previous.name,
    url: input.url ?? previous.url,
    branch: input.branch ?? previous.branch,
    tag: input.tag !== undefined ? (input.tag != null && trim(input.tag) ? trim(input.tag) : null) : previous.tag,
    source_kind: input.source_kind ?? previous.source_kind,
    source_type: previous.source_type,
    role: input.role ?? previous.role,
    metadata: previous.metadata ? { ...previous.metadata } : null,
  };
  if (input.metadata) {
    row.metadata = { ...(row.metadata ?? {}), ...input.metadata };
    if (typeof row.metadata.category === "string") row.metadata.category = normalizeCategoryPath(row.metadata.category);
  }
  const identity = (input.url != null && input.url !== previous.url)
    || (input.branch != null && input.branch !== previous.branch)
    || (input.source_kind != null && input.source_kind !== previous.source_kind)
    || (input.tag !== undefined && row.tag !== previous.tag);
  if (identity) {
    row.metadata = { ...(row.metadata ?? {}) };
    row.metadata.sync_required = true;
    row.metadata.remote_update_status = "unknown";
    delete row.metadata.remote_checked_at;
    delete row.metadata.sync_error;
  }
  return summary(row);
}

const createBody = {
  name: 12,
  url: "https://github.com/Owner/Repo.git/tree/Feature/part.stl",
  branch: false,
  tag: [" v1 ", null],
  source_kind: "GitHub",
  role: { x: 1 },
  metadata: { category: " A / B ", note: 7, flag: true },
  source_type: 5,
};
const patchBody = {
  name: "  Library  ",
  tag: null,
  source_kind: 1,
  role: false,
  metadata: { category: " A / B / C " },
};
const create = created(createBody);
const fixture = { create: { body: createBody, source: create }, patch: { body: patchBody, source: patched(create, patchBody) } };
const textOut = `${JSON.stringify(fixture, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(output, "utf8") !== textOut) {
    console.error("catalog-source-http fixture is stale");
    process.exit(1);
  }
} else {
  writeFileSync(output, textOut);
}
console.log(`catalog source coercions ${process.argv.includes("--check") ? "verified" : "written"}`);
