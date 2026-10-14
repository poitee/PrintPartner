import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import * as fsPromises from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDb, SqliteDatabase } from "../db/client.js";
import { AppRepository, SourceActivationConflictError } from "../db/repository.js";
import {
  measureTenantDiskUsage,
  runWithTenantDiskQuota,
  TenantDiskQuotaError,
} from "../lib/tenant-disk-quota.js";
import { LocalSourceSnapshotStore, SOURCE_SNAPSHOT_MANIFEST_FILE } from "./local-source-snapshot.js";
import {
  SOURCE_PUBLICATION_UNAVAILABLE_DETAIL,
  indexDocsForActivatedRevision,
  publishLocalSourceWorkingTree,
  publishSourceManifestRevision,
  removeObsoleteHostedWorkingTree,
} from "./local-source-revision.js";

import { beginSourceSyncAdmission, packagedSourceSyncManifestPath, requireSourceSyncParticipant } from "../ownership/source-sync-admission.js";
vi.mock("node:fs/promises", { spy: true });

const roots: string[] = [];
const PHASE_MANIFEST_LIMIT_BYTES = 1024 * 1024;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pp-local-revision-"));
  roots.push(dir);
  const sqlite = new SqliteDatabase(dir);
  sqlite.connect();
  const repo = new AppRepository(getDb(sqlite), undefined, sqlite.reposDir);
  const source = repo.createSource({ name: "Local files", source_kind: "local" });
  const workingTree = join(dir, "incoming");
  mkdirSync(workingTree, { recursive: true });
  writeFileSync(join(workingTree, "cube.stl"), "solid cube\nendsolid cube\n");
  return { dir, sqlite, repo, source, workingTree };
}

