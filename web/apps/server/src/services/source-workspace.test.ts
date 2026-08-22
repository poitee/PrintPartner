import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { getDb, SqliteDatabase } from "../db/client.js";
import { AppRepository } from "../db/repository.js";
import { registerRepoManifestRoutes } from "../routes/repo-manifest.js";
import {
  editableSourceManifestPath,
  findEditableSourceManifestPath,
  revisionPdfTextCacheRoot,
  sourcePdfTextStorage,
} from "./source-workspace.js";

const cleanupDirs: string[] = [];

function createRepo() {
  const dataDir = mkdtempSync(join(tmpdir(), "pp-source-workspace-"));
  cleanupDirs.push(dataDir);
  const sqlite = new SqliteDatabase(dataDir);
  sqlite.connect();
  return {
    dataDir,
    sqlite,
    repo: new AppRepository(getDb(sqlite), undefined, sqlite.reposDir),
  };
}

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Source workspace derived paths", () => {
  it("keys PDF text by the active revision digest outside revision content", () => {
    const { dataDir, sqlite, repo } = createRepo();
    const source = repo.createSource({
      name: "Trident",
      url: "https://github.com/VoronDesign/Voron-Trident",
    });
    const digest = "a".repeat(64);
    const revisionRoot = join(dataDir, "repos", String(source.id), "revisions", "commit-a");
    const revision = repo.recordSourceRevision({
      sourceId: source.id,
      upstreamRevisionKey: "commit-a",
      manifestDigest: digest,
      snapshotLocator: `${source.id}/revisions/commit-a`,
      syncedAt: "2026-08-20T12:00:00.000Z",
      completeness: "complete",
    });
    const observed = repo.getProjectRow(source.id);
    if (!observed) throw new Error("Expected Source row");
    repo.activateSourceRevision({
      sourceId: source.id,
      revisionId: revision.id,
      observed,
    });

    const storage = sourcePdfTextStorage(repo, source.id, revisionRoot);

    expect(storage.cacheRoot).toBe(
      revisionPdfTextCacheRoot({ reposDir: repo.reposDir, sourceId: source.id, manifestDigest: digest }),
    );
    expect(storage.cacheRoot.startsWith(revisionRoot)).toBe(false);
    expect(storage.legacyCacheRoots).toContain(join(revisionRoot, ".docs-text"));
    sqlite.close();
  });

  it("prefers the editable workspace manifest and falls back to revision content", () => {
    const { dataDir, sqlite, repo } = createRepo();
    const source = repo.createSource({
      name: "Stealthburner",
      url: "https://github.com/VoronDesign/Voron-Stealthburner",
    });
    const revisionRoot = join(dataDir, "repos", String(source.id), "revisions", "commit-a");
    const legacyPath = join(revisionRoot, "print-partner.manifest.yaml");
    mkdirSync(revisionRoot, { recursive: true });
    writeFileSync(legacyPath, "project: legacy\n", "utf8");

    expect(
      findEditableSourceManifestPath({
        reposDir: repo.reposDir,
        sourceId: source.id,
        contentRoot: revisionRoot,
      }),
    ).toBe(legacyPath);

    const editablePath = editableSourceManifestPath(repo.reposDir, source.id);
    writeFileSync(editablePath, "project: editable\n", "utf8");
    expect(
      findEditableSourceManifestPath({
        reposDir: repo.reposDir,
        sourceId: source.id,
        contentRoot: revisionRoot,
      }),
    ).toBe(editablePath);
    sqlite.close();
  });
});

describe("repo manifest routes", () => {
  it("writes the editable manifest to the Source workspace without changing revision content", async () => {
    const { dataDir, sqlite, repo } = createRepo();
    const source = repo.createSource({
      name: "LDO Trident",
      url: "https://github.com/example/ldo-trident",
    });
    const revisionRoot = join(dataDir, "repos", String(source.id), "revisions", "commit-a");
    const revisionManifest = join(revisionRoot, "print-partner.manifest.yaml");
    mkdirSync(revisionRoot, { recursive: true });
    writeFileSync(revisionManifest, "project: upstream\n", "utf8");
    repo.updateSource(source.id, { local_path: revisionRoot });

    const app = Fastify();
    await registerRepoManifestRoutes(app, { repo });
    const response = await app.inject({
      method: "PUT",
      url: `/sources/${source.id}/repo-manifest`,
      payload: { yaml: "project: edited\n" },
    });

    expect(response.statusCode).toBe(200);
    expect(readFileSync(revisionManifest, "utf8")).toBe("project: upstream\n");
    expect(readFileSync(editableSourceManifestPath(repo.reposDir, source.id), "utf8")).toBe(
      "project: edited\n",
    );

    const getResponse = await app.inject({
      method: "GET",
      url: `/sources/${source.id}/repo-manifest`,
    });
    expect(getResponse.json()).toMatchObject({ exists: true, yaml: "project: edited\n" });

    await app.close();
    sqlite.close();
  });
});
