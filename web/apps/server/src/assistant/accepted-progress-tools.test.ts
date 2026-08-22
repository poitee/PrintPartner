import { acceptPlanForTest, editAcceptedPartsForTest } from "../test/accept-plan.js";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { createSelfHostPorts } from "../adapters/self-host/index.js";
import { AcceptedPlanOperationalIntegrityError } from "../db/accepted-plan-operational.js";
import { applyAssistantAction, invokeAssistantTool } from "./tools.js";
import { InProcessJobRunner } from "../routes/jobs.js";
import { parseRequiredUnitToken } from "../services/required-units.js";
import { registerAssistantRoutes } from "../routes/assistant.js";
import { loadConfig } from "../config.js";
import type { AssistantProposedAction } from "@print-partner/contracts";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { AppRepository, type SchemaTables } from "../db/repository.js";
import * as pgSchema from "../db/schema-pg.js";
import {
  registerPostgresSyncQuery,
  unregisterPostgresSyncQuery,
} from "../db/sync-db-bridge.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(planCount = 1) {
  const root = mkdtempSync(join(tmpdir(), "pp-assistant-progress-"));
  roots.push(root);
  const ports = createSelfHostPorts(root);
  await ports.db.connect();
  const repo = ports.repository;
  const source = repo.createSource({ name: "Repo", url: "https://github.com/a/b" });
  const sourceRoot = join(root, "repos", String(source.id));
  mkdirSync(join(sourceRoot, "parts"), { recursive: true });
  writeFileSync(join(sourceRoot, "parts", "widget.stl"), "solid widget");
  repo.updateSource(source.id, { local_path: sourceRoot });
  repo.updateImportRules(source.id, ["parts/"]);
  const profiles = Array.from({ length: planCount }, (_, index) => {
    const profile = repo.createProfile(`Assistant Progress ${index + 1}`, source.id);
    acceptPlanForTest(repo, profile.id);
    const part = repo.listParts(profile.id).parts[0]!;
    const remapped = editAcceptedPartsForTest(repo, profile.id, [{
      projectionPartId: part.id,
      quantityOverride: 1,
    }]);
    const acceptedPart = repo.getPartRow(remapped.get(part.id)!);
    if (!acceptedPart) throw new Error("test accepted Part is missing");
    return { profile, part: acceptedPart };
  });
  return { root, repo, profile: profiles[0]!.profile, part: profiles[0]!.part, profiles };
}

