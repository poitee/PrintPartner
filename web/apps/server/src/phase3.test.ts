import { acceptPlanForTest, editAcceptedPartsForTest } from "./test/accept-plan.js";
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDb, SqliteDatabase } from "./db/client.js";
import { AppRepository } from "./db/repository.js";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createSelfHostPorts } from "./adapters/self-host/index.js";
import { buildStlTreePayload, progressSummary } from "@print-partner/domain";
import { exportStlPackJobMessage, STL_EXPORT_MISSING_HINT } from "./services/export-stl-pack.js";
import { acceptedPlanBasis } from "./db/accepted-plan-progress.js";
import { parseRequiredUnitToken } from "./services/required-units.js";

function applyTrackedPlan(repo: AppRepository, sourceId: number, profileId: number): void {
  const observed = repo.getProjectRow(sourceId);
  if (!observed) throw new Error("Source is missing");
  const revision = repo.recordSourceRevision({
    sourceId,
    upstreamRevisionKey: `phase3-${profileId}`,
    manifestDigest: "d".repeat(64),
    snapshotLocator: String(sourceId),
    syncedAt: "2026-08-21T12:00:00.000Z",
    completeness: "complete",
  });
  repo.activateSourceRevision({ sourceId, revisionId: revision.id, observed });
  const draft = repo.recomputePlanDraft({
    profileId,
    actor: "test:user",
    idempotencyKey: `phase3-draft-${profileId}`,
  });
  if (draft.kind !== "created") throw new Error("Plan draft was not created");
  const reconciled = repo.savePlanDraftRequiredUnitReconciliation({
    profileId,
    draftId: draft.draft.id,
    expectedSnapshotDigest: draft.draft.snapshotDigest,
    decisions: [],
    actorId: "test:user",
    idempotencyKey: `phase3-reconcile-${profileId}`,
  });
  if (reconciled.kind !== "saved") throw new Error("Plan reconciliation failed");
  const applied = repo.applyPlanChanges({
    profileId,
    draftId: draft.draft.id,
    expectedSnapshotDigest: reconciled.draft.snapshotDigest,
    expectedLifecycleVersion: 0,
    expectedBase: { kind: "empty", planVersion: 0 },
    actorId: "test:user",
    idempotencyKey: `phase3-apply-${profileId}`,
  });
  if (applied.kind !== "applied") throw new Error("Plan was not applied");
}