describe("publishLocalSourceWorkingTree", () => {
  it("refuses local publication when admission changes during staging", async () => {
    const f = fixture();
    writeFileSync(join(f.workingTree, "z.stl"), "solid second\nendsolid second\n");
    const manifest = join(f.dir, "ownership.json");
    const original = readFileSync(packagedSourceSyncManifestPath(), "utf8");
    const previous = process.env.PP_SOURCE_SYNC_OWNERSHIP_MANIFEST;
    const before = f.repo.getProjectRow(f.source.id);
    const actualFs = await vi.importActual<typeof fsPromises>("node:fs/promises");
    try {
      writeFileSync(manifest, original);
      process.env.PP_SOURCE_SYNC_OWNERSHIP_MANIFEST = manifest;
      beginSourceSyncAdmission(f.dir);
      const copy = vi.mocked(fsPromises.copyFile).mockImplementationOnce(async (...args) => {
        await actualFs.copyFile(...args);
        writeFileSync(manifest, `${original}\n`);
      });
      await expect(publishLocalSourceWorkingTree({
        repo: f.repo, reposDir: f.sqlite.reposDir, sourceId: f.source.id, workingTree: f.workingTree,
        beforePublish: () => requireSourceSyncParticipant("assistant.propose_import_source_files"),
      })).rejects.toThrow(/runtime manifest does not match/);
      expect(copy).toHaveBeenCalledTimes(1);
      expect(f.repo.getProjectRow(f.source.id)).toEqual(before);
      expect(f.repo.listSourceRevisions(f.source.id)).toEqual([]);
      const workspace = join(f.sqlite.reposDir, String(f.source.id));
      expect(readdirSync(workspace).filter((name) => name.startsWith(".local-source-") || name === "revisions")).toEqual([]);
    } finally {
      vi.restoreAllMocks();
      if (previous === undefined) delete process.env.PP_SOURCE_SYNC_OWNERSHIP_MANIFEST;
      else process.env.PP_SOURCE_SYNC_OWNERSHIP_MANIFEST = previous;
      f.sqlite.close();
    }
  });

  it("seeds suggested rules when legacy imported paths contain only whitespace", async () => {
    const { sqlite, repo, source, workingTree } = fixture();
    try {
      getDb(sqlite).run(sql`UPDATE projects SET imported_paths = ${"  \n\t"} WHERE id = ${source.id}`);
      await publishLocalSourceWorkingTree({
        repo, reposDir: sqlite.reposDir, sourceId: source.id, workingTree,
        suggestedImportRules: ["cube.stl"],
      });
      expect(JSON.parse(repo.getProjectRow(source.id)!.importedPaths!)).toEqual(["cube.stl"]);
    } finally { sqlite.close(); }
  });

  it("reuploads a managed snapshot while preserving ordinary hidden files", async () => {
    const { sqlite, repo, source, workingTree } = fixture();
    try {
      writeFileSync(join(workingTree, ".notes"), "keep hidden user content");
      const first = await publishLocalSourceWorkingTree({
        repo, reposDir: sqlite.reposDir, sourceId: source.id, workingTree, preserveAllFiles: true,
      });
      const second = await publishLocalSourceWorkingTree({
        repo, reposDir: sqlite.reposDir, sourceId: source.id,
        workingTree: first.local_path!, preserveAllFiles: true,
      });
      expect(second.current_source_revision_id).toBe(first.current_source_revision_id);
      expect(readFileSync(join(second.local_path!, ".notes"), "utf8")).toBe("keep hidden user content");
      expect(readFileSync(join(second.local_path!, "cube.stl"), "utf8")).toBe("solid cube\nendsolid cube\n");
    } finally { sqlite.close(); }
  });

  it("omits a case-variant snapshot manifest at the upload root and keeps a nested one", async () => {
    const { sqlite, repo, source, workingTree } = fixture();
    try {
      const variant = ".PRINTPARTNER-SOURCE-SNAPSHOT.JSON";
      writeFileSync(join(workingTree, variant), "{\"decoy\":true}\n");
      mkdirSync(join(workingTree, "notes"));
      writeFileSync(join(workingTree, "notes", variant), "nested decoy");
      const activated = await publishLocalSourceWorkingTree({
        repo, reposDir: sqlite.reposDir, sourceId: source.id, workingTree, preserveAllFiles: true,
      });
      const root = activated.local_path!;
      expect(readdirSync(root).sort()).toEqual([SOURCE_SNAPSHOT_MANIFEST_FILE, "cube.stl", "notes"].sort());
      expect(readFileSync(join(root, "notes", variant), "utf8")).toBe("nested decoy");
      const manifest = JSON.parse(readFileSync(join(root, SOURCE_SNAPSHOT_MANIFEST_FILE), "utf8")) as {
        files: Array<{ path: string }>;
      };
      expect(manifest.files.map((file) => file.path)).toEqual(["cube.stl", "notes/.PRINTPARTNER-SOURCE-SNAPSHOT.JSON"]);
      expect(readFileSync(join(root, "cube.stl"), "utf8")).toBe("solid cube\nendsolid cube\n");
    } finally { sqlite.close(); }
  });

  it("streams a large file while deriving its revision digest", async () => {
    const { sqlite, repo, source, workingTree } = fixture();
    const contentBytes = 32 * 1024 * 1024;
    const stlPath = join(workingTree, "cube.stl");
    truncateSync(stlPath, 0);
    truncateSync(stlPath, contentBytes);
    vi.mocked(fsPromises.readFile).mockClear();

    const activated = await publishLocalSourceWorkingTree({
      repo,
      reposDir: sqlite.reposDir,
      sourceId: source.id,
      workingTree,
    });

    const revisionId = activated.current_source_revision_id;
    expect(revisionId).toEqual(expect.any(Number));
    if (revisionId == null) throw new Error("Expected an active Source revision");
    expect(fsPromises.readFile).not.toHaveBeenCalled();
    const contentHash = createHash("sha256");
    const zeroChunk = Buffer.alloc(64 * 1024);
    for (let hashed = 0; hashed < contentBytes; hashed += zeroChunk.byteLength) {
      contentHash.update(zeroChunk);
    }
    const contentDigest = contentHash.digest("hex");
    const expectedRevisionKey = createHash("sha256")
      .update(
        JSON.stringify({
          path: "cube.stl",
          size: contentBytes,
          sha256: contentDigest,
        }),
      )
      .update("\n")
      .digest("hex");
    const revision = repo.getSourceRevision(revisionId);
    expect(revision?.upstream_revision_key).toBe(expectedRevisionKey);
    sqlite.close();
  });

  it("rejects excess STL files before staging or copying", async () => {
    const { dir, sqlite, repo, source, workingTree } = fixture();
    const blockedReposDir = join(dir, "blocked-repos");
    writeFileSync(blockedReposDir, "staging must not begin");

    await expect(
      publishLocalSourceWorkingTree({
        repo,
        reposDir: blockedReposDir,
        sourceId: source.id,
        workingTree,
        maxStlFiles: 0,
      }),
    ).rejects.toThrow("Local Source contains 1 STL files, exceeding the limit of 0");
    expect(readFileSync(blockedReposDir, "utf8")).toBe("staging must not begin");
    sqlite.close();
  });

  it("blocks quota exhaustion before source revision activation", async () => {
    const { dir, sqlite, repo, source, workingTree } = fixture();
    const quotaBytes = Buffer.byteLength("solid cube\nendsolid cube\n") - 1;

    await expect(
      runWithTenantDiskQuota(
        {
          dataDir: dir,
          reposDir: sqlite.reposDir,
          tenantId: "tenant-a",
          quotaBytes,
          sourceIds: () => [source.id],
        },
        () =>
          publishLocalSourceWorkingTree({
            repo,
            reposDir: sqlite.reposDir,
            sourceId: source.id,
            workingTree,
          }),
      ),
    ).rejects.toBeInstanceOf(TenantDiskQuotaError);

    expect(repo.listSourceRevisions(source.id)).toEqual([]);
    expect(repo.getSource(source.id)?.current_source_revision_id).toBeNull();
    expect(existsSync(join(sqlite.reposDir, String(source.id), "revisions"))).toBe(false);
    sqlite.close();
  });

  it("rejects excess documentation bytes before staging or copying", async () => {
    const { dir, sqlite, repo, source, workingTree } = fixture();
    writeFileSync(join(workingTree, "README.md"), "too large");
    const blockedReposDir = join(dir, "blocked-repos");
    writeFileSync(blockedReposDir, "staging must not begin");

    await expect(
      publishLocalSourceWorkingTree({
        repo,
        reposDir: blockedReposDir,
        sourceId: source.id,
        workingTree,
        maxDocumentationBytes: 0,
      }),
    ).rejects.toThrow("Local Source documentation exceeds the 0 byte limit, including non-STL artifacts");
    expect(readFileSync(blockedReposDir, "utf8")).toBe("staging must not begin");
    sqlite.close();
  });

  it("rejects a phase manifest above its dedicated byte limit before staging", async () => {
    const { dir, sqlite, repo, source, workingTree } = fixture();
    writeFileSync(
      join(workingTree, "pp-phases.json"),
      Buffer.alloc(PHASE_MANIFEST_LIMIT_BYTES + 1),
    );
    const blockedReposDir = join(dir, "blocked-repos");
    writeFileSync(blockedReposDir, "staging must not begin");

    await expect(
      publishLocalSourceWorkingTree({
        repo,
        reposDir: blockedReposDir,
        sourceId: source.id,
        workingTree,
      }),
    ).rejects.toThrow("Source phase manifest exceeds the 1048576 byte limit");
    expect(readFileSync(blockedReposDir, "utf8")).toBe("staging must not begin");
    sqlite.close();
  });

  it("counts uploaded 3MF and ZIP artifacts against the byte limit", async () => {
    const { dir, sqlite, repo, source, workingTree } = fixture();
    writeFileSync(join(workingTree, "project.3mf"), Buffer.alloc(16));
    writeFileSync(join(workingTree, "original.zip"), Buffer.alloc(16));
    const blockedReposDir = join(dir, "blocked-repos");
    writeFileSync(blockedReposDir, "staging must not begin");

    await expect(publishLocalSourceWorkingTree({
      repo,
      reposDir: blockedReposDir,
      sourceId: source.id,
      workingTree,
      maxDocumentationBytes: 31,
    })).rejects.toThrow(/exceeds the 31 byte limit, including non-STL artifacts/);
    expect(readFileSync(blockedReposDir, "utf8")).toBe("staging must not begin");
    sqlite.close();
  });

  it("rejects STL bytes above the total Source snapshot limit", async () => {
    const { dir, sqlite, repo, source, workingTree } = fixture();
    truncateSync(join(workingTree, "cube.stl"), 64);
    const blockedReposDir = join(dir, "blocked-repos");
    writeFileSync(blockedReposDir, "staging must not begin");
    await expect(publishLocalSourceWorkingTree({
      repo,
      reposDir: blockedReposDir,
      sourceId: source.id,
      workingTree,
      maxTotalBytes: 63,
    })).rejects.toThrow(/total stored bytes exceeds the 63 byte limit/);
    expect(readFileSync(blockedReposDir, "utf8")).toBe("staging must not begin");
    sqlite.close();
  });

  it("records and activates a tracked snapshot from a local working tree", async () => {
    const { sqlite, repo, source, workingTree, dir } = fixture();
    const manifest = "format: print-partner-manifest\nversion: 2\n";
    writeFileSync(join(workingTree, "print-partner.manifest.yaml"), manifest);
    const activated = await publishLocalSourceWorkingTree({
      repo,
      reposDir: sqlite.reposDir,
      sourceId: source.id,
      workingTree,
    });
    expect(activated.current_source_revision_id).toEqual(expect.any(Number));
    const revision = repo.getSourceRevision(activated.current_source_revision_id!);
    expect(revision?.completeness).toBe("complete");
    expect(revision?.snapshot_locator).toBe(
      `${source.id}/revisions/${revision?.upstream_revision_key}`,
    );
    const snapshotStl = join(dir, "repos", revision!.snapshot_locator, "cube.stl");
    const snapshotManifest = join(
      dir,
      "repos",
      revision!.snapshot_locator,
      "print-partner.manifest.yaml",
    );
    expect(existsSync(snapshotStl)).toBe(true);
    expect(readFileSync(snapshotStl, "utf8")).toBe("solid cube\nendsolid cube\n");
    expect(readFileSync(snapshotManifest, "utf8")).toBe(manifest);
    expect(existsSync(join(dir, "repos", revision!.snapshot_locator, SOURCE_SNAPSHOT_MANIFEST_FILE))).toBe(
      true,
    );
    expect(activated.local_path).toBe(join(dir, "repos", revision!.snapshot_locator));

    const again = await publishLocalSourceWorkingTree({
      repo,
      reposDir: sqlite.reposDir,
      sourceId: source.id,
      workingTree,
    });
    expect(again.current_source_revision_id).toBe(activated.current_source_revision_id);

    sqlite.close();
  });

  it("preserves phase metadata and changes revision identity when it changes", async () => {
    const { sqlite, repo, source, workingTree } = fixture();
    const firstPhases = JSON.stringify({
      phases: [{ name: "Foundation", folders: ["foundation"] }],
    });
    writeFileSync(join(workingTree, "pp-phases.json"), firstPhases);

    const first = await publishLocalSourceWorkingTree({
      repo,
      reposDir: sqlite.reposDir,
      sourceId: source.id,
      workingTree,
    });
    expect(readFileSync(join(first.local_path!, "pp-phases.json"), "utf8")).toBe(firstPhases);

    const secondPhases = JSON.stringify({
      phases: [
        { name: "Foundation", folders: ["foundation"] },
        { name: "Assembly", folders: ["assembly"], depends_on: ["Foundation"] },
      ],
    });
    writeFileSync(join(workingTree, "pp-phases.json"), secondPhases);

    const second = await publishLocalSourceWorkingTree({
      repo,
      reposDir: sqlite.reposDir,
      sourceId: source.id,
      workingTree,
    });
    expect(second.current_source_revision_id).not.toBe(first.current_source_revision_id);
    expect(readFileSync(join(second.local_path!, "pp-phases.json"), "utf8")).toBe(secondPhases);
    expect(readFileSync(join(first.local_path!, "pp-phases.json"), "utf8")).toBe(firstPhases);
    sqlite.close();
  });

  it("publishes a new revision when the working tree changes", async () => {
    const { sqlite, repo, source, workingTree } = fixture();
    const first = await publishLocalSourceWorkingTree({
      repo,
      reposDir: sqlite.reposDir,
      sourceId: source.id,
      workingTree,
    });
    writeFileSync(join(workingTree, "cube.stl"), "solid cube v2\nendsolid cube\n");
    const second = await publishLocalSourceWorkingTree({
      repo,
      reposDir: sqlite.reposDir,
      sourceId: source.id,
      workingTree,
    });
    expect(second.current_source_revision_id).not.toBe(first.current_source_revision_id);
    sqlite.close();
  });

  it("distinguishes file boundaries from NUL bytes inside binary STL content", async () => {
    const { sqlite, repo, source, workingTree } = fixture();
    rmSync(join(workingTree, "cube.stl"));
    writeFileSync(join(workingTree, "x.stl"), Buffer.from("a\0y.stl\0b"));
    const first = await publishLocalSourceWorkingTree({
      repo,
      reposDir: sqlite.reposDir,
      sourceId: source.id,
      workingTree,
    });

    writeFileSync(join(workingTree, "x.stl"), "a");
    writeFileSync(join(workingTree, "y.stl"), "b");
    const second = await publishLocalSourceWorkingTree({
      repo,
      reposDir: sqlite.reposDir,
      sourceId: source.id,
      workingTree,
    });

    expect(second.current_source_revision_id).not.toBe(first.current_source_revision_id);
    sqlite.close();
  });

  it("publishes the staged observation when the live tree changes during materialization", async () => {
    const { sqlite, repo, source, workingTree, dir } = fixture();
    writeFileSync(join(workingTree, "a.stl"), Buffer.alloc(32 * 1024 * 1024, 1));
    writeFileSync(join(workingTree, "z.stl"), "AAAA");
    const publication = publishLocalSourceWorkingTree({
      repo,
      reposDir: sqlite.reposDir,
      sourceId: source.id,
      workingTree,
    });
    const revisionsRoot = join(sqlite.reposDir, String(source.id), "revisions");
    let materializing = false;
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      if (
        existsSync(revisionsRoot) &&
        readdirSync(revisionsRoot).some((name) => name.startsWith(".candidate-"))
      ) {
        materializing = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(materializing).toBe(true);
    writeFileSync(join(workingTree, "z.stl"), "BBBB");

    const activated = await publication;
    const revision = repo.getSourceRevision(activated.current_source_revision_id!);
    expect(readFileSync(join(dir, "repos", revision!.snapshot_locator, "z.stl"), "utf8")).toBe(
      "AAAA",
    );
    expect(readFileSync(join(workingTree, "z.stl"), "utf8")).toBe("BBBB");
    sqlite.close();
  });

  it("does not ingest managed revision directories when retrying a workspace publication", async () => {
    const { sqlite, repo, source } = fixture();
    const workspace = source.local_path;
    if (!workspace) throw new Error("Expected a local Source workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "cube.stl"), "solid workspace\nendsolid workspace\n");
    const manifestYaml = "project: workspace\nparts: []\n";
    writeFileSync(join(workspace, "print-partner.manifest.yaml"), manifestYaml);
    const activate = repo.activateSourceRevision.bind(repo);
    const spy = vi.spyOn(repo, "activateSourceRevision").mockImplementationOnce((input) => {
      repo.updateSource(source.id, { branch: "release" });
      return activate(input);
    });

    await expect(publishSourceManifestRevision({
      repo,
      sourceId: source.id,
      manifestYaml,
    })).rejects.toThrow("Source changed during sync");
    expect(existsSync(join(workspace, "revisions"))).toBe(true);
    spy.mockRestore();

    const activated = await publishSourceManifestRevision({
      repo,
      sourceId: source.id,
      manifestYaml,
    });

    expect(readdirSync(activated.local_path!, { recursive: true }).sort()).toEqual([
      SOURCE_SNAPSHOT_MANIFEST_FILE,
      "cube.stl",
      "print-partner.manifest.yaml",
    ]);
    expect(repo.listSourceRevisions(source.id)).toHaveLength(1);
    sqlite.close();
  });
});


describe("candidate publication", () => {
  it("publishes one complete candidate when two writers observed the same source", async () => {
    const { dir, sqlite, repo, source, workingTree } = fixture();
    const other = join(dir, "other");
    mkdirSync(other);
    writeFileSync(join(other, "other.stl"), "other candidate");
    const observed = repo.getSourceActivationObservation(source.id)!;
    const results = await Promise.allSettled([workingTree, other].map((tree) => publishLocalSourceWorkingTree({
      repo, reposDir: sqlite.reposDir, sourceId: source.id, workingTree: tree, observed,
    })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((result) => result.status === "rejected");
    expect(loser?.status === "rejected" && loser.reason).toBeInstanceOf(SourceActivationConflictError);
    const active = repo.getSource(source.id)!;
    const winner = results[0]!.status === "fulfilled" ? "cube.stl" : "other.stl";
    expect(readdirSync(active.local_path!).sort()).toEqual([SOURCE_SNAPSHOT_MANIFEST_FILE, winner].sort());
    expect(readFileSync(join(active.local_path!, winner), "utf8")).toBe(winner === "cube.stl" ? "solid cube\nendsolid cube\n" : "other candidate");
    expect(readFileSync(join(workingTree, "cube.stl"), "utf8")).toBe("solid cube\nendsolid cube\n");
    const revisionsRoot = join(sqlite.reposDir, String(source.id), "revisions");
    const directories = readdirSync(revisionsRoot).filter((name) => !name.startsWith("."));
    expect(directories).toEqual([basename(active.local_path!)]);
    expect(repo.listSourceRevisions(source.id).map((revision) => revision.upstream_revision_key)).toEqual(directories);
    sqlite.close();
  });

  it("reuses one complete snapshot for concurrent identical candidates", async () => {
    const { dir, sqlite, repo, source, workingTree } = fixture();
    const other = join(dir, "identical");
    mkdirSync(other);
    writeFileSync(join(other, "cube.stl"), "solid cube\nendsolid cube\n");
    const observed = repo.getSourceActivationObservation(source.id)!;
    const results = await Promise.all([workingTree, other].map((tree) => publishLocalSourceWorkingTree({
      repo, reposDir: sqlite.reposDir, sourceId: source.id, workingTree: tree, observed,
    })));
    expect(results[0]!.local_path).toBe(results[1]!.local_path);
    expect(readFileSync(join(results[0]!.local_path!, "cube.stl"), "utf8")).toBe("solid cube\nendsolid cube\n");
    expect(repo.listSourceRevisions(source.id)).toHaveLength(1);
    expect(existsSync(results[0]!.local_path!)).toBe(true);
    sqlite.close();
  });

  it("drops the losing snapshot and keeps the accepted history", async () => {
    const { sqlite, repo, source, workingTree } = fixture();
    const accepted = await publishLocalSourceWorkingTree({
      repo, reposDir: sqlite.reposDir, sourceId: source.id, workingTree,
    });
    const observed = repo.getSourceActivationObservation(source.id)!;
    const winnerTree = join(sqlite.reposDir, "winner-input");
    mkdirSync(winnerTree);
    writeFileSync(join(winnerTree, "winner.stl"), "solid winner\nendsolid winner\n");
    const winner = await publishLocalSourceWorkingTree({
      repo, reposDir: sqlite.reposDir, sourceId: source.id, workingTree: winnerTree,
    });
    writeFileSync(join(workingTree, "cube.stl"), "solid loser\nendsolid loser\n");
    await expect(publishLocalSourceWorkingTree({
      repo, reposDir: sqlite.reposDir, sourceId: source.id, workingTree, observed,
    })).rejects.toBeInstanceOf(SourceActivationConflictError);
    const revisionsRoot = join(sqlite.reposDir, String(source.id), "revisions");
    const directories = readdirSync(revisionsRoot).filter((name) => !name.startsWith(".")).sort();
    const referenced = repo.listSourceRevisions(source.id).map((revision) => revision.upstream_revision_key).sort();
    expect(directories).toEqual(referenced);
    expect(directories).toEqual([basename(accepted.local_path!), basename(winner.local_path!)].sort());
    expect(readFileSync(join(accepted.local_path!, "cube.stl"), "utf8")).toBe("solid cube\nendsolid cube\n");
    expect(readFileSync(join(winner.local_path!, "winner.stl"), "utf8")).toBe("solid winner\nendsolid winner\n");
    expect(repo.getSource(source.id)?.local_path).toBe(winner.local_path);
    sqlite.close();
  });

  it("rejects an upload observed before a manifest publication", async () => {
    const { sqlite, repo, source, workingTree } = fixture();
    await publishLocalSourceWorkingTree({ repo, reposDir: sqlite.reposDir, sourceId: source.id, workingTree });
    const observed = repo.getSourceActivationObservation(source.id)!;
    const manifest = "project: preserved\nparts: []\n";
    const winner = await publishSourceManifestRevision({ repo, sourceId: source.id, manifestYaml: manifest });
    writeFileSync(join(workingTree, "cube.stl"), "losing upload");
    await expect(publishLocalSourceWorkingTree({ repo, reposDir: sqlite.reposDir, sourceId: source.id, workingTree, observed })).rejects.toBeInstanceOf(SourceActivationConflictError);
    expect(repo.getSource(source.id)?.local_path).toBe(winner.local_path);
    expect(readFileSync(join(winner.local_path!, "cube.stl"), "utf8")).toBe("solid cube\nendsolid cube\n");
    expect(readFileSync(join(winner.local_path!, "print-partner.manifest.yaml"), "utf8")).toBe(manifest);
    const revisionsRoot = join(sqlite.reposDir, String(source.id), "revisions");
    const directories = readdirSync(revisionsRoot).filter((name) => !name.startsWith(".")).sort();
    expect(directories).toEqual(repo.listSourceRevisions(source.id).map((revision) => revision.upstream_revision_key).sort());
    sqlite.close();
  });

  it("rolls activation back when test-injected import-rule persistence fails and removes the unreferenced snapshot", async () => {
    const { dir, sqlite, repo, source, workingTree } = fixture();
    const previous = await publishLocalSourceWorkingTree({ repo, reposDir: sqlite.reposDir, sourceId: source.id, workingTree });
    const revisionsRoot = join(sqlite.reposDir, String(source.id), "revisions");
    const beforeDirectories = readdirSync(revisionsRoot).sort();
    const beforeUsage = await measureTenantDiskUsage({
      dataDir: dir, reposDir: sqlite.reposDir, tenantId: "default", sourceIds: [source.id],
    });
    writeFileSync(join(workingTree, "cube.stl"), "replacement");
    const spy = vi.spyOn(repo, "updateImportRules").mockImplementationOnce(() => {
      throw new Error("test-injected import-rule persistence failure");
    });
    await expect(publishLocalSourceWorkingTree({
      repo, reposDir: sqlite.reposDir, sourceId: source.id, workingTree, suggestedImportRules: ["cube.stl"],
    })).rejects.toMatchObject({
      name: "Error",
      message: "test-injected import-rule persistence failure",
    });
    spy.mockRestore();
    expect(repo.getSource(source.id)?.local_path).toBe(previous.local_path);
    expect(readFileSync(join(previous.local_path!, "cube.stl"), "utf8")).toBe("solid cube\nendsolid cube\n");
    expect(repo.getProjectRow(source.id)?.importedPaths).toBeNull();
    expect(readdirSync(revisionsRoot).sort()).toEqual(beforeDirectories);
    expect(repo.listSourceRevisions(source.id).map((revision) => revision.upstream_revision_key).sort())
      .toEqual(beforeDirectories.filter((name) => !name.startsWith(".")));
    expect(await measureTenantDiskUsage({
      dataDir: dir, reposDir: sqlite.reposDir, tenantId: "default", sourceIds: [source.id],
    })).toBe(beforeUsage);
    sqlite.close();
  });

  it("keeps a referenced snapshot when test-injected import-rule persistence fails on reuse", async () => {
    const { dir, sqlite, repo, source, workingTree } = fixture();
    const previous = await publishLocalSourceWorkingTree({ repo, reposDir: sqlite.reposDir, sourceId: source.id, workingTree });
    const revisionsRoot = join(sqlite.reposDir, String(source.id), "revisions");
    const beforeDirectories = readdirSync(revisionsRoot).sort();
    const beforeUsage = await measureTenantDiskUsage({
      dataDir: dir, reposDir: sqlite.reposDir, tenantId: "default", sourceIds: [source.id],
    });
    const spy = vi.spyOn(repo, "updateImportRules").mockImplementationOnce(() => {
      throw new Error("test-injected import-rule persistence failure");
    });
    await expect(publishLocalSourceWorkingTree({
      repo, reposDir: sqlite.reposDir, sourceId: source.id, workingTree, suggestedImportRules: ["cube.stl"],
    })).rejects.toMatchObject({
      name: "Error",
      message: "test-injected import-rule persistence failure",
    });
    spy.mockRestore();
    expect(repo.getSource(source.id)?.local_path).toBe(previous.local_path);
    expect(readFileSync(join(previous.local_path!, "cube.stl"), "utf8")).toBe("solid cube\nendsolid cube\n");
    expect(repo.listSourceRevisions(source.id)).toHaveLength(1);
    expect(readdirSync(revisionsRoot).sort()).toEqual(beforeDirectories);
    expect(await measureTenantDiskUsage({
      dataDir: dir, reposDir: sqlite.reposDir, tenantId: "default", sourceIds: [source.id],
    })).toBe(beforeUsage);
    sqlite.close();
  });

  it("retains every uploaded file, including unrecognized and hidden files", async () => {
    const { sqlite, repo, source, workingTree } = fixture();
    writeFileSync(join(workingTree, "license.txt"), "license bytes");
    writeFileSync(join(workingTree, ".source-info"), "hidden bytes");
    const active = await publishLocalSourceWorkingTree({ repo, reposDir: sqlite.reposDir, sourceId: source.id, workingTree, preserveAllFiles: true });
    expect(readFileSync(join(active.local_path!, "license.txt"), "utf8")).toBe("license bytes");
    expect(readFileSync(join(active.local_path!, ".source-info"), "utf8")).toBe("hidden bytes");
    sqlite.close();
  });

  it.each(["index", "fallback"])("preserves active docs when admission is revoked before %s writes", async (stage) => {
    const f = fixture();
    const prior = process.env.PP_SOURCE_SYNC_OWNERSHIP_MANIFEST;
    try {
      writeFileSync(join(f.workingTree, "readme.md"), "Original docs");
      const active = await publishLocalSourceWorkingTree({
        repo: f.repo, reposDir: f.sqlite.reposDir, sourceId: f.source.id, workingTree: f.workingTree,
      });
      const localPath = active.local_path;
      const revisionId = active.current_source_revision_id;
      if (!localPath || revisionId == null) throw new Error("Source was not activated");
      indexDocsForActivatedRevision({ repo: f.repo, sourceId: f.source.id, localPath, revisionId });
      const docs = f.repo.listSourceDocs(f.source.id);
      expect(docs).toHaveLength(1);
      const row = f.repo.getProjectRow(f.source.id);
      const manifest = join(f.dir, "ownership.json");
      const original = readFileSync(packagedSourceSyncManifestPath(), "utf8");
      writeFileSync(manifest, original);
      process.env.PP_SOURCE_SYNC_OWNERSHIP_MANIFEST = manifest;
      beginSourceSyncAdmission(f.dir);
      if (stage === "index") {
        writeFileSync(manifest, `${original}\n`);
      } else {
        vi.spyOn(f.repo, "replaceSourceDocs").mockImplementationOnce(() => {
          writeFileSync(manifest, `${original}\n`);
          throw new Error("Injected indexing failure");
        });
      }
      expect(() => indexDocsForActivatedRevision({
        repo: f.repo, sourceId: f.source.id, localPath, revisionId,
        beforePublish: () => requireSourceSyncParticipant("http.POST /sources/:id/upload-files"),
      })).toThrow(/runtime manifest does not match/);
      expect(f.repo.listSourceDocs(f.source.id)).toEqual(docs);
      expect(f.repo.getProjectRow(f.source.id)).toEqual(row);
    } finally {
      vi.restoreAllMocks();
      if (prior === undefined) delete process.env.PP_SOURCE_SYNC_OWNERSHIP_MANIFEST;
      else process.env.PP_SOURCE_SYNC_OWNERSHIP_MANIFEST = prior;
      f.sqlite.close();
    }
  });

  it("clears the active revision's docs when indexing fails and ignores a stale revision", async () => {
    const { sqlite, repo, source, workingTree } = fixture();
    mkdirSync(join(workingTree, "old"));
    writeFileSync(join(workingTree, "old", "readme.md"), "old readme\n");
    const first = await publishLocalSourceWorkingTree({
      repo, reposDir: sqlite.reposDir, sourceId: source.id, workingTree, preserveAllFiles: true,
    });
    expect(indexDocsForActivatedRevision({
      repo, sourceId: source.id, localPath: first.local_path!, revisionId: first.current_source_revision_id!,
    })).toEqual({ outcome: "indexed", docCount: 1, pendingPdfs: 0 });

    const nextTree = join(sqlite.reposDir, "next-docs");
    mkdirSync(join(nextTree, "next"), { recursive: true });
    writeFileSync(join(nextTree, "cube.stl"), "solid next\nendsolid next\n");
    writeFileSync(join(nextTree, "next", "readme.md"), "next readme\n");
    const second = await publishLocalSourceWorkingTree({
      repo, reposDir: sqlite.reposDir, sourceId: source.id, workingTree: nextTree, preserveAllFiles: true,
    });
    expect(indexDocsForActivatedRevision({
      repo, sourceId: source.id, localPath: second.local_path!, revisionId: second.current_source_revision_id!,
    })).toEqual({ outcome: "indexed", docCount: 1, pendingPdfs: 0 });

    expect(indexDocsForActivatedRevision({
      repo, sourceId: source.id, localPath: first.local_path!, revisionId: first.current_source_revision_id!,
    })).toEqual({
      outcome: "unchanged",
      revisionId: first.current_source_revision_id,
      activeRevisionId: second.current_source_revision_id,
    });
    expect(repo.listSourceDocs(source.id).map((doc) => doc.path)).toEqual(["next/readme.md"]);

    vi.spyOn(repo, "replaceSourceDocs").mockImplementationOnce(() => {
      throw new Error("index unavailable");
    });
    expect(indexDocsForActivatedRevision({
      repo, sourceId: source.id, localPath: second.local_path!, revisionId: second.current_source_revision_id!,
    })).toEqual({ outcome: "cleared", revisionId: second.current_source_revision_id, reason: "index unavailable" });
    expect(repo.listSourceDocs(source.id)).toEqual([]);
    vi.restoreAllMocks();

    expect(indexDocsForActivatedRevision({
      repo, sourceId: source.id, localPath: second.local_path!, revisionId: second.current_source_revision_id!,
    })).toEqual({ outcome: "indexed", docCount: 1, pendingPdfs: 0 });
    expect(repo.listSourceDocs(source.id).map((doc) => doc.path)).toEqual(["next/readme.md"]);
    sqlite.close();
  });

  it("refuses experimental PostgreSQL publication before creating a snapshot", async () => {
    const { sqlite, repo, source, workingTree } = fixture();
    const unsupported = vi.spyOn(repo, "canPublishSourceRevision").mockReturnValue(false);
    try {
      await expect(publishLocalSourceWorkingTree({
        repo, reposDir: sqlite.reposDir, sourceId: source.id, workingTree,
      })).rejects.toThrow(SOURCE_PUBLICATION_UNAVAILABLE_DETAIL);
      await expect(publishSourceManifestRevision({
        repo, sourceId: source.id, manifestYaml: "project: preserved\nparts: []\n",
      })).rejects.toThrow(SOURCE_PUBLICATION_UNAVAILABLE_DETAIL);
      expect(existsSync(join(sqlite.reposDir, String(source.id), "revisions"))).toBe(false);
    } finally {
      unsupported.mockRestore();
      sqlite.close();
    }
  });

  it("keeps a reused digest when the creator loses activation", async () => {
    await expectSharedDigestRace("creator-first");
  }, 20_000);

  it("keeps the reused digest when the reuser registers first", async () => {
    await expectSharedDigestRace("reuser-first");
  }, 20_000);

  it("removes the unreferenced snapshot when the Source disappears during first materialization", async () => {
    const { sqlite, repo, source, workingTree } = fixture();
    const real = LocalSourceSnapshotStore.prototype.materialize;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let ready!: () => void;
    const materialized = new Promise<void>((resolve) => { ready = resolve; });
    let snapshotPath = "";
    const materialize = vi.spyOn(LocalSourceSnapshotStore.prototype, "materialize").mockImplementation(async function (
      this: LocalSourceSnapshotStore,
      input: Parameters<LocalSourceSnapshotStore["materialize"]>[0],
    ) {
      const result = await real.call(this, input);
      snapshotPath = result.absolutePath;
      ready();
      await gate;
      return result;
    });
    const pending = publishLocalSourceWorkingTree({
      repo, reposDir: sqlite.reposDir, sourceId: source.id, workingTree,
    });
    try {
      await materialized;
      expect(existsSync(snapshotPath)).toBe(true);
      expect(repo.deleteSource(source.id)).toEqual({ kind: "deleted" });
      release();
      await expect(pending).rejects.toThrow("Source not found");
      expect(existsSync(snapshotPath)).toBe(false);
      const revisions = join(sqlite.reposDir, String(source.id), "revisions");
      expect(existsSync(revisions) ? readdirSync(revisions) : []).toEqual([]);
      expect(repo.getSource(source.id)).toBeNull();
    } finally {
      release();
      materialize.mockRestore();
      await pending.catch(() => undefined);
      sqlite.close();
    }
  });
});

async function expectSharedDigestRace(order: "creator-first" | "reuser-first") {
  const { dir, sqlite, repo, source } = fixture();
  const historicalTree = join(dir, "historical");
  mkdirSync(historicalTree);
  writeFileSync(join(historicalTree, "keep.stl"), "solid keep\nendsolid keep\n");
  const historical = await publishLocalSourceWorkingTree({
    repo, reposDir: sqlite.reposDir, sourceId: source.id, workingTree: historicalTree, preserveAllFiles: true,
  });
  const separate = repo.createSource({ name: "Separate source", source_kind: "local" });
  const separateTree = join(dir, "separate");
  mkdirSync(separateTree);
  writeFileSync(join(separateTree, "same.stl"), "solid same\nendsolid same\n");
  writeFileSync(join(separateTree, "note.txt"), "digest-s\n");
  const separateActive = await publishLocalSourceWorkingTree({
    repo, reposDir: sqlite.reposDir, sourceId: separate.id, workingTree: separateTree, preserveAllFiles: true,
  });
  const sameTree = join(dir, "same");
  mkdirSync(sameTree);
  writeFileSync(join(sameTree, "same.stl"), "solid same\nendsolid same\n");
  writeFileSync(join(sameTree, "note.txt"), "digest-s\n");
  const makerTree = join(dir, "maker");
  mkdirSync(makerTree);
  writeFileSync(join(makerTree, "other.stl"), "solid other\nendsolid other\n");
  writeFileSync(join(makerTree, "note.txt"), "digest-m\n");
  const observed = repo.getSourceActivationObservation(source.id)!;
  const { rm: actualRm } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const releases: Array<() => void> = [];
  let blockStaging = true;
  vi.mocked(fsPromises.rm).mockImplementation(async (path, options) => {
    if (blockStaging && String(path).includes(".local-source-")) {
      await new Promise<void>((resolveHold) => {
        releases.push(resolveHold);
      });
    }
    return actualRm(path, options);
  });
  let pendingA: ReturnType<typeof publishLocalSourceWorkingTree> | undefined;
  let pendingB: ReturnType<typeof publishLocalSourceWorkingTree> | undefined;
  try {
    pendingA = publishLocalSourceWorkingTree({
      repo, reposDir: sqlite.reposDir, sourceId: source.id, workingTree: sameTree, observed, preserveAllFiles: true,
    });
    await waitForCount(releases, 1);
    blockStaging = false;
    const maker = await publishLocalSourceWorkingTree({
      repo, reposDir: sqlite.reposDir, sourceId: source.id, workingTree: makerTree, preserveAllFiles: true,
    });
    blockStaging = true;
    pendingB = publishLocalSourceWorkingTree({
      repo, reposDir: sqlite.reposDir, sourceId: source.id, workingTree: sameTree, preserveAllFiles: true,
    });
    await waitForCount(releases, 2);
    if (!pendingA || !pendingB) throw new Error("publish did not start");
    const revisionsRoot = join(sqlite.reposDir, String(source.id), "revisions");
    const digestS = readdirSync(revisionsRoot).find((name) => (
      !name.startsWith(".")
      && name !== basename(historical.local_path!)
      && name !== basename(maker.local_path!)
    ));
    if (digestS === undefined) throw new Error("shared digest directory was not materialized");
    expect(repo.listSourceRevisions(source.id).map((revision) => revision.upstream_revision_key).sort()).toEqual(
      [basename(historical.local_path!), basename(maker.local_path!)].sort(),
    );
    expect(readFileSync(join(revisionsRoot, digestS!, "same.stl"), "utf8")).toBe("solid same\nendsolid same\n");
    expect(readFileSync(join(revisionsRoot, digestS!, "note.txt"), "utf8")).toBe("digest-s\n");
    if (order === "creator-first") {
      releases[0]!();
      await expect(pendingA).rejects.toBeInstanceOf(SourceActivationConflictError);
      expect(readFileSync(join(revisionsRoot, digestS!, "note.txt"), "utf8")).toBe("digest-s\n");
      expect(readFileSync(join(revisionsRoot, digestS!, "same.stl"), "utf8")).toBe("solid same\nendsolid same\n");
      releases[1]!();
      const activated = await pendingB;
      expect(activated.local_path).toBe(join(revisionsRoot, digestS!));
      expect(readFileSync(join(activated.local_path!, "same.stl"), "utf8")).toBe("solid same\nendsolid same\n");
      expect(readFileSync(join(activated.local_path!, "note.txt"), "utf8")).toBe("digest-s\n");
      expect(repo.getSource(source.id)?.local_path).toBe(activated.local_path);
    } else {
      releases[1]!();
      const activated = await pendingB;
      expect(activated.local_path).toBe(join(revisionsRoot, digestS!));
      expect(readFileSync(join(activated.local_path!, "note.txt"), "utf8")).toBe("digest-s\n");
      releases[0]!();
      const creator = await pendingA;
      expect(creator.local_path).toBe(activated.local_path);
      expect(readFileSync(join(creator.local_path!, "same.stl"), "utf8")).toBe("solid same\nendsolid same\n");
    }
    expect(readFileSync(join(historical.local_path!, "keep.stl"), "utf8")).toBe("solid keep\nendsolid keep\n");
    expect(readFileSync(join(maker.local_path!, "other.stl"), "utf8")).toBe("solid other\nendsolid other\n");
    expect(readFileSync(join(maker.local_path!, "note.txt"), "utf8")).toBe("digest-m\n");
    expect(readFileSync(join(separateActive.local_path!, "same.stl"), "utf8")).toBe("solid same\nendsolid same\n");
    expect(readFileSync(join(separateActive.local_path!, "note.txt"), "utf8")).toBe("digest-s\n");
    const referenced = repo.listSourceRevisions(source.id).map((revision) => revision.upstream_revision_key).sort();
    const directories = readdirSync(revisionsRoot).filter((name) => !name.startsWith(".")).sort();
    expect(directories).toEqual(referenced);
    expect(directories).toEqual([basename(historical.local_path!), basename(maker.local_path!), digestS!].sort());
  } finally {
    for (const release of releases) release();
    vi.mocked(fsPromises.rm).mockImplementation((path, options) => actualRm(path, options));
    await Promise.allSettled([pendingA, pendingB].filter((pending) => pending !== undefined));
    sqlite.close();
  }
}

describe("removeObsoleteHostedWorkingTree", () => {
  it("keeps the active path and deletes only an obsolete hosted working tree", async () => {
    const root = mkdtempSync(join(tmpdir(), "pp-hosted-tree-"));
    roots.push(root);
    const sources = join(root, "sources");
    const legacy = join(sources, "7");
    mkdirSync(join(legacy, "files"), { recursive: true });
    writeFileSync(join(legacy, "files", "keep.stl"), "keep");
    const activeChild = join(legacy, "still-active");
    mkdirSync(activeChild, { recursive: true });
    await removeObsoleteHostedWorkingTree({ sourcesDir: sources, sourceId: 7, activePath: activeChild });
    expect(readFileSync(join(legacy, "files", "keep.stl"), "utf8")).toBe("keep");
    await removeObsoleteHostedWorkingTree({ sourcesDir: sources, sourceId: 7, activePath: legacy });
    expect(existsSync(join(legacy, "files", "keep.stl"))).toBe(true);
    await removeObsoleteHostedWorkingTree({
      sourcesDir: sources,
      sourceId: 7,
      activePath: join(root, "repos", "7", "revisions", "abc"),
    });
    expect(existsSync(legacy)).toBe(false);
  });
});

async function waitForCount(releases: Array<() => void>, count: number) {
  const started = Date.now();
  while (releases.length < count) {
    if (Date.now() - started > 5000) {
      throw new Error(`timed out with ${releases.length} held staging removals`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
