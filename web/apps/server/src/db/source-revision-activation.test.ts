import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { getDb, SqliteDatabase, type DrizzleDb } from "./client.js";
import { AppRepository } from "./repository.js";
import * as schema from "./schema.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

function withRepos(
  fn: (context: {
    defaultRepo: AppRepository;
    otherRepo: AppRepository;
    db: DrizzleDb;
    reposDir: string;
  }) => void,
): void {
  const dir = mkdtempSync(join(tmpdir(), "pp-source-activation-"));
  const sqlite = new SqliteDatabase(dir);
  sqlite.connect();
  try {
    fn({
      defaultRepo: new AppRepository(getDb(sqlite), "default", sqlite.reposDir),
      otherRepo: new AppRepository(getDb(sqlite), "other", sqlite.reposDir),
      db: getDb(sqlite),
      reposDir: sqlite.reposDir,
    });
  } finally {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function addSource(repo: AppRepository, name: string) {
  return repo.createSource({
    name,
    url: `https://github.com/example/${name.toLowerCase()}`,
    branch: "main",
    source_kind: "github",
    source_type: "git",
    metadata: { retained: true },
  });
}

function addRevision(
  repo: AppRepository,
  sourceId: number,
  key: string,
  digest: string,
) {
  return repo.recordSourceRevision({
    sourceId,
    upstreamRevisionKey: key,
    manifestDigest: digest,
    snapshotLocator: `${sourceId}/revisions/${key}`,
    syncedAt: "2026-08-20T10:00:00.000Z",
    completeness: "complete",
  });
}

function getObservedSource(repo: AppRepository, sourceId: number) {
  const source = repo.getProjectRow(sourceId);
  if (!source) throw new Error("Test Source was not created");
  return source;
}

describe("Source revision activation", () => {
  it("activates one owned revision and derives every mutable pointer from it", () => {
    withRepos(({ defaultRepo, reposDir }) => {
      const source = addSource(defaultRepo, "Trident");
      const observed = getObservedSource(defaultRepo, source.id);
      const revision = addRevision(defaultRepo, source.id, "commit-a", DIGEST_A);

      const activated = defaultRepo.activateSourceRevision({
        sourceId: source.id,
        revisionId: revision.id,
        observed,
      });

      expect(activated).toMatchObject({
        current_source_revision_id: revision.id,
        last_commit_sha: "commit-a",
        last_synced_at: "2026-08-20T10:00:00.000Z",
        local_path: join(reposDir, String(source.id), "revisions", "commit-a"),
        metadata: { retained: true },
      });

      defaultRepo.markSourceRevisionCurrent(
        source.id,
        revision.id,
        "2026-08-20T10:05:00.000Z",
      );
      expect(defaultRepo.getSource(source.id)).toMatchObject({
        last_synced_at: "2026-08-20T10:00:00.000Z",
        metadata: {
          retained: true,
          remote_update_status: "up_to_date",
          remote_checked_at: "2026-08-20T10:05:00.000Z",
        },
      });
    });
  });

  it("rejects a revision owned by another Source or tenant", () => {
    withRepos(({ defaultRepo, otherRepo }) => {
      const first = addSource(defaultRepo, "First");
      const second = addSource(defaultRepo, "Second");
      const other = addSource(otherRepo, "Other");
      const secondRevision = addRevision(defaultRepo, second.id, "second-a", DIGEST_A);
      const otherRevision = addRevision(otherRepo, other.id, "other-a", DIGEST_B);
      const observed = getObservedSource(defaultRepo, first.id);

      expect(() =>
        defaultRepo.activateSourceRevision({
          sourceId: first.id,
          revisionId: secondRevision.id,
          observed,
        }),
      ).toThrow(/revision not found for source/i);
      expect(() =>
        defaultRepo.activateSourceRevision({
          sourceId: first.id,
          revisionId: otherRevision.id,
          observed,
        }),
      ).toThrow(/revision not found for source/i);
      expect(defaultRepo.getSource(first.id)?.current_source_revision_id).toBeNull();
    });
  });

  it("treats a concurrent publication of the same revision as idempotent", () => {
    withRepos(({ defaultRepo }) => {
      const source = addSource(defaultRepo, "Concurrent");
      const observed = getObservedSource(defaultRepo, source.id);
      const revision = addRevision(defaultRepo, source.id, "same-commit", DIGEST_A);

      const first = defaultRepo.activateSourceRevision({
        sourceId: source.id,
        revisionId: revision.id,
        observed,
      });
      const retry = defaultRepo.activateSourceRevision({
        sourceId: source.id,
        revisionId: revision.id,
        observed,
      });

      expect(retry).toEqual(first);
    });
  });

  const staleMutations: Array<{
    field: string;
    mutate: (db: DrizzleDb, sourceId: number, otherRevisionId: number) => void;
  }> = [
    {
      field: "current revision",
      mutate: (db, sourceId, otherRevisionId) => {
        db.update(schema.projects)
          .set({ currentSourceRevisionId: otherRevisionId })
          .where(eq(schema.projects.id, sourceId))
          .run();
      },
    },
    {
      field: "URL",
      mutate: (db, sourceId) => {
        db.update(schema.projects)
          .set({ url: "https://github.com/example/changed" })
          .where(eq(schema.projects.id, sourceId))
          .run();
      },
    },
    {
      field: "branch",
      mutate: (db, sourceId) => {
        db.update(schema.projects)
          .set({ branch: "release" })
          .where(eq(schema.projects.id, sourceId))
          .run();
      },
    },
    {
      field: "tag",
      mutate: (db, sourceId) => {
        db.update(schema.projects)
          .set({ tag: "v2.0.0" })
          .where(eq(schema.projects.id, sourceId))
          .run();
      },
    },
    {
      field: "Source kind",
      mutate: (db, sourceId) => {
        db.update(schema.projects)
          .set({ sourceKind: "local" })
          .where(eq(schema.projects.id, sourceId))
          .run();
      },
    },
    {
      field: "Source type",
      mutate: (db, sourceId) => {
        db.update(schema.projects)
          .set({ sourceType: "local" })
          .where(eq(schema.projects.id, sourceId))
          .run();
      },
    },
    {
      field: "local path",
      mutate: (db, sourceId) => {
        db.update(schema.projects)
          .set({ localPath: "/changed/source/path" })
          .where(eq(schema.projects.id, sourceId))
          .run();
      },
    },
    {
      field: "last commit",
      mutate: (db, sourceId) => {
        db.update(schema.projects)
          .set({ lastCommitSha: "external-update" })
          .where(eq(schema.projects.id, sourceId))
          .run();
      },
    },
  ];

  it.each(staleMutations)("does not activate after the observed $field changes", ({ mutate }) => {
    withRepos(({ defaultRepo, db }) => {
      const source = addSource(defaultRepo, "Guarded");
      const target = addRevision(defaultRepo, source.id, "target", DIGEST_A);
      const other = addRevision(defaultRepo, source.id, "other", DIGEST_B);
      const observed = getObservedSource(defaultRepo, source.id);
      mutate(db, source.id, other.id);

      expect(() =>
        defaultRepo.activateSourceRevision({
          sourceId: source.id,
          revisionId: target.id,
          observed,
        }),
      ).toThrow(/changed during sync/i);
      expect(defaultRepo.getSource(source.id)?.last_synced_at).toBeNull();
      expect(defaultRepo.getSource(source.id)?.current_source_revision_id).not.toBe(target.id);
    });
  });

  it("rejects absolute and traversing snapshot locators", () => {
    withRepos(({ defaultRepo }) => {
      const source = addSource(defaultRepo, "Unsafe");
      const observed = getObservedSource(defaultRepo, source.id);
      const absolute = defaultRepo.recordSourceRevision({
        sourceId: source.id,
        upstreamRevisionKey: "absolute",
        manifestDigest: DIGEST_A,
        snapshotLocator: "/tmp/outside",
        syncedAt: "2026-08-20T10:00:00.000Z",
        completeness: "complete",
      });
      const traversing = defaultRepo.recordSourceRevision({
        sourceId: source.id,
        upstreamRevisionKey: "traversing",
        manifestDigest: DIGEST_B,
        snapshotLocator: `${source.id}/../outside`,
        syncedAt: "2026-08-20T10:00:00.000Z",
        completeness: "complete",
      });

      expect(() =>
        defaultRepo.activateSourceRevision({
          sourceId: source.id,
          revisionId: absolute.id,
          observed,
        }),
      ).toThrow(/storage-relative/i);
      expect(() =>
        defaultRepo.activateSourceRevision({
          sourceId: source.id,
          revisionId: traversing.id,
          observed,
        }),
      ).toThrow(/storage-relative/i);
    });
  });

  it("does not let generic Source updates change the revision pointer", () => {
    withRepos(({ defaultRepo }) => {
      const source = addSource(defaultRepo, "Generic");
      const revision = addRevision(defaultRepo, source.id, "commit-a", DIGEST_A);

      defaultRepo.updateSource(source.id, {
        last_commit_sha: revision.upstream_revision_key,
      });

      expect(defaultRepo.getSource(source.id)?.current_source_revision_id).toBeNull();
    });
  });
});

describe("current Source revision migration", () => {
  it("adds the guarded pointer to an existing database without losing Source data", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-source-pointer-migration-"));
    try {
      const first = new SqliteDatabase(dir);
      first.connect();
      const firstRepo = new AppRepository(getDb(first), "default", first.reposDir);
      const source = addSource(firstRepo, "Legacy");
      addRevision(firstRepo, source.id, "legacy-a", DIGEST_A);
      first.close();

      const raw = new Database(join(dir, "print-partner.db"));
      raw.exec("ALTER TABLE projects DROP COLUMN current_source_revision_id");
      expect(
        (raw.pragma("table_info(projects)") as Array<{ name: string }>).some(
          (column) => column.name === "current_source_revision_id",
        ),
      ).toBe(false);
      raw.close();

      const upgraded = new SqliteDatabase(dir);
      upgraded.connect();
      const upgradedRepo = new AppRepository(getDb(upgraded), "default", upgraded.reposDir);
      expect(upgradedRepo.getSource(source.id)).toMatchObject({
        name: "Legacy",
        current_source_revision_id: null,
      });
      expect(() =>
        getDb(upgraded)
          .update(schema.projects)
          .set({ currentSourceRevisionId: 999_999 })
          .where(eq(schema.projects.id, source.id))
          .run(),
      ).toThrow(/foreign key/i);
      upgraded.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
