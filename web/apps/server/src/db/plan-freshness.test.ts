import { acceptPlanForTest } from "../test/accept-plan.js";
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDb, SqliteDatabase } from "./client.js";
import type { DrizzleDb } from "./client.js";
import { AppRepository } from "./repository.js";
import * as schema from "./schema.js";
import { resolvePartStl } from "../services/part-paths.js";

function withRepo(fn: (repo: AppRepository, reposDir: string, db: DrizzleDb) => void) {
  const dir = mkdtempSync(join(tmpdir(), "pp-plan-freshness-"));
  const sqlite = new SqliteDatabase(dir);
  sqlite.connect();
  try {
    const db = getDb(sqlite);
    fn(new AppRepository(db, "default", sqlite.reposDir), sqlite.reposDir, db);
  } finally {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function createTrackedSource(
  repo: AppRepository,
  reposDir: string,
  name: string,
  revisionKey: string,
  stlBody: string,
) {
  const source = repo.createSource({
    name,
    url: `https://github.com/example/${name.toLowerCase()}`,
    source_kind: "github",
  });
  return { source, revision: activateRevision(repo, reposDir, source.id, revisionKey, stlBody) };
}

function activateRevision(
  repo: AppRepository,
  reposDir: string,
  sourceId: number,
  revisionKey: string,
  stlBody: string,
) {
  const observed = repo.getProjectRow(sourceId);
  if (!observed) throw new Error("test Source missing");
  const locator = `${sourceId}/revisions/${revisionKey}`;
  const root = join(reposDir, locator);
  mkdirSync(join(root, "parts"), { recursive: true });
  writeFileSync(join(root, "parts", "bracket.stl"), stlBody);
  const revision = repo.recordSourceRevision({
    sourceId,
    upstreamRevisionKey: revisionKey,
    manifestDigest: revisionKey.padEnd(64, revisionKey[0] ?? "a").slice(0, 64),
    snapshotLocator: locator,
    syncedAt: new Date().toISOString(),
    completeness: "complete",
  });
  repo.activateSourceRevision({ sourceId, revisionId: revision.id, observed });
  return revision;
}

describe("Plan freshness", () => {
  it("invalidates only Plans that accepted an advanced Source revision", () => {
    withRepo((repo, reposDir) => {
      const first = createTrackedSource(repo, reposDir, "Base", "a", "solid a");
      const second = createTrackedSource(repo, reposDir, "Other", "c", "solid c");
      const dependent = repo.createProfile("Dependent", first.source.id);
      const unrelated = repo.createProfile("Unrelated", second.source.id);

      expect(acceptPlanForTest(repo, dependent.id).merged).toBe(true);
      expect(acceptPlanForTest(repo, unrelated.id).merged).toBe(true);
      expect(repo.getProfileHeader(dependent.id)?.freshness.status).toBe("current");
      expect(repo.getProfileHeader(unrelated.id)?.freshness.status).toBe("current");

      const partsBefore = repo.listParts(dependent.id).parts;
      const acceptedBefore = repo.readAcceptedPlanOperationalSnapshot(dependent.id);
      const revisionB = activateRevision(repo, reposDir, first.source.id, "b", "solid b");

      expect(repo.getProfileHeader(dependent.id)?.freshness).toMatchObject({
        status: "stale",
        reasons: [
          {
            kind: "source_revision_changed",
            source_id: first.source.id,
            accepted_revision_id: first.revision.id,
            current_revision_id: revisionB.id,
          },
        ],
      });
      expect(repo.getProfileHeader(unrelated.id)?.freshness.status).toBe("current");
      expect(repo.listParts(dependent.id).parts).toEqual(partsBefore);
      expect(repo.readAcceptedPlanOperationalSnapshot(dependent.id)).toEqual(acceptedBefore);
    });
  });

  it("moves the accepted pointer A to B to the existing A input set", () => {
    withRepo((repo, reposDir) => {
      const tracked = createTrackedSource(repo, reposDir, "Rollback", "a", "solid a");
      const plan = repo.createProfile("Rollback plan", tracked.source.id);
      acceptPlanForTest(repo, plan.id);
      const acceptedA = repo.getAcceptedPlanRevisionInputSet(plan.id);

      const revisionB = activateRevision(repo, reposDir, tracked.source.id, "b", "solid b");
      acceptPlanForTest(repo, plan.id);
      const acceptedB = repo.getAcceptedPlanRevisionInputSet(plan.id);
      expect(acceptedB?.id).not.toBe(acceptedA?.id);

      const observed = repo.getProjectRow(tracked.source.id);
      if (!observed) throw new Error("test Source missing");
      repo.activateSourceRevision({
        sourceId: tracked.source.id,
        revisionId: tracked.revision.id,
        observed,
      });
      acceptPlanForTest(repo, plan.id);

      expect(repo.getAcceptedPlanRevisionInputSet(plan.id)?.id).toBe(acceptedA?.id);
      expect(repo.listPlanRevisionInputSets(plan.id)).toHaveLength(2);
      expect(revisionB.id).not.toBe(tracked.revision.id);
    });
  });

  it("keeps accepted STL reads pinned after the Source advances", () => {
    withRepo((repo, reposDir) => {
      const tracked = createTrackedSource(repo, reposDir, "Pinned", "a", "solid accepted");
      const plan = repo.createProfile("Pinned plan", tracked.source.id);
      acceptPlanForTest(repo, plan.id);
      const part = repo.getProfilePartRows(plan.id)[0];
      if (!part) throw new Error("test part missing");

      activateRevision(repo, reposDir, tracked.source.id, "b", "solid current");

      const resolved = resolvePartStl(repo, part);
      expect(resolved).not.toBeNull();
      expect(readFileSync(resolved!, "utf8")).toBe("solid accepted");
    });
  });

  it("scans the active revision snapshot instead of a mismatched Source path", () => {
    withRepo((repo, reposDir) => {
      const tracked = createTrackedSource(repo, reposDir, "Aligned", "a", "solid accepted");
      const otherRoot = join(reposDir, `${tracked.source.id}/revisions/b`);
      mkdirSync(join(otherRoot, "parts"), { recursive: true });
      writeFileSync(join(otherRoot, "parts", "wrong.stl"), "solid wrong");
      repo.recordSourceRevision({
        sourceId: tracked.source.id,
        upstreamRevisionKey: "b",
        manifestDigest: "b".repeat(64),
        snapshotLocator: `${tracked.source.id}/revisions/b`,
        syncedAt: new Date().toISOString(),
        completeness: "complete",
      });
      repo.updateSource(tracked.source.id, { local_path: otherRoot });
      const plan = repo.createProfile("Aligned plan", tracked.source.id);

      expect(acceptPlanForTest(repo, plan.id).merged).toBe(true);
      expect(repo.listParts(plan.id).parts.map((part) => part.filename)).toEqual([
        "bracket.stl",
      ]);
      expect(repo.getAcceptedPlanRevisionInputSet(plan.id)?.inputs[0]?.source_revision_id).toBe(
        tracked.revision.id,
      );
    });
  });

  it("records effective naming changes and treats non-revision Sources as untracked", () => {
    withRepo((repo, reposDir) => {
      const tracked = createTrackedSource(repo, reposDir, "Named", "a", "solid named");
      const trackedPlan = repo.createProfile("Named plan", tracked.source.id);
      acceptPlanForTest(repo, trackedPlan.id);

      const current = repo.getGlobalNaming();
      repo.saveSourceNaming(tracked.source.id, {
        kind: "override",
        profile: {
          ...current,
          quantity: { ...current.quantity, default: current.quantity.default + 1 },
        },
      });
      expect(repo.getProfileHeader(trackedPlan.id)?.freshness).toMatchObject({
        status: "stale",
        reasons: [{ kind: "naming_rules_changed", source_id: tracked.source.id }],
      });

      const local = repo.createSource({
        name: "Local",
        source_kind: "local",
        local_path: join(reposDir, "local"),
      });
      mkdirSync(join(reposDir, "local"), { recursive: true });
      writeFileSync(join(reposDir, "local", "local.stl"), "solid local");
      const localPlan = repo.createProfile("Local plan", local.id);
      acceptPlanForTest(repo, localPlan.id);
      expect(repo.getProfileHeader(localPlan.id)?.freshness).toMatchObject({
        status: "untracked",
        reasons: [{ kind: "source_revision_untracked", source_id: local.id }],
      });
    });
  });

  it("does not accept a refused rebuild", () => {
    withRepo((repo, reposDir) => {
      const tracked = createTrackedSource(repo, reposDir, "Refused", "a", "solid a");
      const plan = repo.createProfile("Refused plan", tracked.source.id);
      acceptPlanForTest(repo, plan.id);
      const accepted = repo.getAcceptedPlanRevisionInputSet(plan.id);
      repo.updateImportRules(tracked.source.id, ["missing/"]);

      expect(acceptPlanForTest(repo, plan.id)).toMatchObject({ merged: false, reason: "no_stls" });
      expect(repo.getAcceptedPlanRevisionInputSet(plan.id)).toEqual(accepted);
    });
  });

  it("rejects invalid stored naming before rebuilding parts", () => {
    withRepo((repo, reposDir) => {
      const tracked = createTrackedSource(repo, reposDir, "Invalid naming", "a", "solid a");
      const plan = repo.createProfile("Invalid naming plan", tracked.source.id);
      acceptPlanForTest(repo, plan.id);
      const partsBefore = repo.listParts(plan.id).parts;
      const accepted = repo.getAcceptedPlanRevisionInputSet(plan.id);
      repo.updateSource(tracked.source.id, {
        metadata: {
          naming: {
            use_defaults: false,
            override: { folder_rules: [{ path_contains: "mods", role_id: "other" }] },
          },
        },
      });

      expect(() => acceptPlanForTest(repo, plan.id)).toThrow(/override\.folder_rules/i);
      expect(repo.listParts(plan.id).parts).toEqual(partsBefore);
      expect(repo.getAcceptedPlanRevisionInputSet(plan.id)).toEqual(accepted);
    });
  });

  it("keeps malformed legacy layer assignments visible as stale", () => {
    withRepo((repo, reposDir, db) => {
      const tracked = createTrackedSource(repo, reposDir, "Malformed", "a", "solid a");
      const plan = repo.createProfile("Malformed plan", tracked.source.id);
      acceptPlanForTest(repo, plan.id);
      db.insert(schema.profileLayers)
        .values({
          tenantId: "default",
          profileId: plan.id,
          layerOrder: 1,
          layerType: "addon",
          projectId: tracked.source.id,
        })
        .run();

      expect(
        repo.listProfileHeaders().find((profile) => profile.id === plan.id)?.freshness,
      ).toMatchObject({
        status: "stale",
        reasons: expect.arrayContaining([{ kind: "plan_inputs_invalid" }]),
      });
      expect(() => acceptPlanForTest(repo, plan.id)).toThrow(
        "A Source can only be attached to a Plan once",
      );
    });
  });

  it("rejects base and replacement assignments that duplicate a Source", () => {
    withRepo((repo, reposDir) => {
      const base = createTrackedSource(repo, reposDir, "Base duplicate", "a", "solid a");
      const addon = createTrackedSource(repo, reposDir, "Addon duplicate", "b", "solid b");
      const plan = repo.createProfile("Duplicate guard", base.source.id);
      repo.addAddonLayer(plan.id, addon.source.id);
      const addonLayer = repo.getProfileLayers(plan.id).find((layer) => layer.layer_type === "addon");
      if (!addonLayer) throw new Error("test addon missing");

      expect(() => repo.setBaseLayer(plan.id, addon.source.id)).toThrow(/already attached/i);
      expect(() => repo.replaceLayer(addonLayer.id, base.source.id)).toThrow(/already attached/i);
    });
  });
});
