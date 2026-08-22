import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDb, SqliteDatabase, type DrizzleDb } from "./client.js";
import { AppRepository } from "./repository.js";
import * as schema from "./schema.js";
import type { PlanRevisionInput, SourceRevision } from "@print-partner/contracts";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

function withRepos(
  fn: (repos: { defaultRepo: AppRepository; otherRepo: AppRepository; db: DrizzleDb }) => void,
) {
  const dir = mkdtempSync(join(tmpdir(), "pp-source-revision-"));
  const sqlite = new SqliteDatabase(dir);
  sqlite.connect();
  const db = getDb(sqlite);
  try {
    fn({
      defaultRepo: new AppRepository(db, "default", sqlite.reposDir),
      otherRepo: new AppRepository(db, "other", sqlite.reposDir),
      db,
    });
  } finally {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function addSource(repo: AppRepository, name: string) {
  return repo.createSource({
    name,
    url: `https://github.com/example/${name.toLowerCase().replaceAll(" ", "-")}`,
    source_kind: "github",
  });
}

function revisionInput(
  sourceId: number,
  revision: SourceRevision,
  layerOrder = 0,
  manifestDigest = revision.manifest_digest,
): PlanRevisionInput {
  return {
    source_id: sourceId,
    source_layer: `${layerOrder === 0 ? "base" : "addon"}:source-${sourceId}`,
    layer_order: layerOrder,
    tracking_kind: "revision",
    source_revision_id: revision.id,
    manifest_digest: manifestDigest,
    effective_naming_digest: "c".repeat(64),
  };
}

describe("Source revision repository", () => {
  it("records complete revisions idempotently and keeps their original identity", () => {
    withRepos(({ defaultRepo }) => {
      const source = addSource(defaultRepo, "Voron Trident");
      const first = defaultRepo.recordSourceRevision({
        sourceId: source.id,
        upstreamRevisionKey: "commit-a",
        manifestDigest: DIGEST_A,
        snapshotLocator: "sources/default/1/revisions/commit-a",
        syncedAt: "2026-08-20T10:00:00.000Z",
        completeness: "complete",
      });
      const retry = defaultRepo.recordSourceRevision({
        sourceId: source.id,
        upstreamRevisionKey: "commit-a",
        manifestDigest: DIGEST_A,
        snapshotLocator: "sources/default/1/revisions/commit-a",
        syncedAt: "2026-08-20T11:00:00.000Z",
        completeness: "complete",
      });

      expect(retry).toEqual(first);
      expect(defaultRepo.listSourceRevisions(source.id)).toEqual([first]);
      expect(defaultRepo.getSourceRevision(first.id)).toEqual(first);
      expect(first.synced_at).toBe("2026-08-20T10:00:00.000Z");
    });
  });

  it("rejects incomplete registrations and conflicting content for one upstream key", () => {
    withRepos(({ defaultRepo, db }) => {
      const source = addSource(defaultRepo, "Stealthburner");
      expect(() =>
        defaultRepo.recordSourceRevision({
          sourceId: source.id,
          upstreamRevisionKey: "commit-a",
          manifestDigest: DIGEST_A,
          snapshotLocator: "sources/default/1/revisions/incomplete",
          syncedAt: "2026-08-20T10:00:00.000Z",
          completeness: "incomplete",
        }),
      ).toThrow(/incomplete.*not.*revision/i);
      expect(() =>
        db
          .insert(schema.sourceRevisions)
          .values({
            tenantId: "default",
            projectId: source.id,
            upstreamRevisionKey: "raw-incomplete",
            manifestDigest: DIGEST_A,
            snapshotLocator: "sources/default/1/revisions/raw-incomplete",
            syncedAt: "2026-08-20T10:00:00.000Z",
            completeness: "incomplete",
          })
          .run(),
      ).toThrow(/check constraint/i);

      const original = defaultRepo.recordSourceRevision({
        sourceId: source.id,
        upstreamRevisionKey: "commit-a",
        manifestDigest: DIGEST_A,
        snapshotLocator: "sources/default/1/revisions/commit-a",
        syncedAt: "2026-08-20T10:00:00.000Z",
        completeness: "complete",
      });
      expect(() =>
        defaultRepo.recordSourceRevision({
          sourceId: source.id,
          upstreamRevisionKey: "commit-a",
          manifestDigest: DIGEST_B,
          snapshotLocator: "sources/default/1/revisions/commit-a-rewritten",
          syncedAt: "2026-08-20T11:00:00.000Z",
          completeness: "complete",
        }),
      ).toThrow(/conflict/i);
      expect(defaultRepo.getSourceRevision(original.id)).toEqual(original);
    });
  });

  it("rejects a revision locator that resolves to the repository root", () => {
    withRepos(({ defaultRepo }) => {
      const source = addSource(defaultRepo, "Unsafe locator");
      const revision = defaultRepo.recordSourceRevision({
        sourceId: source.id,
        upstreamRevisionKey: "root",
        manifestDigest: DIGEST_A,
        snapshotLocator: ".",
        syncedAt: "2026-08-20T10:00:00.000Z",
        completeness: "complete",
      });
      const observed = defaultRepo.getProjectRow(source.id);
      if (!observed) throw new Error("test Source missing");

      expect(() =>
        defaultRepo.activateSourceRevision({
          sourceId: source.id,
          revisionId: revision.id,
          observed,
        }),
      ).toThrow(/storage-relative/i);
    });
  });

  it("keeps a published Plan pinned after a newer Source revision exists", () => {
    withRepos(({ defaultRepo }) => {
      const source = addSource(defaultRepo, "LDO Trident");
      const plan = defaultRepo.createProfile("Trident 300");
      const revisionA = defaultRepo.recordSourceRevision({
        sourceId: source.id,
        upstreamRevisionKey: "commit-a",
        manifestDigest: DIGEST_A,
        snapshotLocator: "sources/default/1/revisions/commit-a",
        syncedAt: "2026-08-20T10:00:00.000Z",
        completeness: "complete",
      });
      const published = defaultRepo.publishPlanRevisionInputs(plan.id, [
        revisionInput(source.id, revisionA),
      ]);

      defaultRepo.recordSourceRevision({
        sourceId: source.id,
        upstreamRevisionKey: "commit-b",
        manifestDigest: DIGEST_B,
        snapshotLocator: "sources/default/1/revisions/commit-b",
        syncedAt: "2026-08-20T11:00:00.000Z",
        completeness: "complete",
      });

      expect(defaultRepo.getLatestPlanRevisionInputSet(plan.id)).toEqual(published);
      expect(published.inputs).toEqual([revisionInput(source.id, revisionA)]);
    });
  });

  it("publishes canonical input sets idempotently and never reads drafts", () => {
    withRepos(({ defaultRepo, db }) => {
      const firstSource = addSource(defaultRepo, "Base");
      const secondSource = addSource(defaultRepo, "Addon");
      const plan = defaultRepo.createProfile("Combined");
      const first = defaultRepo.recordSourceRevision({
        sourceId: firstSource.id,
        upstreamRevisionKey: "base-a",
        manifestDigest: DIGEST_A,
        snapshotLocator: "sources/default/base-a",
        syncedAt: "2026-08-20T10:00:00.000Z",
        completeness: "complete",
      });
      const second = defaultRepo.recordSourceRevision({
        sourceId: secondSource.id,
        upstreamRevisionKey: "addon-b",
        manifestDigest: DIGEST_B,
        snapshotLocator: "sources/default/addon-b",
        syncedAt: "2026-08-20T10:00:00.000Z",
        completeness: "complete",
      });

      db.insert(schema.planRevisionInputSets)
        .values({
          tenantId: "default",
          profileId: plan.id,
          inputSetDigest: "f".repeat(64),
          expectedInputCount: 1,
          recordedAt: "2026-08-20T09:00:00.000Z",
        })
        .run();
      expect(defaultRepo.listPlanRevisionInputSets(plan.id)).toEqual([]);

      const firstPublish = defaultRepo.publishPlanRevisionInputs(plan.id, [
        revisionInput(secondSource.id, second, 1),
        revisionInput(firstSource.id, first),
      ]);
      const retry = defaultRepo.publishPlanRevisionInputs(plan.id, [
        revisionInput(firstSource.id, first),
        revisionInput(secondSource.id, second, 1),
      ]);

      expect(retry).toEqual(firstPublish);
      expect(firstPublish.inputs.map((input) => input.source_revision_id)).toEqual([
        first.id,
        second.id,
      ]);
      expect(defaultRepo.listPlanRevisionInputSets(plan.id)).toEqual([firstPublish]);
    });
  });

  it("rejects mismatched digests and cross-tenant revisions", () => {
    withRepos(({ defaultRepo, otherRepo }) => {
      const plan = defaultRepo.createProfile("Default plan");
      const source = addSource(defaultRepo, "Default source");
      const revision = defaultRepo.recordSourceRevision({
        sourceId: source.id,
        upstreamRevisionKey: "default-a",
        manifestDigest: DIGEST_A,
        snapshotLocator: "sources/default/default-a",
        syncedAt: "2026-08-20T10:00:00.000Z",
        completeness: "complete",
      });
      expect(() =>
        defaultRepo.publishPlanRevisionInputs(plan.id, [
          revisionInput(source.id, revision, 0, DIGEST_B),
        ]),
      ).toThrow(/digest/i);

      const otherSource = addSource(otherRepo, "Other source");
      const otherRevision = otherRepo.recordSourceRevision({
        sourceId: otherSource.id,
        upstreamRevisionKey: "other-a",
        manifestDigest: DIGEST_B,
        snapshotLocator: "sources/other/other-a",
        syncedAt: "2026-08-20T10:00:00.000Z",
        completeness: "complete",
      });
      expect(defaultRepo.getSourceRevision(otherRevision.id)).toBeNull();
      expect(() =>
        defaultRepo.publishPlanRevisionInputs(plan.id, [
          revisionInput(otherSource.id, otherRevision),
        ]),
      ).toThrow(/source not found/i);
    });
  });

  it("prevents Source deletion once immutable revision history exists", () => {
    withRepos(({ defaultRepo }) => {
      const disposable = addSource(defaultRepo, "Disposable");
      expect(() => defaultRepo.deleteSource(disposable.id)).not.toThrow();

      const retained = addSource(defaultRepo, "Retained");
      defaultRepo.recordSourceRevision({
        sourceId: retained.id,
        upstreamRevisionKey: "retained-a",
        manifestDigest: DIGEST_A,
        snapshotLocator: "sources/default/retained-a",
        syncedAt: "2026-08-20T10:00:00.000Z",
        completeness: "complete",
      });
      expect(() => defaultRepo.deleteSource(retained.id)).toThrow(/revision history/i);
      expect(defaultRepo.getSource(retained.id)).not.toBeNull();
    });
  });
});
