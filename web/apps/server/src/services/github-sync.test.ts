import * as pdfText from "./pdf-text-extract.js";
import { measureTenantDiskUsage, TenantDiskQuotaError } from "../lib/tenant-disk-quota.js";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const github = vi.hoisted(() => ({
  getCommit: vi.fn(),
  getTree: vi.fn(),
  getRepo: vi.fn(),
  listBranches: vi.fn(),
  paginate: vi.fn(),
}));

vi.mock("@octokit/rest", () => ({
  Octokit: class {
    repos = {
      get: github.getRepo,
      getCommit: github.getCommit,
      listBranches: github.listBranches,
    };
    git = { getTree: github.getTree };
    paginate = github.paginate;
  },
}));

import { createSelfHostPorts } from "../adapters/self-host/index.js";
import { createJobRunner } from "./job-runner.js";
import { publishLocalSourceWorkingTree } from "./local-source-revision.js";
import { beginSourceSyncAdmission, packagedSourceSyncManifestPath } from "../ownership/source-sync-admission.js";
import { syncProjectById } from "../routes/sources.js";
import {
  listGithubBranches,
  normalizeGithubSourceLocation,
  parseGithubUrl,
  resolveGithubUrlRef,
  syncGithubSource,
} from "./github-sync.js";
import { LocalSourceSnapshotStore, sharedSnapshotHolderCount, sourceRelativePath } from "./local-source-snapshot.js";

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const roots: string[] = [];
const PHASE_MANIFEST_LIMIT_BYTES = 1024 * 1024;

type TreeItem = {
  path: string;
  type: "blob" | "tree" | "commit";
  mode: string;
  size?: number;
  sha?: string;
};

function revisionNames(reposDir: string, sourceId: number): string[] {
  const root = join(reposDir, String(sourceId), "revisions");
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((name) => !name.startsWith(".")).sort();
}

function fileBytes(path: string): number {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory()) return 0;
  if (stat.isFile()) return stat.size;
  return readdirSync(path).reduce((sum, name) => sum + fileBytes(join(path, name)), 0);
}

function reposRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pp-github-sync-"));
  roots.push(root);
  return root;
}

function setTree(commitSha: string, items: TreeItem[], truncated = false): void {
  github.getCommit.mockResolvedValue({ data: { sha: commitSha } });
  github.getTree.mockResolvedValue({ data: { truncated, tree: items } });
}

function rawResponse(contentByPath: Record<string, string>) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    const path = decodeURIComponent(new URL(url).pathname.split("/").slice(4).join("/"));
    const content = contentByPath[path];
    if (content == null) return new Response("missing", { status: 404 });
    return new Response(content, {
      status: 200,
      headers: { "content-length": String(Buffer.byteLength(content)) },
    });
  });
}

