import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { syncProjectById } from "../routes/sources.js";
import {
  listGithubBranches,
  normalizeGithubSourceLocation,
  parseGithubUrl,
  resolveGithubUrlRef,
  syncGithubSource,
} from "./github-sync.js";
import { LocalSourceSnapshotStore, sourceRelativePath } from "./local-source-snapshot.js";

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const roots: string[] = [];

type TreeItem = {
  path: string;
  type: "blob" | "tree" | "commit";
  mode: string;
  size?: number;
};

function reposRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pp-github-sync-"));
  roots.push(root);
  return root;
}

function setTree(commitSha: string, items: TreeItem[], truncated = false): void {
  github.getCommit.mockResolvedValue({ data: { sha: commitSha } });
  github.getTree.mockResolvedValue({ data: { truncated, tree: items } });
}

function rawResponse(contentByPath: Record<string, string>): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: string | URL | Request) => {
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

    setTree(COMMIT_B, [
      { path: "parts/new.stl", type: "blob", mode: "100644", size: 3 },
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("failure", { status: 503 })));
    await expect(syncProjectById(repo, repo.reposDir, source.id)).rejects.toThrow("HTTP 503");

    const afterFailure = repo.getProjectRow(source.id)!;
    expect(afterFailure.currentSourceRevisionId).toBe(activeA.currentSourceRevisionId);
    expect(afterFailure.localPath).toBe(activeA.localPath);
    expect(afterFailure.lastCommitSha).toBe(COMMIT_A);
    expect(repo.listSourceRevisions(source.id)).toHaveLength(1);
    const revisionNames = readdirSync(join(repo.reposDir, String(source.id), "revisions"));
    expect(revisionNames).toEqual([COMMIT_A]);

    vi.stubGlobal("fetch", rawResponse({ "parts/new.stl": "new" }));
    await syncProjectById(repo, repo.reposDir, source.id);

    const activeB = repo.getProjectRow(source.id)!;
    expect(activeB.currentSourceRevisionId).not.toBe(activeA.currentSourceRevisionId);
    expect(activeB.lastCommitSha).toBe(COMMIT_B);
    expect(existsSync(join(activeB.localPath!, "parts/old.stl"))).toBe(false);
    expect(readFileSync(join(activeB.localPath!, "parts/new.stl"), "utf8")).toBe("new");
    expect(readFileSync(join(activeA.localPath!, "parts/old.stl"), "utf8")).toBe("old");
    expect(repo.listSourceRevisions(source.id)).toHaveLength(2);
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
