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
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fsPromises from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDb, SqliteDatabase } from "../db/client.js";
import { AppRepository } from "../db/repository.js";
import { SOURCE_SNAPSHOT_MANIFEST_FILE } from "./local-source-snapshot.js";
import {
  publishLocalSourceWorkingTree,
  publishSourceManifestRevision,
} from "./local-source-revision.js";

vi.mock("node:fs/promises", { spy: true });

const roots: string[] = [];

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
