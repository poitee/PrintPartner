import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { buildApp } from "../app.js";
import { createSelfHostPorts } from "../adapters/self-host/index.js";
import { loadConfig } from "../config.js";
import { AppRepository, type SchemaTables } from "../db/repository.js";
import * as pgSchema from "../db/schema-pg.js";
import { registerPostgresSyncQuery, unregisterPostgresSyncQuery } from "../db/sync-db-bridge.js";
import { registerPlanDraftRoutes } from "./plan-drafts.js";
import { acceptPlanForTest } from "../test/accept-plan.js";
import { acceptedPlanBasis } from "../db/accepted-plan-progress.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pp-plan-draft-routes-"));
  const previousDataDir = process.env.PRINT_PARTNER_DATA_DIR;
  process.env.PRINT_PARTNER_DATA_DIR = root;
  const ports = createSelfHostPorts(root);
  await ports.db.connect();
  const repo = ports.repository;
  const source = repo.createSource({ name: "Draft source", url: "https://example.test/draft" });
  const sourceRoot = join(root, "repos", String(source.id));
  mkdirSync(sourceRoot, { recursive: true });
  writeFileSync(join(sourceRoot, "bracket.stl"), "solid bracket\nendsolid bracket\n");
  repo.updateSource(source.id, { local_path: sourceRoot });
  const profile = repo.createProfile("Draft Build", source.id);
  const before = repo.readAcceptedProfileSummary(profile.id);
  const app = await buildApp(loadConfig(), ports);
  cleanups.push(async () => {
    await app.close();
    await ports.db.close();
    if (previousDataDir === undefined) delete process.env.PRINT_PARTNER_DATA_DIR;
    else process.env.PRINT_PARTNER_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  });
  return { app, repo, profile, before, sourceRoot };
}