describe("Phase 3 APIs", () => {
  it("builds STL tree from repo folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-stl-"));
    mkdirSync(join(dir, "parts"), { recursive: true });
    writeFileSync(join(dir, "parts", "bracket.stl"), "solid");
    const payload = buildStlTreePayload(dir, JSON.stringify(["parts/"]));
    expect(payload.total).toBe(1);
    expect(payload.selected).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("checkoff and progress patch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-chk-"));
    const sqlite = new SqliteDatabase(dir);
    sqlite.connect();
    const repo = new AppRepository(getDb(sqlite), undefined, sqlite.reposDir);
    const source = repo.createSource({ name: "Repo", url: "https://github.com/a/b", source_kind: "github" });
    const repoPath = join(dir, "repos", String(source.id));
    mkdirSync(join(repoPath, "x"), { recursive: true });
    writeFileSync(join(repoPath, "x", "part.stl"), "x");
    repo.updateSource(source.id, { local_path: repoPath });
    repo.updateImportRules(source.id, ["x/"]);

    const plan = repo.createProfile("Plan", source.id);
    await acceptPlanForTest(repo, plan.id);

    const priorPartId = repo.listParts(plan.id).parts[0]!.id;
    editAcceptedPartsForTest(repo, plan.id, [{
      projectionPartId: priorPartId,
      quantityOverride: 1,
    }]);
    const accepted = repo.readAcceptedPlanOperationalSnapshot(plan.id);
    if (accepted.kind !== "ready") throw new Error("accepted Plan is not ready");
    const patched = repo.setAcceptedUnitCompletion({
      expected: acceptedPlanBasis(accepted.snapshot),
      token: parseRequiredUnitToken(accepted.snapshot.parts[0]!.units[0]!.token),
      completed: true,
    });
    expect(patched).toMatchObject({ kind: "updated", body: { printed_count: 1, missing: false } });
    expect(progressSummary([{ quantity_effective: 1, printed_count: 1 }])).toContain("1/");

    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("assembled field: defaults false, round-trips via repo and HTTP API", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-asm-"));
    const sqlite = new SqliteDatabase(dir);
    sqlite.connect();
    const repo = new AppRepository(getDb(sqlite), undefined, sqlite.reposDir);
    const source = repo.createSource({ name: "Repo", url: "https://github.com/a/b", source_kind: "github" });
    const repoPath = join(dir, "repos", String(source.id));
    mkdirSync(join(repoPath, "x"), { recursive: true });
    writeFileSync(join(repoPath, "x", "part.stl"), "x");
    repo.updateSource(source.id, { local_path: repoPath });
    repo.updateImportRules(source.id, ["x/"]);

    const plan = repo.createProfile("Plan", source.id);
    await acceptPlanForTest(repo, plan.id);

    const priorPartId = repo.listParts(plan.id).parts[0]!.id;
    const partId = editAcceptedPartsForTest(repo, plan.id, [{
      projectionPartId: priorPartId,
      quantityOverride: 1,
    }]).get(priorPartId)!;
    const accepted = repo.readAcceptedPlanOperationalSnapshot(plan.id);
    if (accepted.kind !== "ready") throw new Error("accepted Plan is not ready");
    const expected = acceptedPlanBasis(accepted.snapshot);
    const token = parseRequiredUnitToken(accepted.snapshot.parts[0]!.units[0]!.token);
    expect(repo.setAcceptedUnitCompletion({ expected, token, completed: false })).toMatchObject({
      kind: "updated",
      body: { assembled_units: [false] },
    });
    repo.setAcceptedUnitCompletion({ expected, token, completed: true });
    expect(repo.setAcceptedUnitAssembly({ expected, token, assembled: true })).toMatchObject({
      kind: "updated",
      body: { assembled_count: 1, assembled_units: [true] },
    });
    expect(repo.setAcceptedUnitAssembly({ expected, token, assembled: false })).toMatchObject({
      kind: "updated",
      body: { assembled_units: [false] },
    });
    const config = loadConfig();
    const ports = createSelfHostPorts(dir);
    await ports.db.connect();
    const app = await buildApp(config, ports);

    const progressRes = await app.inject({
      method: "PATCH",
      url: `/parts/${partId}/progress`,
      payload: { unit_index: 0, completed: true },
    });
    expect(progressRes.statusCode).toBe(200);
    expect(progressRes.json()).toMatchObject({ printed_count: 1, missing: false });

    const patchRes = await app.inject({
      method: "PATCH",
      url: `/parts/${partId}/assembled`,
      payload: { unit_index: 0, assembled: true },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json()).toMatchObject({ part_id: partId, assembled_count: 1, assembled_units: [true] });

    const missingFieldRes = await app.inject({
      method: "PATCH",
      url: `/parts/${partId}/assembled`,
      payload: { unit_index: 0 },
    });
    expect(missingFieldRes.statusCode).toBe(400);

    // Read accessor mirrors the write.
    const getRes = await app.inject({ method: "GET", url: `/parts/${partId}/assembled` });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json()).toMatchObject({ part_id: partId, assembled_count: 1, assembled_units: [true] });

    // Un-printing a unit clears its assembled flag, so re-checking the print
    // does not silently resurrect a stale "installed" state.
    await app.inject({
      method: "PATCH",
      url: `/parts/${partId}/progress`,
      payload: { unit_index: 0, completed: false },
    });
    await app.inject({
      method: "PATCH",
      url: `/parts/${partId}/progress`,
      payload: { unit_index: 0, completed: true },
    });
    const afterReprint = await app.inject({ method: "GET", url: `/parts/${partId}/assembled` });
    expect(afterReprint.json()).toMatchObject({ assembled_count: 0, assembled_units: [false] });

    // The progress PATCH response itself carries the post-toggle assembled
    // state, so the checkoff UI can clear the Assembled toggle in the same
    // round trip instead of showing a stale "installed" pip until a refetch.
    await app.inject({
      method: "PATCH",
      url: `/parts/${partId}/assembled`,
      payload: { unit_index: 0, assembled: true },
    });
    const unprintRes = await app.inject({
      method: "PATCH",
      url: `/parts/${partId}/progress`,
      payload: { unit_index: 0, completed: false },
    });
    expect(unprintRes.statusCode).toBe(200);
    expect(unprintRes.json()).toMatchObject({
      printed_count: 0,
      assembled_units: [false],
    });

    // An unknown part is a 404 on the read path.
    const missingPart = await app.inject({ method: "GET", url: `/parts/99999/assembled` });
    expect(missingPart.statusCode).toBe(404);

    await app.close();
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("export STL pack job via HTTP", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-exp-"));
    process.env.PRINT_PARTNER_DATA_DIR = dir;
    const config = loadConfig();
    const ports = createSelfHostPorts(dir);
    await ports.db.connect();
    const repo = ports.repository;
    const source = repo.createSource({ name: "R", url: "https://github.com/a/b" });
    const repoPath = join(dir, "repos", String(source.id));
    mkdirSync(join(repoPath, "p"), { recursive: true });
    writeFileSync(join(repoPath, "p", "a.stl"), "stl");
    repo.updateSource(source.id, { local_path: repoPath });
    repo.updateImportRules(source.id, ["p/"]);
    const plan = repo.createProfile("ExportPlan", source.id);
    applyTrackedPlan(repo, source.id, plan.id);

    const app = await buildApp(config, ports);
    const res = await app.inject({
      method: "POST",
      url: "/jobs/export-stl-pack",
      payload: { profile_id: plan.id },
    });
    expect(res.statusCode).toBe(200);
    const { job_id } = res.json() as { job_id: string };
    await new Promise((r) => setTimeout(r, 300));
    const jobRes = await app.inject({ method: "GET", url: `/jobs/${job_id}` });
    const job = jobRes.json() as { status: string; result?: { root_path?: string } };
    expect(job.status).toBe("done");
    expect(job.result?.root_path).toBeTruthy();

    await app.close();
    await ports.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("export remaining on fresh composed plan succeeds (missing_only)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-exp-remaining-"));
    process.env.PRINT_PARTNER_DATA_DIR = dir;
    const config = loadConfig();
    const ports = createSelfHostPorts(dir);
    await ports.db.connect();
    const repo = ports.repository;
    const source = repo.createSource({ name: "R", url: "https://github.com/a/b" });
    const repoPath = join(dir, "repos", String(source.id));
    mkdirSync(join(repoPath, "p"), { recursive: true });
    writeFileSync(join(repoPath, "p", "a.stl"), "stl");
    repo.updateSource(source.id, { local_path: repoPath });
    repo.updateImportRules(source.id, ["p/"]);
    const plan = repo.createProfile("RemainingFresh", source.id);
    applyTrackedPlan(repo, source.id, plan.id);

    const app = await buildApp(config, ports);
    const res = await app.inject({
      method: "POST",
      url: "/jobs/export-stl-pack",
      payload: { profile_id: plan.id, missing_only: true },
    });
    expect(res.statusCode).toBe(200);
    const { job_id } = res.json() as { job_id: string };
    await new Promise((r) => setTimeout(r, 300));
    const jobRes = await app.inject({ method: "GET", url: `/jobs/${job_id}` });
    const job = jobRes.json() as {
      status: string;
      result?: { file_total?: number; warnings?: string[] };
    };
    expect(job.status).toBe("done");
    expect(job.result?.file_total ?? 0).toBeGreaterThan(0);
    expect((job.result?.warnings ?? []).some((w) => /already marked printed/i.test(w))).toBe(false);

    await app.close();
    await ports.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("export remaining still packs when review has a missing-STL blocker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-exp-blocker-"));
    process.env.PRINT_PARTNER_DATA_DIR = dir;
    const config = loadConfig();
    const ports = createSelfHostPorts(dir);
    await ports.db.connect();
    const repo = ports.repository;
    const source = repo.createSource({ name: "R", url: "https://github.com/a/b" });
    const repoPath = join(dir, "repos", String(source.id));
    mkdirSync(join(repoPath, "p"), { recursive: true });
    writeFileSync(join(repoPath, "p", "good.stl"), "stl");
    writeFileSync(join(repoPath, "p", "gone.stl"), "stl");
    repo.updateSource(source.id, { local_path: repoPath });
    repo.updateImportRules(source.id, ["p/"]);
    const plan = repo.createProfile("BlockerFresh", source.id);
    applyTrackedPlan(repo, source.id, plan.id);
    rmSync(join(repoPath, "p", "gone.stl"));

    const app = await buildApp(config, ports);
    const res = await app.inject({
      method: "POST",
      url: "/jobs/export-stl-pack",
      payload: { profile_id: plan.id, missing_only: true },
    });
    expect(res.statusCode).toBe(200);
    const { job_id } = res.json() as { job_id: string };
    await new Promise((r) => setTimeout(r, 300));
    const jobRes = await app.inject({ method: "GET", url: `/jobs/${job_id}` });
    const job = jobRes.json() as { status: string; result?: { file_total?: number } };
    expect(job.status).toBe("done");
    expect(job.result?.file_total ?? 0).toBeGreaterThan(0);

    await app.close();
    await ports.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("export STL pack job via HTTP with group_by color", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-exp-color-"));
    process.env.PRINT_PARTNER_DATA_DIR = dir;
    const config = loadConfig();
    const ports = createSelfHostPorts(dir);
    await ports.db.connect();
    const repo = ports.repository;
    const source = repo.createSource({ name: "R", url: "https://github.com/a/b" });
    const repoPath = join(dir, "repos", String(source.id));
    mkdirSync(join(repoPath, "alpha"), { recursive: true });
    mkdirSync(join(repoPath, "beta"), { recursive: true });
    writeFileSync(join(repoPath, "alpha", "part.stl"), "stl");
    writeFileSync(join(repoPath, "beta", "part.stl"), "stl");
    repo.updateSource(source.id, { local_path: repoPath });
    repo.updateImportRules(source.id, ["alpha/", "beta/"]);
    const plan = repo.createProfile("ExportFlat", source.id);
    applyTrackedPlan(repo, source.id, plan.id);

    const app = await buildApp(config, ports);
    const res = await app.inject({
      method: "POST",
      url: "/jobs/export-stl-pack",
      payload: { profile_id: plan.id, group_by: "color" },
    });
    expect(res.statusCode).toBe(200);
    const { job_id } = res.json() as { job_id: string };
    await new Promise((r) => setTimeout(r, 300));
    const jobRes = await app.inject({ method: "GET", url: `/jobs/${job_id}` });
    const job = jobRes.json() as {
      status: string;
      result?: { root_path?: string };
    };
    expect(job.status).toBe("done");
    const rootPath = job.result?.root_path;
    expect(rootPath).toBeTruthy();
    const roleDir = join(rootPath!, "primary");
    expect(existsSync(roleDir)).toBe(true);
    expect(existsSync(join(roleDir, "alpha"))).toBe(false);
    expect(existsSync(join(roleDir, "beta"))).toBe(false);
    const files = readdirSync(roleDir);
    expect(files.some((f) => f.endsWith(".stl"))).toBe(true);

    await app.close();
    await ports.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("exportStlPackJobMessage surfaces warnings-only completion", () => {
    expect(
      exportStlPackJobMessage({
        file_total: 2,
        warnings: ["Missing STL: a.stl (base:R). Sync Sources and fix Review blockers, then export again."],
      }),
    ).toBe("Exported 2 file(s) with 1 warning(s)");
    expect(exportStlPackJobMessage({ file_total: 0, warnings: [] })).toContain(
      STL_EXPORT_MISSING_HINT,
    );
  });
});
