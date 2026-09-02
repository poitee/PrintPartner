import { Octokit } from "@octokit/rest";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import {
  LocalSourceSnapshotStore,
  sourceRelativePath,
  type OmittedSnapshotFile,
  type PublishedSourceSnapshot,
  type SnapshotFile,
  type SnapshotFileKind,
  type SnapshotFileResponse,
} from "./local-source-snapshot.js";
import { summarizeRepoTreePaths, type RepoTreeSummary } from "./repo-tree-summary.js";

function safeRepoFilePath(repoDir: string, relativePath: string): string | null {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("..")) return null;
  const root = resolve(repoDir);
  const dest = resolve(root, normalized);
  if (dest !== root && !dest.startsWith(`${root}/`)) return null;
  return dest;
}

export type GithubRepoRef = {
  owner: string;
  repo: string;
  branch: string;
  branchFromUrl: boolean;
};

function decodeGithubPathSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function parseGithubUrl(url: string): GithubRepoRef | null {
  const trimmed = url.trim();
  const ssh = trimmed.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (ssh) {
    return {
      owner: ssh[1],
      repo: ssh[2],
      branch: "main",
      branchFromUrl: false,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    (parsed.hostname.toLowerCase() !== "github.com" &&
      parsed.hostname.toLowerCase() !== "www.github.com")
  ) {
    return null;
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const owner = decodeGithubPathSegment(segments[0]!);
  const decodedRepo = decodeGithubPathSegment(segments[1]!);
  const repo = decodedRepo?.replace(/\.git$/i, "") ?? null;
  if (!owner || !repo) return null;
  if (segments.length === 2) {
    return { owner, repo, branch: "main", branchFromUrl: false };
  }

  const pageKind = segments[2]?.toLowerCase();
  if ((pageKind !== "tree" && pageKind !== "blob") || !segments[3]) return null;
  const branch = decodeGithubPathSegment(segments[3]!);
  if (!branch) return null;
  return { owner, repo, branch, branchFromUrl: true };
}

export function normalizeGithubSourceLocation(
  url: string,
  branch?: string | null,
): { url: string; branch: string } | null {
  const parsed = parseGithubUrl(url);
  if (!parsed) return null;
  return {
    url: `https://github.com/${parsed.owner}/${parsed.repo}`,
    branch: parsed.branchFromUrl ? parsed.branch : branch?.trim() || parsed.branch,
  };
}

export async function listGithubBranches(
  url: string,
  token?: string | null,
): Promise<{
  owner: string;
  repo: string;
  default_branch: string;
  url_branch: string | null;
  branches: string[];
}> {
  const ref = parseGithubUrl(url);
  if (!ref) throw new Error("Invalid GitHub repository URL");
  const octokit = new Octokit(token ? { auth: token } : {});
  const repoMeta = await octokit.repos.get({ owner: ref.owner, repo: ref.repo });
  const branches = await octokit.paginate(octokit.repos.listBranches, {
    owner: ref.owner,
    repo: ref.repo,
    per_page: 100,
  });
  return {
    owner: ref.owner,
    repo: ref.repo,
    default_branch: repoMeta.data.default_branch ?? ref.branch,
    url_branch: ref.branchFromUrl ? ref.branch : null,
    branches: branches.map((b) => b.name),
  };
}

export async function listGithubTags(
  url: string,
  token?: string | null,
): Promise<{ owner: string; repo: string; tags: string[] }> {
  const ref = parseGithubUrl(url);
  if (!ref) throw new Error("Invalid GitHub repository URL");
  const octokit = new Octokit(token ? { auth: token } : {});
  const tags = await octokit.paginate(octokit.repos.listTags, {
    owner: ref.owner,
    repo: ref.repo,
    per_page: 100,
  });
  return {
    owner: ref.owner,
    repo: ref.repo,
    tags: tags.map((t) => t.name),
  };
}

export type SyncDocKind = "readme" | "md" | "pdf";

export type SyncDocEntry = {
  path: string;
  kind: SyncDocKind;
  sizeBytes: number;
};

export type SyncProgress = {
  phase: "stls" | "docs";
  current: number;
  total: number;
  path?: string;
  message?: string;
};

export type SyncResult = {
  commitSha: string;
  snapshot: PublishedSourceSnapshot;
  stlPaths: string[];
  downloaded: number;
  docPaths: SyncDocEntry[];
  docsDownloaded: number;
  docsSkippedBytes: number;
};

function classifyDocPath(path: string): SyncDocKind | null {
  const lower = path.toLowerCase();
  if (!lower.endsWith(".md") && !lower.endsWith(".pdf")) return null;
  if (lower.endsWith(".pdf")) return "pdf";
  const base = lower.split("/").pop() ?? lower;
  if (base === "readme.md" || base.startsWith("readme.")) return "readme";
  return "md";
}

async function openRawFile(
  owner: string,
  repo: string,
  commitSha: string,
  path: string,
  token?: string | null,
  timeoutMs = 120_000,
): Promise<SnapshotFileResponse> {
  const segments = path.split("/").map(encodeURIComponent).join("/");
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${commitSha}/${segments}`;
  // Node fetch decompresses the body but retains the compressed Content-Length header.
  const headers: Record<string, string> = { "Accept-Encoding": "identity" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    throw new Error(`GitHub raw download failed for ${path}: HTTP ${res.status}`);
  }
  if (!res.body) throw new Error(`GitHub raw download returned no body for ${path}`);
  const contentLengthHeader = res.headers.get("content-length")?.trim();
  const parsedContentLength =
    contentLengthHeader == null || contentLengthHeader === ""
      ? null
      : Number(contentLengthHeader);
  const contentLengthBytes =
    parsedContentLength != null &&
    Number.isSafeInteger(parsedContentLength) &&
    parsedContentLength >= 0
      ? parsedContentLength
      : null;
  return {
    stream: Readable.fromWeb(res.body as import("node:stream/web").ReadableStream),
    contentLengthBytes,
  };
}

type RepoTreeEntry = {
  path: string;
  type: "blob" | "tree" | "commit";
  mode: string | null;
  size: number | null;
};

/** Resolve a ref to a commit and list the full recursive tree (no blob downloads). */
async function fetchGithubTreeEntries(
  octokit: Octokit,
  owner: string,
  repo: string,
  refName: string,
): Promise<{ commitSha: string; entries: RepoTreeEntry[]; truncated: boolean }> {
  // getCommit resolves any ref (branch, tag, or SHA), unlike getBranch which only accepts branches.
  const commitMeta = await octokit.repos.getCommit({ owner, repo, ref: refName });
  const commitSha = commitMeta.data.sha;
  const tree = await octokit.git.getTree({
    owner,
    repo,
    tree_sha: commitSha,
    recursive: "true",
  });
  const entries: RepoTreeEntry[] = [];
  for (const item of tree.data.tree) {
    if (
      !item.path ||
      (item.type !== "blob" && item.type !== "tree" && item.type !== "commit")
    ) continue;
    entries.push({
      path: item.path,
      type: item.type,
      mode: item.mode ?? null,
      size: typeof item.size === "number" ? item.size : null,
    });
  }
  return { commitSha, entries, truncated: tree.data.truncated === true };
}

export type GithubRepoTreeSummary = {
  owner: string;
  repo: string;
  ref: string;
  commit_sha: string | null;
  summary: RepoTreeSummary;
};

/**
 * Pre-sync repo inspection: fetch the recursive tree listing only and summarize
 * top-level dirs, STL counts, and variant-looking subfolders. No blob downloads.
 */
export async function fetchGithubRepoTreeSummary(
  url: string,
  ref?: string | null,
  token?: string | null,
): Promise<GithubRepoTreeSummary> {
  const parsed = parseGithubUrl(url);
  if (!parsed) throw new Error("Invalid GitHub repository URL");
  const octokit = new Octokit(token ? { auth: token } : {});
  let refName = parsed.branchFromUrl ? parsed.branch : ref?.trim() || parsed.branch;
  let resolved: { commitSha: string; entries: RepoTreeEntry[]; truncated: boolean };
  try {
    resolved = await fetchGithubTreeEntries(octokit, parsed.owner, parsed.repo, refName);
  } catch (e) {
    // URLs without an explicit branch default to "main"; fall back to the repo default branch.
    if (refName !== "main" || (ref && ref.trim())) throw e;
    const repoMeta = await octokit.repos.get({ owner: parsed.owner, repo: parsed.repo });
    const defaultBranch = repoMeta.data.default_branch;
    if (!defaultBranch || defaultBranch === refName) throw e;
    refName = defaultBranch;
    resolved = await fetchGithubTreeEntries(octokit, parsed.owner, parsed.repo, refName);
  }
  const blobPaths = resolved.entries.filter((e) => e.type === "blob").map((e) => e.path);
  return {
    owner: parsed.owner,
    repo: parsed.repo,
    ref: refName,
    commit_sha: resolved.commitSha,
    summary: summarizeRepoTreePaths(blobPaths, { truncated: resolved.truncated }),
  };
}

export type SyncGithubOptions = {
  maxStlFiles?: number;
  /** Timeout for each raw file response and body stream. */
  fileTimeoutMs?: number;
  tag?: string | null;
  /** Per-source docs budget (default 1 GiB). */
  maxDocsBytes?: number;
  onProgress?: (progress: SyncProgress) => void;
};

export type SyncGithubSourceInput = {
  url: string;
  branch: string;
  reposDir: string;
  sourceId: number;
  token?: string | null;
  options?: SyncGithubOptions;
};

function snapshotKind(path: string): SnapshotFileKind | null {
  if (path.toLowerCase().endsWith(".stl")) return "stl";
  return classifyDocPath(path);
}

function isRegularBlob(entry: RepoTreeEntry): boolean {
  return entry.type === "blob" && (entry.mode === "100644" || entry.mode === "100755");
}

function selectedTreeFiles(entries: readonly RepoTreeEntry[]): RepoTreeEntry[] {
  const selected: RepoTreeEntry[] = [];
  for (const entry of entries) {
    if (!snapshotKind(entry.path)) continue;
    if (!isRegularBlob(entry)) {
      throw new Error(`GitHub Source contains an unsupported selected entry: ${entry.path}`);
    }
    selected.push(entry);
  }
  return selected;
}

/** Resolve one GitHub commit and publish its selected files as an immutable snapshot. */
export async function syncGithubSource(input: SyncGithubSourceInput): Promise<SyncResult> {
  const { url, branch, reposDir, sourceId, token, options } = input;
  const ref = parseGithubUrl(url);
  if (!ref) throw new Error("Invalid GitHub repository URL");
  const octokit = new Octokit(token ? { auth: token } : {});

  const tagName = options?.tag?.trim() || null;
  const refName = tagName || (ref.branchFromUrl ? ref.branch : branch || ref.branch);
  const { commitSha, entries, truncated } = await fetchGithubTreeEntries(
    octokit,
    ref.owner,
    ref.repo,
    refName,
  );
  if (truncated) {
    throw new Error("GitHub returned a truncated repository tree; Source snapshot was not created");
  }
  if (!/^[a-f0-9]{40}$/i.test(commitSha)) {
    throw new Error("GitHub returned an invalid commit SHA");
  }

  const selectedEntries = selectedTreeFiles(entries);
  const stlBlobs = selectedEntries.filter((item) => snapshotKind(item.path) === "stl");
  const docBlobs = selectedEntries.filter((item) => snapshotKind(item.path) !== "stl");

  const stlPaths = stlBlobs.map((b) => b.path).sort();
  const maxStlFiles = options?.maxStlFiles ?? 500;
  if (!Number.isSafeInteger(maxStlFiles) || maxStlFiles < 0) {
    throw new Error("STL file limit must be a non-negative safe integer");
  }
  if (stlPaths.length > maxStlFiles) {
    throw new Error(
      `GitHub Source contains ${stlPaths.length} STL files, exceeding the limit of ${maxStlFiles}`,
    );
  }

  const maxDocsBytes = options?.maxDocsBytes ?? 1024 * 1024 * 1024;
  if (!Number.isSafeInteger(maxDocsBytes) || maxDocsBytes < 0) {
    throw new Error("Documentation byte limit must be a non-negative safe integer");
  }
  const fileTimeoutMs = options?.fileTimeoutMs ?? 120_000;
  if (!Number.isSafeInteger(fileTimeoutMs) || fileTimeoutMs <= 0) {
    throw new Error("GitHub file timeout must be a positive safe integer");
  }

  let docsBudgetUsed = 0;
  const selectedDocs: RepoTreeEntry[] = [];
  const omittedFiles: OmittedSnapshotFile[] = [];
  for (const entry of [...docBlobs].sort((a, b) => a.path.localeCompare(b.path))) {
    const kind = classifyDocPath(entry.path);
    if (!kind) continue;
    if (entry.size == null) {
      omittedFiles.push({
        path: sourceRelativePath(entry.path),
        kind,
        sizeHintBytes: null,
        reason: "unknown-document-size",
      });
      continue;
    }
    const size = entry.size;
    if (size > 0 && docsBudgetUsed + size > maxDocsBytes) {
      omittedFiles.push({
        path: sourceRelativePath(entry.path),
        kind,
        sizeHintBytes: entry.size,
        reason: "documentation-byte-budget",
      });
      continue;
    }
    selectedDocs.push(entry);
    docsBudgetUsed += size;
  }

  const files: SnapshotFile[] = [...stlBlobs, ...selectedDocs].map((entry) => ({
    path: sourceRelativePath(entry.path),
    kind: snapshotKind(entry.path)!,
    sizeHintBytes: entry.size,
  }));
  const totals = {
    stls: stlBlobs.length,
    docs: selectedDocs.length,
  };
  const progress = { stls: 0, docs: 0 };
  const store = new LocalSourceSnapshotStore({ reposDir });
  const snapshot = await store.materialize({
    sourceId,
    upstreamRevisionKey: commitSha,
    files,
    selection: {
      maxStlFiles,
      maxDocumentationBytes: maxDocsBytes,
      omittedFiles,
    },
    openFile: async (file) => {
      const phase = file.kind === "stl" ? "stls" : "docs";
      progress[phase] += 1;
      options?.onProgress?.({
        phase,
        current: progress[phase],
        total: totals[phase],
        path: file.path,
        message:
          phase === "stls"
            ? `Downloading STL ${progress[phase]}/${totals[phase]}`
            : `Downloading doc ${progress[phase]}/${totals[phase]}: ${file.path}`,
      });
      return openRawFile(ref.owner, ref.repo, commitSha, file.path, token, fileTimeoutMs);
    },
  });

  const snapshotStls = snapshot.files.filter((file) => file.kind === "stl");
  const snapshotDocs = snapshot.files.filter((file) => file.kind !== "stl");
  const docEntries: SyncDocEntry[] = snapshotDocs.map((entry) => {
    const kind = classifyDocPath(entry.path);
    if (!kind) throw new Error(`Published snapshot has an invalid document path: ${entry.path}`);
    return { path: entry.path, kind, sizeBytes: entry.sizeBytes };
  });
  const docsSkippedBytes = snapshot.selection.omittedFiles.reduce(
    (sum, file) => sum + (file.sizeHintBytes ?? 0),
    0,
  );

  return {
    commitSha,
    snapshot,
    stlPaths: snapshotStls.map((file) => file.path),
    downloaded: snapshotStls.length,
    docPaths: docEntries,
    docsDownloaded: snapshotDocs.length,
    docsSkippedBytes,
  };
}

export { classifyDocPath, safeRepoFilePath };