describe("Plan draft routes", () => {
  it("mounts recompute flat and in v2 without changing accepted state", async () => {
    const { app, repo, profile, before, sourceRoot } = await fixture();
    writeFileSync(
      join(sourceRoot, "print-partner.manifest.yaml"),
      "format: print-partner-manifest-v2\nversion: 2\nparts:\n  - match: bracket.stl\n    requirement: required\n",
    );
    const response = await app.inject({
      method: "POST",
      url: `/plans/${profile.id}/drafts/recompute`,
      headers: { "idempotency-key": "route-recompute" },
      payload: { apply_manifest: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      profile_id: profile.id,
      draft: { state: "open", base: { revision_id: null, plan_version: 0 } },
      reconciliation: { kind: "ready" },
    });
    expect(repo.readAcceptedProfileSummary(profile.id)).toEqual(before);
    expect(repo.listParts(profile.id, 10_000, 0).parts).toEqual([]);
    expect(
      repo.getPlanDraft(profile.id, response.json().draft.draft_id)?.parts[0]?.requirement,
    ).toBe("required");

    const v2 = await app.inject({
      method: "GET",
      url: `/api/v2/plans/${profile.id}/drafts/${response.json().draft.draft_id}`,
    });
    const v1 = await app.inject({
      method: "GET",
      url: `/api/v1/plans/${profile.id}/drafts/${response.json().draft.draft_id}`,
    });
    expect(v2.statusCode).toBe(200);
    expect(v2.json()).toEqual(response.json());
    expect(v1.statusCode).toBe(404);
  });

  it("applies mixed spreadsheet decisions as one saved-draft edit", async () => {
    const { app, repo, profile, before } = await fixture();
    const created = (await app.inject({
      method: "POST",
      url: `/plans/${profile.id}/drafts/recompute`,
      headers: { "idempotency-key": "spreadsheet-draft" },
      payload: { apply_manifest: true },
    })).json();
    const target = created.parts[0];
    const duplicate = await app.inject({
      method: "PATCH",
      url: `/plans/${profile.id}/drafts/${created.draft.draft_id}/parts`,
      payload: {
        expected_snapshot_digest: created.draft.snapshot_digest,
        decisions: [
          { kind: "set_included", draft_part_ids: [target.draft_part_id], value: true },
          { kind: "set_included", draft_part_ids: [target.draft_part_id], value: false },
        ],
      },
    });
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.json()).toEqual({ detail: "Request is invalid", code: "invalid_request" });

    const edited = await app.inject({
      method: "PATCH",
      url: `/plans/${profile.id}/drafts/${created.draft.draft_id}/parts`,
      payload: {
        expected_snapshot_digest: created.draft.snapshot_digest,
        decisions: [
          {
            kind: "set_quantity_override",
            draft_part_ids: [target.draft_part_id],
            value: 3,
          },
          {
            kind: "set_included",
            draft_part_ids: [target.draft_part_id],
            value: false,
          },
        ],
      },
    });

    expect(edited.statusCode).toBe(200);
    expect(edited.json().parts[0]).toMatchObject({ quantity_effective: 3, included: false });
    expect(repo.readAcceptedProfileSummary(profile.id)).toEqual(before);
    expect(repo.listParts(profile.id, 10_000, 0).parts).toEqual([]);
  });

  it("abandons and rebases a stale saved draft without changing accepted state", async () => {
    const { app, repo, profile } = await fixture();
    acceptPlanForTest(repo, profile.id);
    const source = await app.inject({
      method: "POST",
      url: `/plans/${profile.id}/drafts/recompute`,
      headers: { "idempotency-key": "stale-source" },
      payload: { apply_manifest: true },
    });
    const stale = source.json();
    acceptPlanForTest(repo, profile.id);
    const acceptedBefore = repo.getAcceptedPlanRevision(profile.id);

    const abandoned = await app.inject({
      method: "POST",
      url: `/plans/${profile.id}/drafts/${stale.draft.draft_id}/abandon`,
      payload: { expected_lifecycle_version: stale.draft.lifecycle_version },
    });
    expect(abandoned.statusCode).toBe(200);
    expect(abandoned.json()).toMatchObject({ state: "abandoned", lifecycle_version: 1 });

    const rebased = await app.inject({
      method: "POST",
      url: `/plans/${profile.id}/drafts/${stale.draft.draft_id}/rebase`,
      headers: { "idempotency-key": "stale-rebase" },
      payload: {
        expected_source_lifecycle_version: abandoned.json().lifecycle_version,
        expected_source_snapshot_digest: abandoned.json().snapshot_digest,
      },
    });
    expect(rebased.statusCode).toBe(200);
    expect(rebased.json()).toMatchObject({
      profile_id: profile.id,
      draft: { state: "open", base: { revision_id: acceptedBefore!.id } },
      diff: { base_is_current: true },
    });
    expect(repo.getAcceptedPlanRevision(profile.id)).toEqual(acceptedBefore);
  });

  it("imports printed counts atomically and rejects stale accepted bases", async () => {
    const { app, repo, profile } = await fixture();
    acceptPlanForTest(repo, profile.id);
    const accepted = repo.readAcceptedPlanOperationalSnapshot(profile.id);
    if (accepted.kind !== "ready") throw new Error("accepted fixture is unavailable");
    const basis = acceptedPlanBasis(accepted.snapshot);
    const part = accepted.snapshot.parts[0]!;
    const request = {
      expected: {
        profile_id: basis.profileId,
        plan_version: basis.planVersion,
        plan_revision_id: basis.revisionId,
        plan_revision_digest: basis.revisionDigest,
        required_unit_mapping_digest: basis.requiredUnitMappingDigest,
      },
      rows: [{ part_id: part.projectionPartId, printed_count: 1 }],
    };
    const before = repo.readAcceptedPlanOperationalSnapshot(profile.id);
    const stale = await app.inject({
      method: "POST",
      url: `/plans/${profile.id}/progress/import`,
      payload: { ...request, expected: { ...request.expected, plan_version: basis.planVersion + 1 } },
    });
    expect(stale.statusCode).toBe(409);
    expect(repo.readAcceptedPlanOperationalSnapshot(profile.id)).toEqual(before);
    const duplicate = await app.inject({
      method: "POST",
      url: `/plans/${profile.id}/progress/import`,
      payload: { ...request, rows: [request.rows[0], request.rows[0]] },
    });
    expect(duplicate.statusCode).toBe(400);
    expect(repo.readAcceptedPlanOperationalSnapshot(profile.id)).toEqual(before);
    const applied = await app.inject({
      method: "POST",
      url: `/api/v2/plans/${profile.id}/progress/import`,
      payload: request,
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toEqual({ updated_parts: 1 });
  });

  it("keeps accepted Review and Checkoff unchanged until explicit Apply", async () => {
    const { app, repo, profile } = await fixture();
    const create = async (key: string) => app.inject({
      method: "POST",
      url: `/plans/${profile.id}/drafts/recompute`,
      headers: { "idempotency-key": key },
      payload: { apply_manifest: true },
    });
    const firstResponse = await create("initial-draft");
    const first = firstResponse.json();
    const firstApply = await app.inject({
      method: "POST",
      url: `/plans/${profile.id}/drafts/${first.draft.draft_id}/apply`,
      headers: { "idempotency-key": "initial-apply" },
      payload: {
        expected_snapshot_digest: first.draft.snapshot_digest,
        expected_lifecycle_version: first.draft.lifecycle_version,
        expected_base: first.draft.base,
      },
    });
    expect(firstApply.statusCode).toBe(200);
    expect(firstApply.json()).toMatchObject({
      revision_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
      required_unit_mapping_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const acceptedPart = repo.getAcceptedPlanRevision(profile.id)?.parts[0];
    if (!acceptedPart) throw new Error("accepted route fixture Part is missing");
    const directPlanningWrite = await app.inject({
      method: "PATCH",
      url: `/parts/${acceptedPart.projectionPartId}`,
      payload: { included: false, quantity_override: 9 },
    });
    expect(directPlanningWrite.statusCode).toBe(400);
    expect(repo.getAcceptedPlanRevision(profile.id)?.parts[0]).toMatchObject({
      included: true,
      quantityEffective: 1,
    });

    const beforePointer = repo.getAcceptedPlanRevision(profile.id);
    const beforeReview = (await app.inject({
      method: "GET",
      url: `/plans/${profile.id}/review`,
    })).json();
    const beforeCheckoff = await app.inject({ method: "GET", url: `/plans/${profile.id}/checkoff` });
    const secondResponse = await create("quantity-draft");
    const second = secondResponse.json();
    const target = second.parts[0];
    const editedResponse = await app.inject({
      method: "PATCH",
      url: `/plans/${profile.id}/drafts/${second.draft.draft_id}/parts`,
      payload: {
        expected_snapshot_digest: second.draft.snapshot_digest,
        decision: {
          kind: "set_quantity_override",
          draft_part_ids: [target.draft_part_id],
          value: 2,
        },
      },
    });
    expect(editedResponse.statusCode).toBe(200);
    const edited = editedResponse.json();
    expect(edited.parts[0]).toMatchObject({ quantity_effective: 2 });
    expect(edited.diff.changed[0]).toMatchObject({ fields: expect.arrayContaining(["quantityOverride"]) });
    expect(edited.reconciliation).toMatchObject({ kind: "unresolved" });
    expect(repo.getAcceptedPlanRevision(profile.id)).toEqual(beforePointer);
    expect((await app.inject({ method: "GET", url: `/plans/${profile.id}/checkoff` })).json()).toEqual(beforeCheckoff.json());

    const stale = await app.inject({
      method: "PATCH",
      url: `/plans/${profile.id}/drafts/${second.draft.draft_id}/parts`,
      payload: {
        expected_snapshot_digest: second.draft.snapshot_digest,
        decision: {
          kind: "set_included",
          draft_part_ids: [target.draft_part_id],
          value: false,
        },
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "draft_changed", workspace: { draft: { snapshot_digest: edited.draft.snapshot_digest } } });

    const conflict = edited.reconciliation.conflicts[0];
    const reconciledResponse = await app.inject({
      method: "PUT",
      url: `/plans/${profile.id}/drafts/${edited.draft.draft_id}/reconciliation`,
      headers: { "idempotency-key": "quantity-reconcile" },
      payload: {
        expected_snapshot_digest: edited.draft.snapshot_digest,
        decisions: [{
          kind: "accept_prior_completion",
          target_draft_part_id: conflict.target_draft_part_id,
          predecessor_revision_part_id: conflict.predecessor_revision_part_id,
        }],
      },
    });
    expect(reconciledResponse.statusCode).toBe(200);
    const reconciled = reconciledResponse.json();
    expect(reconciled.reconciliation).toMatchObject({ kind: "ready" });

    const applied = await app.inject({
      method: "POST",
      url: `/plans/${profile.id}/drafts/${reconciled.draft.draft_id}/apply`,
      headers: { "idempotency-key": "quantity-apply" },
      payload: {
        expected_snapshot_digest: reconciled.draft.snapshot_digest,
        expected_lifecycle_version: reconciled.draft.lifecycle_version,
        expected_base: reconciled.draft.base,
      },
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toMatchObject({
      plan_version: beforePointer!.planVersion + 1,
      revision_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
      required_unit_mapping_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(repo.getAcceptedPlanRevision(profile.id)?.parts[0]).toMatchObject({ quantityEffective: 2 });
    const afterReview = (await app.inject({
      method: "GET",
      url: `/plans/${profile.id}/review`,
    })).json();
    expect(afterReview.accepted_basis).not.toEqual(beforeReview.accepted_basis);
    const currentPartId = afterReview.part_groups[0].parts[0].id;
    const oldBasis = await app.inject({
      method: "POST",
      url: `/plans/${profile.id}/progress/import`,
      payload: {
        expected: beforeReview.accepted_basis,
        rows: [{ part_id: currentPartId, printed_count: 1 }],
      },
    });
    expect(oldBasis.statusCode).toBe(409);
    const newBasis = await app.inject({
      method: "POST",
      url: `/plans/${profile.id}/progress/import`,
      payload: {
        expected: afterReview.accepted_basis,
        rows: [{ part_id: currentPartId, printed_count: 1 }],
      },
    });
    expect(newBasis.statusCode).toBe(200);
  });

  it("fails every PostgreSQL mutation before issuing a query", async () => {
    const postgres = drizzle({} as Pool, { schema: pgSchema });
    const statements: string[] = [];
    registerPostgresSyncQuery(postgres, ({ sql }) => {
      statements.push(sql);
      return { rows: [], rowCount: 0 };
    });
    const repo = new AppRepository(
      postgres,
      "default",
      "/tmp/unused-plan-draft-routes",
      pgSchema as unknown as SchemaTables,
    );
    const app = Fastify();
    await registerPlanDraftRoutes(app, { repo });
    await app.ready();
    const digest = "a".repeat(64);
    try {
      for (const request of [
        {
          method: "POST" as const,
          url: "/plans/1/drafts/recompute",
          headers: { "idempotency-key": "pg-recompute" },
          payload: { apply_manifest: true },
        },
        {
          method: "PATCH" as const,
          url: "/plans/1/drafts/1/parts",
          payload: {
            expected_snapshot_digest: digest,
            decision: { kind: "set_included", draft_part_ids: [1], value: false },
          },
        },
        {
          method: "PUT" as const,
          url: "/plans/1/drafts/1/reconciliation",
          headers: { "idempotency-key": "pg-reconcile" },
          payload: { expected_snapshot_digest: digest, decisions: [] },
        },
        {
          method: "POST" as const,
          url: "/plans/1/drafts/1/apply",
          headers: { "idempotency-key": "pg-apply" },
          payload: {
            expected_snapshot_digest: digest,
            expected_lifecycle_version: 0,
            expected_base: { revision_id: null, plan_version: 0 },
          },
        },
        {
          method: "POST" as const,
          url: "/plans/1/drafts/1/abandon",
          payload: { expected_lifecycle_version: 0 },
        },
        {
          method: "POST" as const,
          url: "/plans/1/drafts/1/rebase",
          headers: { "idempotency-key": "pg-rebase" },
          payload: {
            expected_source_lifecycle_version: 1,
            expected_source_snapshot_digest: digest,
          },
        },
        {
          method: "POST" as const,
          url: "/plans/1/progress/import",
          payload: {
            expected: {
              profile_id: 1,
              plan_version: 1,
              plan_revision_id: 1,
              plan_revision_digest: digest,
              required_unit_mapping_digest: digest,
            },
            rows: [{ part_id: 1, printed_count: 1 }],
          },
        },
      ]) {
        const response = await app.inject(request);
        expect(response.statusCode, `${request.method} ${request.url}`).toBe(503);
        expect(response.json()).toEqual({
          detail: "Plan draft update is unavailable",
          code: "transaction_unavailable",
        });
      }
      expect(statements).toEqual([]);
    } finally {
      await app.close();
      unregisterPostgresSyncQuery(postgres);
    }
  });
});