beforeEach(() => {
  github.getCommit.mockReset();
  github.getTree.mockReset();
  github.getRepo.mockReset();
  github.listBranches.mockReset();
  github.paginate.mockReset();
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("atomic GitHub Source sync", () => {
  it("does not overwrite an upload that publishes during a pending sync", async () => {
    const dataDir = reposRoot();
    const ports = createSelfHostPorts(dataDir);
    await ports.db.connect();
    const repo = ports.repository!;
    const source = repo.createSource({ name: "Concurrent kit", url: "https://github.com/example/kit", source_kind: "github" });
    let fetched!: () => void;
    const fetching = new Promise<void>((resolve) => { fetched = resolve; });
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    setTree(COMMIT_A, [{ path: "remote.stl", type: "blob", mode: "100644", size: 6 }]);
    vi.stubGlobal("fetch", vi.fn(async () => {
      fetched();
      await gate;
      return new Response("remote", { status: 200, headers: { "content-length": "6" } });
    }));
    const syncing = syncProjectById(repo, repo.reposDir, source.id);
    await fetching;
    const candidate = join(dataDir, "upload-candidate");
    mkdirSync(candidate);
    writeFileSync(join(candidate, "upload.stl"), "upload wins");
    const uploaded = await publishLocalSourceWorkingTree({ repo, reposDir: repo.reposDir, sourceId: source.id, workingTree: candidate });
    resume();
    await expect(syncing).rejects.toThrow("Source changed during sync");
    const active = repo.getSource(source.id);
    expect(active?.local_path).toBe(uploaded.local_path);
    expect(readFileSync(join(uploaded.local_path!, "upload.stl"), "utf8")).toBe("upload wins");
    expect(readdirSync(uploaded.local_path!).sort()).toEqual([".printpartner-source-snapshot.json", "upload.stl"]);
    expect(revisionNames(repo.reposDir, source.id)).toEqual([basename(uploaded.local_path!)]);
    expect(repo.listSourceRevisions(source.id).map((revision) => revision.snapshot_locator)).toEqual([
      `${source.id}/revisions/${basename(uploaded.local_path!)}`,
    ]);
    expect(await measureTenantDiskUsage({
      dataDir, reposDir: repo.reposDir, tenantId: "default", sourceIds: [source.id],
    })).toBe(fileBytes(join(repo.reposDir, String(source.id))));
    await ports.db.close();
  });

  it("review preserves an in-flight unregistered Git reuser when the creator loses", async () => {
    const dataDir = reposRoot();
    const ports = createSelfHostPorts(dataDir);
    await ports.db.connect();
    const repo = ports.repository!;
    const source = repo.createSource({ name: "Shared Git", url: "https://github.com/example/kit", source_kind: "github" });
    setTree(COMMIT_A, [{ path: "remote.stl", type: "blob", mode: "100644", size: 6 }]);
    vi.stubGlobal("fetch", rawResponse({ "remote.stl": "remote" }));
    const real = LocalSourceSnapshotStore.prototype.materialize;
    const releases: Array<() => void> = [];
    const ready: Array<() => void> = [];
    const gates = [0, 1].map(() => new Promise<void>((resolve) => { ready.push(resolve); }));
    let seen = 0;
    let sharedPath = "";
    const materialize = vi.spyOn(LocalSourceSnapshotStore.prototype, "materialize").mockImplementation(async function (
      this: LocalSourceSnapshotStore,
      input: Parameters<LocalSourceSnapshotStore["materialize"]>[0],
    ) {
      const result = await real.call(this, input);
      if (input.upstreamRevisionKey.startsWith(COMMIT_A)) {
        const index = seen;
        seen += 1;
        sharedPath = result.absolutePath;
        expect(result.publication).toBe(index === 0 ? "created" : "reused");
        const gate = new Promise<void>((resolve) => { releases[index] = resolve; });
        ready[index]?.();
        await gate;
      }
      return result;
    });
    let creator: ReturnType<typeof syncProjectById> | undefined;
    let reuser: ReturnType<typeof syncProjectById> | undefined;
    try {
      creator = syncProjectById(repo, repo.reposDir, source.id);
      await gates[0];
      const candidate = join(dataDir, "upload-candidate");
      mkdirSync(candidate);
      writeFileSync(join(candidate, "upload.stl"), "upload wins");
      const uploaded = await publishLocalSourceWorkingTree({
        repo, reposDir: repo.reposDir, sourceId: source.id, workingTree: candidate,
      });
      const uploadedPath = uploaded.local_path;
      if (!uploadedPath) throw new Error("upload did not publish");
      reuser = syncProjectById(repo, repo.reposDir, source.id);
      await gates[1];
      releases[0]?.();
      await expect(creator).rejects.toThrow("Source changed during sync");
      expect(existsSync(sharedPath)).toBe(true);
      releases[1]?.();
      const synced = await reuser;
      expect(synced.stl_count).toBe(1);
      const active = repo.getSource(source.id);
      expect(active?.local_path).toBe(sharedPath);
      expect(active?.current_source_revision_id).toEqual(expect.any(Number));
      expect(existsSync(sharedPath)).toBe(true);
      expect(readFileSync(join(sharedPath, "remote.stl"), "utf8")).toBe("remote");
      expect(readFileSync(join(uploadedPath, "upload.stl"), "utf8")).toBe("upload wins");
      expect(revisionNames(repo.reposDir, source.id)).toEqual(
        [basename(sharedPath), basename(uploadedPath)].sort(),
      );
      expect(sharedSnapshotHolderCount(sharedPath)).toBe(0);
      expect(sharedSnapshotHolderCount(uploadedPath)).toBe(0);
      expect(await measureTenantDiskUsage({
        dataDir, reposDir: repo.reposDir, tenantId: "default", sourceIds: [source.id],
      })).toBe(fileBytes(join(repo.reposDir, String(source.id))));
    } finally {
      for (const release of releases) release?.();
      materialize.mockRestore();
      await ports.db.close();
    }
  });

  it("keeps a reused Git snapshot when a later sync loses activation to an upload", async () => {
    const dataDir = reposRoot();
    const ports = createSelfHostPorts(dataDir);
    await ports.db.connect();
    const repo = ports.repository!;
    const source = repo.createSource({ name: "Reused kit", url: "https://github.com/example/kit", source_kind: "github" });
    setTree(COMMIT_A, [{ path: "remote.stl", type: "blob", mode: "100644", size: 6 }]);
    vi.stubGlobal("fetch", rawResponse({ "remote.stl": "remote" }));
    await syncProjectById(repo, repo.reposDir, source.id);
    const kept = repo.getSource(source.id);
    const keptPath = kept?.local_path;
    if (!keptPath) throw new Error("Expected the first sync to activate a snapshot");
    expect(readFileSync(join(keptPath, "remote.stl"), "utf8")).toBe("remote");
    const keptNames = revisionNames(repo.reposDir, source.id);

    let publication = "";
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const real = LocalSourceSnapshotStore.prototype.materialize;
    let gated = false;
    const materialize = vi.spyOn(LocalSourceSnapshotStore.prototype, "materialize").mockImplementation(async function (
      this: LocalSourceSnapshotStore,
      input: Parameters<LocalSourceSnapshotStore["materialize"]>[0],
    ) {
      const snapshot = await real.call(this, input);
      if (gated) return snapshot;
      gated = true;
      publication = snapshot.publication;
      started();
      await gate;
      return snapshot;
    });
    try {
      const syncing = syncProjectById(repo, repo.reposDir, source.id);
      await waiting;
      expect(publication).toBe("reused");
      const candidate = join(dataDir, "upload-candidate");
      mkdirSync(candidate);
      writeFileSync(join(candidate, "upload.stl"), "upload wins");
      const uploaded = await publishLocalSourceWorkingTree({
        repo, reposDir: repo.reposDir, sourceId: source.id, workingTree: candidate,
      });
      release();
      await expect(syncing).rejects.toThrow("Source changed during sync");
      expect(repo.getSource(source.id)?.local_path).toBe(uploaded.local_path);
      expect(readFileSync(join(uploaded.local_path!, "upload.stl"), "utf8")).toBe("upload wins");
      expect(readFileSync(join(keptPath, "remote.stl"), "utf8")).toBe("remote");
      expect(revisionNames(repo.reposDir, source.id)).toEqual(
        [...keptNames, basename(uploaded.local_path!)].sort(),
      );
      expect(repo.listSourceRevisions(source.id)).toHaveLength(2);
      expect(await measureTenantDiskUsage({
        dataDir, reposDir: repo.reposDir, tenantId: "default", sourceIds: [source.id],
      })).toBe(fileBytes(join(repo.reposDir, String(source.id))));
    } finally {
      release();
      materialize.mockRestore();
      await ports.db.close();
    }
  });

  it.each(["github", "git"])("rejects unsupported %s publication before upstream or Source mutation", async (sourceKind) => {
    const dataDir = reposRoot();
    const ports = createSelfHostPorts(dataDir);
    await ports.db.connect();
    const repo = ports.repository!;
    const source = repo.createSource({ name: "Unsupported kit", url: "https://github.com/example/kit", source_kind: sourceKind });
    const before = repo.getProjectRow(source.id);
    const capability = vi.spyOn(repo, "canPublishSourceRevision").mockReturnValue(false);
    const upstream = vi.fn(() => { throw new Error("Upstream must not be contacted"); });
    github.getCommit.mockImplementation(upstream);
    try {
      await expect(syncProjectById(repo, repo.reposDir, source.id)).rejects.toThrow(
        "atomic publication transactions are not supported",
      );
      expect(repo.getProjectRow(source.id)).toEqual(before);
      expect(repo.listSourceRevisions(source.id)).toEqual([]);
      expect(readdirSync(repo.reposDir)).toEqual([]);
      expect(upstream).not.toHaveBeenCalled();
    } finally {
      capability.mockRestore();
      await ports.db.close();
    }
  });

  it.each(["local", "zip"])("keeps %s document indexing available without revision publication", async (sourceKind) => {
    const dataDir = reposRoot();
    const ports = createSelfHostPorts(dataDir);
    await ports.db.connect();
    const repo = ports.repository!;
    const files = join(dataDir, "local-files");
    mkdirSync(files);
    writeFileSync(join(files, "README.md"), "# Existing local documentation");
    const source = repo.createSource({ name: "Local docs", source_kind: sourceKind, local_path: files });
    const capability = vi.spyOn(repo, "canPublishSourceRevision").mockReturnValue(false);
    try {
      expect(await syncProjectById(repo, repo.reposDir, source.id)).toEqual({
        stl_count: 0, downloaded: 0, doc_count: 1, docs_downloaded: 0,
      });
      expect(repo.listSourceDocs(source.id).map((doc) => doc.path)).toEqual(["README.md"]);
      expect(readFileSync(join(files, "README.md"), "utf8")).toBe("# Existing local documentation");
    } finally {
      capability.mockRestore();
      await ports.db.close();
    }
  });

  it("rolls back sync activation when marking the revision current fails", async () => {
    const dataDir = reposRoot();
    const ports = createSelfHostPorts(dataDir);
    await ports.db.connect();
    const repo = ports.repository!;
    const source = repo.createSource({ name: "Rollback kit", url: "https://github.com/example/kit", source_kind: "github" });
    const candidate = join(dataDir, "upload-candidate");
    mkdirSync(candidate);
    writeFileSync(join(candidate, "previous.stl"), "previous bytes");
    const previous = await publishLocalSourceWorkingTree({
      repo, reposDir: repo.reposDir, sourceId: source.id, workingTree: candidate,
    });
    const revisions = repo.listSourceRevisions(source.id);
    setTree(COMMIT_A, [{ path: "remote.stl", type: "blob", mode: "100644", size: 6 }]);
    vi.stubGlobal("fetch", rawResponse({ "remote.stl": "remote" }));
    const markCurrent = vi.spyOn(repo, "markSourceRevisionCurrent").mockImplementation(() => {
      throw new Error("forced current-status failure");
    });
    const beforeNames = revisionNames(repo.reposDir, source.id);
    try {
      await expect(syncProjectById(repo, repo.reposDir, source.id)).rejects.toThrow("forced current-status failure");
      expect(repo.getSource(source.id)?.current_source_revision_id).toBe(previous.current_source_revision_id);
      expect(repo.getSource(source.id)?.local_path).toBe(previous.local_path);
      expect(repo.listSourceRevisions(source.id)).toEqual(revisions);
      expect(readFileSync(join(previous.local_path!, "previous.stl"), "utf8")).toBe("previous bytes");
      expect(revisionNames(repo.reposDir, source.id)).toEqual(beforeNames);
      expect(await measureTenantDiskUsage({
        dataDir, reposDir: repo.reposDir, tenantId: "default", sourceIds: [source.id],
      })).toBe(fileBytes(join(repo.reposDir, String(source.id))));
    } finally {
      markCurrent.mockRestore();
      await ports.db.close();
    }
  });

  it("keeps the branch from a deep GitHub tree URL", () => {
    const url =
      "https://github.com/MillenniumMachines/Milo-V2.0/tree/Current/STL%20Files/Spindle-Mounts/LDO-Kit-Spindle-Mount";

    expect(parseGithubUrl(url)).toEqual({
      owner: "MillenniumMachines",
      repo: "Milo-V2.0",
      branch: "Current",
      branchFromUrl: true,
    });
    expect(normalizeGithubSourceLocation(url, "main")).toEqual({
      url: "https://github.com/MillenniumMachines/Milo-V2.0",
      branch: "Current",
    });
  });

  it("rejects non-repository GitHub pages instead of silently using main", () => {
    expect(parseGithubUrl("https://github.com/example/printer/issues/12")).toBeNull();
  });

  it("resolves slash-containing branches as the longest valid tree or blob URL prefix", async () => {
    const branches = [
      { name: "feature" },
      { name: "feature/new-ui" },
      { name: "main" },
    ];
    github.getRepo.mockResolvedValue({ data: { default_branch: "main" } });
    github.paginate.mockResolvedValue(branches);

    for (const kind of ["tree", "blob"] as const) {
      const url = `https://github.com/example/printer/${kind}/feature/new-ui/models/part.stl`;
      const result = await listGithubBranches(url);
      expect(result.url_branch).toBe("feature/new-ui");
      expect(resolveGithubUrlRef(url, branches.map((branch) => branch.name))).toBe(
        "feature/new-ui",
      );
      expect(normalizeGithubSourceLocation(url, "feature/new-ui")).toEqual({
        url: "https://github.com/example/printer",
        branch: "feature/new-ui",
      });
    }
  });

  it.each([false, true])("syncs identical case-only STL aliases regardless of tree order (%s)", async (reverse) => {
    const path = "STL/Toolhead Board Mounts/A4T - THB Mount - WWBMG - NH36";
    const entries: TreeItem[] = [
      { path: `${path}.STL`, type: "blob", mode: "100644", size: 5, sha: COMMIT_B },
      { path: `${path}.stl`, type: "blob", mode: "100644", size: 5, sha: COMMIT_B },
    ];
    setTree(COMMIT_A, reverse ? entries.reverse() : entries);
    const fetchMock = rawResponse({ [`${path}.STL`]: "solid", [`${path}.stl`]: "solid" });
    vi.stubGlobal("fetch", fetchMock);
    const input = { url: "https://github.com/example/printer", branch: "main", reposDir: reposRoot(), sourceId: 7 };
    const result = await syncGithubSource(input);
    expect(result.stlPaths).toEqual([`${path}.STL`]);
    expect(result.downloaded).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const reused = await syncGithubSource(input);
    expect(reused.snapshot.publication).toBe("reused");
    expect(sharedSnapshotHolderCount(result.snapshot.absolutePath)).toBe(0);
    expect(sharedSnapshotHolderCount(reused.snapshot.absolutePath)).toBe(0);
  });

  it.each([undefined, COMMIT_A])("rejects case collisions without identical blob identity (%s)", async (sha) => {
    setTree(COMMIT_A, [
      { path: "part.STL", type: "blob", mode: "100644", size: 5, sha: COMMIT_B },
      { path: "part.stl", type: "blob", mode: "100644", size: 5, sha },
    ]);
    await expect(syncGithubSource({ url: "https://github.com/example/printer", branch: "main", reposDir: reposRoot(), sourceId: 7 }))
      .rejects.toThrow(/Duplicate Source snapshot path/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("pins every raw download to the resolved commit and publishes a complete snapshot", async () => {
    const root = reposRoot();
    setTree(COMMIT_A, [
      { path: "parts/bracket.stl", type: "blob", mode: "100644", size: 99 },
      { path: "README.md", type: "blob", mode: "100644", size: 8 },
      { path: "print-partner.manifest.yaml", type: "blob", mode: "100644", size: 42 },
    ]);
    const manifest = "format: print-partner-manifest\nversion: 2\n";
    const fetchMock = rawResponse({
      "parts/bracket.stl": "solid bracket",
      "README.md": "# Notes\n",
      "print-partner.manifest.yaml": manifest,
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await syncGithubSource({
      url: "https://github.com/example/printer",
      branch: "main",
      reposDir: root,
      sourceId: 7,
    });

    expect(result.commitSha).toBe(COMMIT_A);
    expect(result.downloaded).toBe(1);
    expect(result.docsDownloaded).toBe(1);
    expect(result.snapshot.upstreamRevisionKey).toBe(`${COMMIT_A}.snapshot-v2`);
    expect(result.snapshot.snapshotLocator).toBe(`7/revisions/${COMMIT_A}.snapshot-v2`);
    expect(readFileSync(join(result.snapshot.absolutePath, "parts/bracket.stl"), "utf8"))
      .toBe("solid bracket");
    expect(
      readFileSync(join(result.snapshot.absolutePath, "print-partner.manifest.yaml"), "utf8"),
    ).toBe(manifest);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).toContain(`/${COMMIT_A}/`);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect((init?.headers as Record<string, string> | undefined)?.["Accept-Encoding"]).toBe(
        "identity",
      );
    }
  });

  it("publishes root phase metadata without admitting arbitrary JSON files", async () => {
    const root = reposRoot();
    const phases = JSON.stringify({
      phases: [
        { name: "Foundation", folders: ["foundation"] },
        { name: "Assembly", folders: ["assembly"], depends_on: ["Foundation"] },
      ],
    });
    setTree(COMMIT_A, [
      { path: "part.stl", type: "blob", mode: "100644", size: 5 },
      { path: "pp-phases.json", type: "blob", mode: "100644", size: Buffer.byteLength(phases) },
      { path: "ignored.json", type: "blob", mode: "100644", size: 2 },
    ]);
    const fetchMock = rawResponse({
      "part.stl": "solid",
      "pp-phases.json": phases,
      "ignored.json": "{}",
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await syncGithubSource({
      url: "https://github.com/example/printer",
      branch: "main",
      reposDir: root,
      sourceId: 8,
    });

    expect(result.snapshot.upstreamRevisionKey).toBe(`${COMMIT_A}.snapshot-v3`);
    expect(readFileSync(join(result.snapshot.absolutePath, "pp-phases.json"), "utf8"))
      .toBe(phases);
    expect(existsSync(join(result.snapshot.absolutePath, "ignored.json"))).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const changedPhases = JSON.stringify({
      phases: [{ name: "Assembly", folders: ["assembly"] }],
    });
    setTree(COMMIT_B, [
      { path: "part.stl", type: "blob", mode: "100644", size: 5 },
      {
        path: "pp-phases.json",
        type: "blob",
        mode: "100644",
        size: Buffer.byteLength(changedPhases),
      },
    ]);
    vi.stubGlobal("fetch", rawResponse({
      "part.stl": "solid",
      "pp-phases.json": changedPhases,
    }));

    const changed = await syncGithubSource({
      url: "https://github.com/example/printer",
      branch: "main",
      reposDir: root,
      sourceId: 8,
    });

    expect(changed.snapshot.upstreamRevisionKey).toBe(`${COMMIT_B}.snapshot-v3`);
    expect(changed.snapshot.manifestDigest).not.toBe(result.snapshot.manifestDigest);
    expect(readFileSync(join(changed.snapshot.absolutePath, "pp-phases.json"), "utf8"))
      .toBe(changedPhases);
  });

  it("rejects a phase manifest whose GitHub tree size exceeds its byte limit", async () => {
    const root = reposRoot();
    setTree(COMMIT_A, [{
      path: "pp-phases.json",
      type: "blob",
      mode: "100644",
      size: PHASE_MANIFEST_LIMIT_BYTES + 1,
    }]);
    const fetchMock = rawResponse({ "pp-phases.json": "{}" });
    vi.stubGlobal("fetch", fetchMock);

    await expect(syncGithubSource({
      url: "https://github.com/example/printer",
      branch: "main",
      reposDir: root,
      sourceId: 17,
    })).rejects.toThrow("Source phase manifest exceeds the 1048576 byte limit");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(existsSync(join(root, "17", "revisions"))).toBe(false);
  });

  it("stops an oversized phase-manifest stream when GitHub understates its size", async () => {
    const root = reposRoot();
    setTree(COMMIT_A, [{
      path: "pp-phases.json",
      type: "blob",
      mode: "100644",
      size: 1,
    }]);
    const fetchMock = vi.fn(async () => new Response(
      Buffer.alloc(PHASE_MANIFEST_LIMIT_BYTES + 1),
      { status: 200, headers: { "content-length": "1" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    await expect(syncGithubSource({
      url: "https://github.com/example/printer",
      branch: "main",
      reposDir: root,
      sourceId: 18,
    })).rejects.toThrow("Source phase manifest exceeds the 1048576 byte limit");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(
      existsSync(join(root, "18", "revisions", `${COMMIT_A}.snapshot-v3`)),
    ).toBe(false);
  });

  it("requests identity encoding so a compressed Content-Length cannot mismatch the decoded body", async () => {
    const root = reposRoot();
    setTree(COMMIT_A, [{ path: "README.md", type: "blob", mode: "100644", size: 8 }]);
    const decoded = "# Notes\n";
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string> | undefined)?.["Accept-Encoding"]).toBe(
        "identity",
      );
      return new Response(decoded, {
        status: 200,
        headers: { "content-length": String(Buffer.byteLength(decoded)) },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await syncGithubSource({
      url: "https://github.com/example/printer",
      branch: "main",
      reposDir: root,
      sourceId: 11,
    });

    expect(result.docsDownloaded).toBe(1);
    expect(
      readFileSync(join(result.snapshot.absolutePath, "README.md"), "utf8"),
    ).toBe(decoded);
  });

  it("reserves the documentation budget for the canonical manifest", async () => {
    const root = reposRoot();
    const manifest = "format: print-partner-manifest\nversion: 2\n";
    setTree(COMMIT_A, [
      {
        path: "print-partner.manifest.yaml",
        type: "blob",
        mode: "100644",
        size: Buffer.byteLength(manifest),
      },
      { path: "README.md", type: "blob", mode: "100644", size: 8 },
    ]);
    const fetchMock = rawResponse({
      "print-partner.manifest.yaml": manifest,
      "README.md": "# Notes\n",
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await syncGithubSource({
      url: "https://github.com/example/printer",
      branch: "main",
      reposDir: root,
      sourceId: 12,
      options: { maxDocsBytes: Buffer.byteLength(manifest) },
    });

    expect(readFileSync(join(result.snapshot.absolutePath, "print-partner.manifest.yaml"), "utf8"))
      .toBe(manifest);
    expect(result.docPaths).toEqual([]);
    expect(result.snapshot.selection.omittedFiles).toEqual([
      expect.objectContaining({
        path: "README.md",
        reason: "documentation-byte-budget",
      }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects truncated trees and excessive STL sets before creating a candidate", async () => {
    const root = reposRoot();
    setTree(COMMIT_A, [
      { path: "part.stl", type: "blob", mode: "100644", size: 1 },
    ], true);

    await expect(syncGithubSource({
      url: "https://github.com/example/printer",
      branch: "main",
      reposDir: root,
      sourceId: 8,
    })).rejects.toThrow("truncated");
    expect(existsSync(join(root, "8", "revisions"))).toBe(false);

    setTree(COMMIT_A, [
      { path: "one.stl", type: "blob", mode: "100644", size: 1 },
      { path: "two.stl", type: "blob", mode: "100644", size: 1 },
    ]);
    await expect(syncGithubSource({
      url: "https://github.com/example/printer",
      branch: "main",
      reposDir: root,
      sourceId: 8,
      options: { maxStlFiles: 1 },
    })).rejects.toThrow("exceeding the limit");
    expect(existsSync(join(root, "8", "revisions"))).toBe(false);
  });

  it("leaves revision A active when revision B fails, then activates a clean B snapshot", async () => {
    const dataDir = reposRoot();
    const ports = createSelfHostPorts(dataDir);
    await ports.db.connect();
    const repo = ports.repository!;
    const source = repo.createSource({
      name: "Atomic kit",
      url: "https://github.com/example/atomic-kit",
      source_kind: "github",
    });

    setTree(COMMIT_A, [
      { path: "parts/old.stl", type: "blob", mode: "100644", size: 3 },
    ]);
    vi.stubGlobal("fetch", rawResponse({ "parts/old.stl": "old" }));
    await syncProjectById(repo, repo.reposDir, source.id);

    const activeA = repo.getProjectRow(source.id)!;
    expect(activeA.currentSourceRevisionId).toBeTypeOf("number");
    expect(activeA.lastCommitSha).toBe(COMMIT_A);
    expect(readFileSync(join(activeA.localPath!, "parts/old.stl"), "utf8")).toBe("old");

    repo.updateSource(source.id, { branch: "next" });
    expect(repo.getSource(source.id)?.metadata?.sync_required).toBe(true);
    setTree(COMMIT_B, [
      { path: "parts/new.stl", type: "blob", mode: "100644", size: 3 },
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("failure", { status: 503 })));
    await expect(syncProjectById(repo, repo.reposDir, source.id)).rejects.toThrow("HTTP 503");

    const afterFailure = repo.getProjectRow(source.id)!;
    expect(afterFailure.currentSourceRevisionId).toBe(activeA.currentSourceRevisionId);
    expect(afterFailure.localPath).toBe(activeA.localPath);
    expect(afterFailure.lastCommitSha).toBe(COMMIT_A);
    expect(repo.getSource(source.id)?.update_status).toBe("unknown");
    expect(repo.getSource(source.id)?.metadata?.sync_error).toContain("HTTP 503");
    expect(repo.listSourceRevisions(source.id)).toHaveLength(1);
    const revisionNames = readdirSync(join(repo.reposDir, String(source.id), "revisions"));
    expect(revisionNames).toEqual([COMMIT_A]);

    vi.stubGlobal("fetch", rawResponse({ "parts/new.stl": "new" }));
    await syncProjectById(repo, repo.reposDir, source.id);

    const activeB = repo.getProjectRow(source.id)!;
    expect(activeB.currentSourceRevisionId).not.toBe(activeA.currentSourceRevisionId);
    expect(activeB.lastCommitSha).toBe(COMMIT_B);
    expect(repo.getSource(source.id)?.update_status).toBe("up_to_date");
    expect(repo.getSource(source.id)?.metadata?.sync_error).toBeUndefined();
    expect(repo.getSource(source.id)?.metadata?.sync_required).toBeUndefined();
    expect(existsSync(join(activeB.localPath!, "parts/old.stl"))).toBe(false);
    expect(readFileSync(join(activeB.localPath!, "parts/new.stl"), "utf8")).toBe("new");
    expect(readFileSync(join(activeA.localPath!, "parts/old.stl"), "utf8")).toBe("old");
    expect(repo.listSourceRevisions(source.id)).toHaveLength(2);
  });

  it("does not attach an obsolete sync failure to a changed source", async () => {
    const ports = createSelfHostPorts(reposRoot());
    await ports.db.connect();
    const repo = ports.repository!;
    const source = repo.createSource({ name: "Kit", url: "https://github.com/example/kit", source_kind: "github" });
    setTree(COMMIT_A, [{ path: "part.stl", type: "blob", mode: "100644", size: 3 }]);
    vi.stubGlobal("fetch", vi.fn(async () => {
      repo.updateSource(source.id, { url: "https://github.com/example/replacement" });
      return new Response("failure", { status: 503 });
    }));
    await expect(syncProjectById(repo, repo.reposDir, source.id)).rejects.toThrow("HTTP 503");
    expect(repo.getSource(source.id)?.metadata?.sync_error).toBeUndefined();
    expect(repo.getSource(source.id)?.metadata?.sync_required).toBe(true);
    ports.db.close();
  });

  it("reuses a legacy same-commit snapshot when no canonical manifest exists", async () => {
    const root = reposRoot();
    const legacyStore = new LocalSourceSnapshotStore({ reposDir: root });
    const legacy = await legacyStore.materialize({
      sourceId: 16,
      upstreamRevisionKey: COMMIT_A,
      files: [{
        path: sourceRelativePath("part.stl"),
        kind: "stl",
        sizeHintBytes: 3,
      }],
      selection: {
        maxStlFiles: 500,
        maxDocumentationBytes: 1024 * 1024 * 1024,
        omittedFiles: [],
      },
      openFile: async () => ({
        stream: Readable.from([Buffer.from("old")]),
        contentLengthBytes: 3,
      }),
    });
    setTree(COMMIT_A, [
      { path: "part.stl", type: "blob", mode: "100644", size: 3 },
    ]);
    const fetchMock = rawResponse({ "part.stl": "old" });
    vi.stubGlobal("fetch", fetchMock);

    const result = await syncGithubSource({
      url: "https://github.com/example/legacy-no-manifest",
      branch: "main",
      reposDir: root,
      sourceId: 16,
    });
    expect(result.snapshot.publication).toBe("reused");
    expect(result.snapshot.upstreamRevisionKey).toBe(COMMIT_A);
    expect(result.snapshot.absolutePath).toBe(legacy.absolutePath);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readdirSync(join(root, "16", "revisions"))).toEqual([COMMIT_A]);
  });

  it("upgrades a legacy snapshot at the same commit without changing the remote version", async () => {
    const dataDir = reposRoot();
    const ports = createSelfHostPorts(dataDir);
    await ports.db.connect();
    try {
      const repo = ports.repository!;
      const source = repo.createSource({
        name: "Legacy snapshot",
        url: "https://github.com/example/legacy-snapshot",
        source_kind: "github",
      });
      const legacyStore = new LocalSourceSnapshotStore({ reposDir: repo.reposDir });
      const legacy = await legacyStore.materialize({
        sourceId: source.id,
        upstreamRevisionKey: COMMIT_A,
        files: [{
          path: sourceRelativePath("part.stl"),
          kind: "stl",
          sizeHintBytes: 3,
        }],
        selection: {
          maxStlFiles: 500,
          maxDocumentationBytes: 1024,
          omittedFiles: [],
        },
        openFile: async () => ({
          stream: Readable.from([Buffer.from("old")]),
          contentLengthBytes: 3,
        }),
      });
      const legacyRevision = repo.recordSourceRevision({
        sourceId: source.id,
        upstreamRevisionKey: COMMIT_A,
        manifestDigest: legacy.manifestDigest,
        snapshotLocator: legacy.snapshotLocator,
        syncedAt: "2026-09-01T00:00:00.000Z",
        completeness: "complete",
      });
      const observed = repo.getSourceActivationObservation(source.id);
      if (!observed) throw new Error("Expected Source activation observation");
      repo.activateSourceRevision({
        sourceId: source.id,
        revisionId: legacyRevision.id,
        observed,
        sourceVersion: COMMIT_A,
      });

      const manifest = "format: print-partner-manifest\nversion: 2\n";
      setTree(COMMIT_A, [
        { path: "part.stl", type: "blob", mode: "100644", size: 3 },
        {
          path: "print-partner.manifest.yaml",
          type: "blob",
          mode: "100644",
          size: Buffer.byteLength(manifest),
        },
      ]);
      vi.stubGlobal("fetch", rawResponse({
        "part.stl": "old",
        "print-partner.manifest.yaml": manifest,
      }));

      await syncProjectById(repo, repo.reposDir, source.id);

      const active = repo.getProjectRow(source.id)!;
      expect(active.lastCommitSha).toBe(COMMIT_A);
      expect(active.localPath).toContain(`${COMMIT_A}.snapshot-v2`);
      expect(readFileSync(join(active.localPath!, "print-partner.manifest.yaml"), "utf8"))
        .toBe(manifest);
      expect(repo.listSourceRevisions(source.id).map((revision) => revision.upstream_revision_key))
        .toEqual([COMMIT_A, `${COMMIT_A}.snapshot-v2`]);
      expect(existsSync(legacy.absolutePath)).toBe(true);

      await syncProjectById(repo, repo.reposDir, source.id);
      expect(repo.listSourceRevisions(source.id)).toHaveLength(2);
    } finally {
      ports.db.close();
    }
  });

  it("rejects selected symlinks and raw download failures without publishing", async () => {
    const root = reposRoot();
    setTree(COMMIT_A, [
      { path: "linked.stl", type: "blob", mode: "120000", size: 10 },
    ]);
    await expect(syncGithubSource({
      url: "https://github.com/example/printer",
      branch: "main",
      reposDir: root,
      sourceId: 9,
    })).rejects.toThrow("unsupported selected entry");

    setTree(COMMIT_A, [
      { path: "part.stl", type: "blob", mode: "100644", size: 10 },
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("missing", { status: 404 })));
    await expect(syncGithubSource({
      url: "https://github.com/example/printer",
      branch: "main",
      reposDir: root,
      sourceId: 9,
    })).rejects.toThrow("HTTP 404");
    expect(existsSync(join(root, "9", "revisions", COMMIT_A))).toBe(false);
  });

  it("records unknown-size documents as omitted without blocking STL publication", async () => {
    const root = reposRoot();
    setTree(COMMIT_A, [
      { path: "part.stl", type: "blob", mode: "100644", size: 3 },
      { path: "manual.pdf", type: "blob", mode: "100644" },
    ]);
    const fetchMock = rawResponse({ "part.stl": "stl" });
    vi.stubGlobal("fetch", fetchMock);

    const result = await syncGithubSource({
      url: "https://github.com/example/printer",
      branch: "main",
      reposDir: root,
      sourceId: 10,
    });

    expect(result.stlPaths).toEqual(["part.stl"]);
    expect(result.docPaths).toEqual([]);
    expect(result.snapshot.selection.omittedFiles).toEqual([
      expect.objectContaining({
        path: "manual.pdf",
        reason: "unknown-document-size",
      }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

it("a queued hosted sync cannot activate a snapshot larger than its remaining quota", async () => {
  const dataDir = reposRoot();
  const ports = createSelfHostPorts(dataDir);
  await ports.db.connect();
  try {
    const repo = ports.repository!;
    const source = repo.createSource({ name: "Quota sync", url: "https://github.com/example/quota", source_kind: "github" });
    setTree(COMMIT_A, [{ path: "part.stl", type: "blob", mode: "100644", size: 20 }]);
    vi.stubGlobal("fetch", rawResponse({ "part.stl": "solid quota contents" }));
    const jobs = createJobRunner(() => repo, dataDir, { tenantDiskQuotaBytes: 10 });
    const id = await jobs.start("import-scan", { project_id: source.id }, "default");
    await vi.waitFor(async () => {
      const job = await jobs.get(id, "default");
      expect(job?.status).toBe("error");
      expect(job?.error).toContain("2 GiB");
    });
    expect(repo.getSource(source.id)?.current_source_revision_id).toBeNull();
    expect(repo.listSourceRevisions(source.id)).toEqual([]);
    expect(readdirSync(join(repo.reposDir, String(source.id), "revisions"))).toEqual([]);
  } finally {
    await ports.db.close();
  }
});

it.each([
  { count: 1, change: "replacement" },
  { count: 2, change: "replacement" },
  { count: 1, change: "removal" },
])("refuses publication for $count sources after manifest $change during download", async ({ count, change }) => {
  const dataDir = reposRoot();
  const ports = createSelfHostPorts(dataDir);
  await ports.db.connect();
  const priorManifest = process.env.PP_SOURCE_SYNC_OWNERSHIP_MANIFEST;
  try {
    const repo = ports.repository;
    const first = repo.createSource({ name: "First", url: "https://github.com/example/first", source_kind: "github" });
    const second = repo.createSource({ name: "Second", url: "https://github.com/example/second", source_kind: "github" });
    const beforeSecond = repo.getProjectRow(second.id);
    const beforeFirst = repo.getProjectRow(first.id);
    const manifest = join(dataDir, "manifest.json");
    const original = readFileSync(packagedSourceSyncManifestPath(), "utf8");
    writeFileSync(manifest, original);
    process.env.PP_SOURCE_SYNC_OWNERSHIP_MANIFEST = manifest;
    beginSourceSyncAdmission(dataDir);
    setTree(COMMIT_A, [{ path: "part.stl", type: "blob", mode: "100644", size: 3 }]);
    const download = rawResponse({ "part.stl": "stl" });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const response = await download(input);
      if (change === "removal") rmSync(manifest);
      else writeFileSync(manifest, `${original}\n`);
      return response;
    }));
    const jobs = createJobRunner(() => repo, dataDir);
    const jobId = await jobs.start("sync", { project_ids: [first.id, second.id].slice(0, count) });
    await vi.waitFor(async () => {
      expect(await jobs.get(jobId, "default")).toMatchObject({
        status: "error",
        error: expect.stringMatching(/runtime manifest does not match|cannot read Source Sync manifest/),
      });
    });
    expect(repo.listSourceRevisions(first.id)).toEqual([]);
    expect(repo.getProjectRow(first.id)).toEqual(beforeFirst);
    expect(readdirSync(join(repo.reposDir, String(first.id), "revisions"))).toEqual([]);
    expect(repo.getProjectRow(second.id)).toEqual(beforeSecond);
    expect(repo.listSourceRevisions(second.id)).toEqual([]);
    expect(existsSync(join(repo.reposDir, String(second.id)))).toBe(false);
    expect(download).toHaveBeenCalledOnce();
  } finally {
    if (priorManifest === undefined) delete process.env.PP_SOURCE_SYNC_OWNERSHIP_MANIFEST;
    else process.env.PP_SOURCE_SYNC_OWNERSHIP_MANIFEST = priorManifest;
    await ports.db.close();
  }
});

it.each([32, pdfText.PDF_BG_EXTRACT_BYTES])("surfaces PDF quota errors instead of completing sync with a warning (PDF bytes: %i)", async (size) => {
  const dataDir = reposRoot();
  const ports = createSelfHostPorts(dataDir);
  await ports.db.connect();
  const quotaError = new TenantDiskQuotaError();
  const extraction = vi.spyOn(pdfText, "extractPdfText").mockRejectedValueOnce(quotaError);
  try {
    const repo = ports.repository!;
    const source = repo.createSource({ name: "PDF quota", url: "https://github.com/example/pdf-quota", source_kind: "github" });
    const content = "x".repeat(size);
    setTree(COMMIT_A, [{ path: "manual.pdf", type: "blob", mode: "100644", size }]);
    vi.stubGlobal("fetch", rawResponse({ "manual.pdf": content }));
    await expect(syncProjectById(repo, repo.reposDir, source.id)).rejects.toBe(quotaError);
    expect(extraction).toHaveBeenCalledOnce();
    // The completed source download remains usable; the failed derived cache is not reported as complete.
    expect(repo.getSource(source.id)?.current_source_revision_id).not.toBeNull();
    expect(repo.listSourceDocs(source.id)[0]?.extract_status).toBe("pending");
  } finally {
    extraction.mockRestore();
    await ports.db.close();
  }
});