describe("assistant accepted Progress tools", () => {
  it("returns 503 before any PostgreSQL query when applying archive", async () => {
    const postgres = drizzle({} as Pool, { schema: pgSchema });
    const statements: string[] = [];
    registerPostgresSyncQuery(postgres, ({ sql: query }) => {
      statements.push(query);
      return { rows: [], rowCount: 0 };
    });
    const repo = new AppRepository(
      postgres,
      "default",
      "/tmp/unused-assistant-progress",
      pgSchema as unknown as SchemaTables,
    );
    const jobs = new InProcessJobRunner({
      getRepo: () => repo,
      reposDir: "/tmp/unused-assistant-progress/repos",
      exportsDir: "/tmp/unused-assistant-progress/exports",
      dataDir: "/tmp/unused-assistant-progress",
    });
    const action = {
      id: "postgres-archive",
      type: "archive_plan",
      plan_id: 1,
      label: "Archive",
      summary: "Archive",
      params: {
        accepted_basis: {
          profileId: 1,
          planVersion: 1,
          revisionId: 1,
          revisionDigest: "a".repeat(64),
          requiredUnitMappingDigest: "b".repeat(64),
        },
      },
    } satisfies AssistantProposedAction;
    const app = Fastify();
    await app.register(rateLimit, { global: false });
    app.decorateRequest("tenantId", "");
    app.addHook("onRequest", async (request: { tenantId: string }) => {
      request.tenantId = "default";
    });
    await registerAssistantRoutes(app, { repo, config: loadConfig(), jobs });
    await app.ready();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/assistant/actions/apply",
        payload: { action },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ detail: "Accepted Plan update is unavailable" });
      expect(statements).toEqual([]);
    } finally {
      await app.close();
      unregisterPostgresSyncQuery(postgres);
    }
  });

  it("preserves actionable validation details for non-archive Apply", async () => {
    const { root, repo, profile } = await fixture();
    const jobs = new InProcessJobRunner({
      getRepo: () => repo,
      reposDir: join(root, "repos"),
      exportsDir: join(root, "exports"),
      dataDir: root,
    });
    const app = Fastify();
    await app.register(rateLimit, { global: false });
    app.decorateRequest("tenantId", "");
    app.addHook("onRequest", async (request: { tenantId: string }) => {
      request.tenantId = "default";
    });
    await registerAssistantRoutes(app, { repo, config: loadConfig(), jobs });
    await app.ready();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/assistant/actions/apply",
        payload: {
          action: {
            id: "invalid-stack-preset",
            type: "apply_stack_preset",
            plan_id: profile.id,
            label: "Apply stack preset",
            summary: "Apply stack preset",
            params: { preset_id: "not-a-real-stack-preset" },
          } satisfies AssistantProposedAction,
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        status: 400,
        title: "Bad Request",
        detail: "Unknown stack preset: not-a-real-stack-preset",
      });
    } finally {
      await app.close();
    }
  });

  it("reads remaining from accepted state and archives with the proposed basis", async () => {
    const { root, repo, profile, part } = await fixture();
    const initial = await invokeAssistantTool("get_remaining", { plan_id: profile.id }, { repo });
    expect(JSON.parse(initial.content)).toEqual({
      plan_id: profile.id,
      plan_name: "Assistant Progress 1",
      archived_at: null,
      summary: "0/1 parts fully printed · 0/1 units",
      printed_units: 0,
      total_units: 1,
      remaining_units: 1,
      percent: 0,
      can_archive: false,
      part_count: 1,
    });
    const blocked = await invokeAssistantTool("archive_plan", { plan_id: profile.id }, { repo });
    expect(JSON.parse(blocked.content)).toMatchObject({
      error: "Archive only when print remaining is 0",
      remaining_units: 1,
      total_units: 1,
    });

    const accepted = repo.readAcceptedPlanOperationalSnapshot(profile.id);
    if (accepted.kind !== "ready") throw new Error("accepted Plan is not ready");
    expect(
      repo.setAcceptedUnitCompletion({
        expected: {
          profileId: profile.id,
          planVersion: accepted.snapshot.planVersion,
          revisionId: accepted.snapshot.revisionId,
          revisionDigest: accepted.snapshot.revisionDigest,
          requiredUnitMappingDigest: accepted.snapshot.requiredUnitMappingDigest,
        },
        token: parseRequiredUnitToken(accepted.snapshot.parts[0]!.units[0]!.token),
        completed: true,
      }).kind,
    ).toBe("updated");

    const proposed = await invokeAssistantTool("archive_plan", { plan_id: profile.id }, { repo });
    expect(proposed.proposedAction?.params.accepted_basis).toEqual({
      profileId: profile.id,
      planVersion: accepted.snapshot.planVersion,
      revisionId: accepted.snapshot.revisionId,
      revisionDigest: accepted.snapshot.revisionDigest,
      requiredUnitMappingDigest: accepted.snapshot.requiredUnitMappingDigest,
    });
    if (!proposed.proposedAction) throw new Error("archive proposal is missing");
    const jobs = new InProcessJobRunner({
      getRepo: () => repo,
      reposDir: join(root, "repos"),
      exportsDir: join(root, "exports"),
      dataDir: root,
    });
    const applied = await applyAssistantAction(proposed.proposedAction, { repo, jobs });
    expect(applied).toMatchObject({
      ok: true,
      result: {
        plan_id: profile.id,
        name: "Assistant Progress 1",
        archived_at: expect.any(String),
      },
    });
    expect(repo.getProfileHeader(profile.id)?.archived_at).toEqual(expect.any(String));
    expect(repo.getPartRow(part.id)).not.toBeNull();
  });

  it("does not read compatibility ProfileSummary for accepted Progress tools", async () => {
    const { repo, profile } = await fixture();
    const remaining = await invokeAssistantTool(
      "get_remaining",
      { plan_id: profile.id },
      { repo },
    );
    expect(JSON.parse(remaining.content)).toMatchObject({
      plan_id: profile.id,
      plan_name: "Assistant Progress 1",
      remaining_units: 1,
    });
    expect(remaining.content).not.toContain("private compatibility Progress sentinel");
    const archive = await invokeAssistantTool("archive_plan", { plan_id: profile.id }, { repo });
    expect(JSON.parse(archive.content)).toMatchObject({
      error: "Archive only when print remaining is 0",
      remaining_units: 1,
    });
    expect(archive.content).not.toContain("private compatibility Progress sentinel");
  });

  it("uses ready snapshot identity and redacts identity lookup failures", async () => {
    const { repo, profile } = await fixture();
    const readIdentity = repo.getOwnedProfileIdentity.bind(repo);
    repo.getOwnedProfileIdentity = (profileId) => {
      const identity = readIdentity(profileId);
      return identity ? { ...identity, name: "identity-only sentinel" } : null;
    };
    const ready = await invokeAssistantTool("get_remaining", { plan_id: profile.id }, { repo });
    expect(JSON.parse(ready.content)).toMatchObject({ plan_name: "Assistant Progress 1" });
    expect(ready.content).not.toContain("identity-only sentinel");

    repo.getOwnedProfileIdentity = () => {
      throw new Error("private identity lookup sentinel");
    };
    const failed = await invokeAssistantTool("get_remaining", { plan_id: profile.id }, { repo });
    expect(JSON.parse(failed.content)).toEqual({ error: "Internal Server Error" });
    expect(failed.content).not.toContain("private identity lookup sentinel");
  });

  it("rejects noncanonical accepted basis values at the assistant boundary", async () => {
    const { root, repo, profile } = await fixture();
    const jobs = new InProcessJobRunner({
      getRepo: () => repo,
      reposDir: join(root, "repos"),
      exportsDir: join(root, "exports"),
      dataDir: root,
    });
    const valid = {
      profileId: profile.id,
      planVersion: 1,
      revisionId: 1,
      revisionDigest: "a".repeat(64),
      requiredUnitMappingDigest: "b".repeat(64),
    };
    for (const acceptedBasis of [
      { ...valid, profileId: 0 },
      { ...valid, profileId: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, planVersion: 0 },
      { ...valid, revisionId: 0 },
      { ...valid, revisionDigest: "A".repeat(64) },
      { ...valid, requiredUnitMappingDigest: "b".repeat(63) },
    ]) {
      const action = {
        id: "invalid-basis",
        type: "archive_plan",
        plan_id: profile.id,
        label: "Archive",
        summary: "Archive",
        params: { accepted_basis: acceptedBasis },
      } satisfies AssistantProposedAction;
      await expect(applyAssistantAction(action, { repo, jobs })).resolves.toEqual({
        ok: false,
        detail: "Accepted Plan basis is missing",
      });
    }
    expect(repo.getOwnedProfileIdentity(profile.id)?.archivedAt).toBeNull();
  });

  it("returns a stable 500 when assistant archive identity lookup fails", async () => {
    const { root, repo, profile } = await fixture();
    repo.getOwnedProfileIdentity = () => {
      throw new Error("private assistant Apply identity sentinel");
    };
    const jobs = new InProcessJobRunner({
      getRepo: () => repo,
      reposDir: join(root, "repos"),
      exportsDir: join(root, "exports"),
      dataDir: root,
    });
    const app = Fastify();
    await app.register(rateLimit, { global: false });
    app.decorateRequest("tenantId", "");
    app.addHook("onRequest", async (request: { tenantId: string }) => {
      request.tenantId = "default";
    });
    await registerAssistantRoutes(app, { repo, config: loadConfig(), jobs });
    await app.ready();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/assistant/actions/apply",
        payload: {
          action: {
            id: "identity-failure",
            type: "archive_plan",
            plan_id: profile.id,
            label: "Archive",
            summary: "Archive",
            params: {
              accepted_basis: {
                profileId: profile.id,
                planVersion: 1,
                revisionId: 1,
                revisionDigest: "a".repeat(64),
                requiredUnitMappingDigest: "b".repeat(64),
              },
            },
          } satisfies AssistantProposedAction,
        },
      });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({ detail: "Internal Server Error" });
      expect(response.body).not.toContain("private assistant Apply identity sentinel");
    } finally {
      await app.close();
    }
  });

  it("keeps assistant archive Apply failures behind the HTTP boundary", async () => {
    const { root, repo, profile } = await fixture();
    const accepted = repo.readAcceptedPlanOperationalSnapshot(profile.id);
    if (accepted.kind !== "ready") throw new Error("accepted Plan is not ready");
    const basis = {
      profileId: profile.id,
      planVersion: accepted.snapshot.planVersion,
      revisionId: accepted.snapshot.revisionId,
      revisionDigest: accepted.snapshot.revisionDigest,
      requiredUnitMappingDigest: accepted.snapshot.requiredUnitMappingDigest,
    };
    const action = {
      id: "archive-boundary",
      type: "archive_plan",
      plan_id: profile.id,
      label: "Archive",
      summary: "Archive",
      params: { accepted_basis: basis },
    } satisfies AssistantProposedAction;
    const jobs = new InProcessJobRunner({
      getRepo: () => repo,
      reposDir: join(root, "repos"),
      exportsDir: join(root, "exports"),
      dataDir: root,
    });
    const app = Fastify();
    const capturedErrors: unknown[][] = [];
    await app.register(rateLimit, { global: false });
    app.decorateRequest("tenantId", "");
    app.addHook("onRequest", async (request: { tenantId: string; log: { error: (...args: unknown[]) => void } }) => {
      request.tenantId = "default";
      request.log.error = (...args: unknown[]) => {
        capturedErrors.push(args);
      };
    });
    await registerAssistantRoutes(app, { repo, config: loadConfig(), jobs });
    await app.ready();
    const archiveAcceptedPlan = repo.archiveAcceptedPlan.bind(repo);
    const canMutateAcceptedPlan = repo.canMutateAcceptedPlan.bind(repo);
    const getOwnedProfileIdentity = repo.getOwnedProfileIdentity.bind(repo);
    try {
      const missingParams = await app.inject({
        method: "POST",
        url: "/assistant/actions/apply",
        payload: { action: { ...action, params: undefined } },
      });
      expect(missingParams.statusCode).toBe(400);
      expect(missingParams.json()).toEqual({
        status: 400,
        title: "Bad Request",
        detail: "Accepted Plan basis is missing",
      });

      repo.archiveAcceptedPlan = () => {
        throw new AcceptedPlanOperationalIntegrityError(
          "revision",
          `private integrity sentinel ${root} ${"d".repeat(64)}`,
        );
      };
      const integrity = await app.inject({
        method: "POST",
        url: "/assistant/actions/apply",
        payload: { action },
      });
      expect(integrity.statusCode).toBe(500);
      expect(integrity.json()).toEqual({
        status: 500,
        title: "Internal Server Error",
        detail: "Accepted Plan data is inconsistent",
      });

      repo.archiveAcceptedPlan = () => {
        throw new Error(`private archive sentinel ${root} ${"e".repeat(64)}`);
      };
      const unexpected = await app.inject({
        method: "POST",
        url: "/assistant/actions/apply",
        payload: { action },
      });
      expect(unexpected.statusCode).toBe(500);
      expect(unexpected.json()).toEqual({
        status: 500,
        title: "Internal Server Error",
        detail: "Internal Server Error",
      });

      repo.archiveAcceptedPlan = () => ({ kind: "transaction_unavailable" });
      const unavailable = await app.inject({
        method: "POST",
        url: "/assistant/actions/apply",
        payload: { action },
      });
      expect(unavailable.statusCode).toBe(503);
      expect(unavailable.json()).toEqual({
        status: 503,
        title: "Service Unavailable",
        detail: "Accepted Plan update is unavailable",
      });

      repo.canMutateAcceptedPlan = () => {
        throw new Error(`private capability sentinel ${root} ${"c".repeat(64)}`);
      };
      const escapedUnexpected = await app.inject({
        method: "POST",
        url: "/assistant/actions/apply",
        payload: { action },
      });
      expect(escapedUnexpected.statusCode).toBe(500);
      expect(escapedUnexpected.json()).toEqual({
        status: 500,
        title: "Internal Server Error",
        detail: "Internal Server Error",
      });
      repo.canMutateAcceptedPlan = canMutateAcceptedPlan;

      repo.archiveAcceptedPlan = archiveAcceptedPlan;
      const completed = repo.setAcceptedUnitCompletion({
        expected: basis,
        token: parseRequiredUnitToken(accepted.snapshot.parts[0]!.units[0]!.token),
        completed: true,
      });
      expect(completed.kind).toBe("updated");
      const archived = await app.inject({
        method: "POST",
        url: "/assistant/actions/apply",
        payload: { action },
      });
      expect(archived.statusCode).toBe(200);
      expect(archived.json()).toEqual({
        ok: true,
        result: {
          plan_id: profile.id,
          name: "Assistant Progress 1",
          archived_at: expect.any(String),
        },
      });

      repo.getOwnedProfileIdentity = () => {
        throw new Error(`private identity sentinel ${root} ${"a".repeat(64)}`);
      };
      const identityFailure = await app.inject({
        method: "POST",
        url: "/assistant/actions/apply",
        payload: { action },
      });
      expect(identityFailure.statusCode).toBe(500);
      expect(identityFailure.json()).toEqual({
        status: 500,
        title: "Internal Server Error",
        detail: "Internal Server Error",
      });

      const serializedErrors = JSON.stringify(capturedErrors, (_key, value: unknown) =>
        value instanceof Error ? { message: value.message, stack: value.stack } : value,
      );
      expect(serializedErrors).toContain("Assistant action apply failed");
      expect(serializedErrors).toContain('"failure":"integrity"');
      expect(serializedErrors).toContain('"failure":"unexpected"');
      expect(serializedErrors).not.toContain("private integrity sentinel");
      expect(serializedErrors).not.toContain("private archive sentinel");
      expect(serializedErrors).not.toContain("private capability sentinel");
      expect(serializedErrors).not.toContain("private compatibility sentinel");
      expect(serializedErrors).not.toContain("private identity sentinel");
      expect(serializedErrors).not.toContain(root);
      expect(serializedErrors).not.toContain("d".repeat(64));
      expect(serializedErrors).not.toContain("e".repeat(64));
      expect(serializedErrors).not.toContain("c".repeat(64));
      expect(serializedErrors).not.toContain("f".repeat(64));
      expect(serializedErrors).not.toContain("a".repeat(64));
      expect(serializedErrors).not.toContain("accepted-progress-tools.test.ts");
    } finally {
      repo.archiveAcceptedPlan = archiveAcceptedPlan;
      repo.canMutateAcceptedPlan = canMutateAcceptedPlan;
      repo.getOwnedProfileIdentity = getOwnedProfileIdentity;
      await app.close();
    }
  });

  it("rejects a route Apply whose accepted basis belongs to another Plan", async () => {
    const { root, repo, profiles } = await fixture(2);
    const first = profiles[0]!;
    const second = profiles[1]!;
    const accepted = repo.readAcceptedPlanOperationalSnapshot(second.profile.id);
    if (accepted.kind !== "ready") throw new Error("second accepted Plan is not ready");
    const completed = repo.setAcceptedUnitCompletion({
      expected: {
        profileId: second.profile.id,
        planVersion: accepted.snapshot.planVersion,
        revisionId: accepted.snapshot.revisionId,
        revisionDigest: accepted.snapshot.revisionDigest,
        requiredUnitMappingDigest: accepted.snapshot.requiredUnitMappingDigest,
      },
      token: parseRequiredUnitToken(accepted.snapshot.parts[0]!.units[0]!.token),
      completed: true,
    });
    expect(completed.kind).toBe("updated");
    const action = {
      id: "cross-plan-archive",
      type: "archive_plan",
      plan_id: first.profile.id,
      label: "Archive first",
      summary: "Archive first",
      params: {
        accepted_basis: {
          profileId: second.profile.id,
          planVersion: accepted.snapshot.planVersion,
          revisionId: accepted.snapshot.revisionId,
          revisionDigest: accepted.snapshot.revisionDigest,
          requiredUnitMappingDigest: accepted.snapshot.requiredUnitMappingDigest,
        },
      },
    } satisfies AssistantProposedAction;
    const jobs = new InProcessJobRunner({
      getRepo: () => repo,
      reposDir: join(root, "repos"),
      exportsDir: join(root, "exports"),
      dataDir: root,
    });
    const app = Fastify();
    await app.register(rateLimit, { global: false });
    app.decorateRequest("tenantId", "");
    app.addHook("onRequest", async (request: { tenantId: string }) => {
      request.tenantId = "default";
    });
    await registerAssistantRoutes(app, { repo, config: loadConfig(), jobs });
    await app.ready();
    const raw = new Database(join(root, "print-partner.db"), { readonly: true });
    const storedState = () => ({
      profiles: raw.prepare("SELECT id, archived_at FROM build_profiles ORDER BY id").all(),
      progress: raw.prepare("SELECT * FROM print_progress ORDER BY id").all(),
      decisions: raw.prepare("SELECT * FROM plan_decisions ORDER BY id").all(),
      settings: raw.prepare("SELECT * FROM app_settings ORDER BY tenant_id, key").all(),
    });
    const before = storedState();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/assistant/actions/apply",
        payload: { action },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ detail: "Accepted Plan basis does not match action Plan" });
      expect(response.body).not.toContain(second.profile.name);
      expect(repo.getProfileHeader(first.profile.id)?.archived_at).toBeNull();
      expect(repo.getProfileHeader(second.profile.id)?.archived_at).toBeNull();
      expect(storedState()).toEqual(before);
    } finally {
      raw.close();
      await app.close();
    }
  });
});
