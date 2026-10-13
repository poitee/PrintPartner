import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import type { DrizzleDb } from "../../apps/server/src/db/client.js";
import type { AppRepository } from "../../apps/server/src/db/repository.js";
import * as schema from "../../apps/server/src/db/schema.js";
import { readAcceptedPlanProgressBatch } from "../../apps/server/src/db/accepted-plan-progress-summary.js";
import { toAcceptedCheckoffView } from "../../apps/server/src/services/accepted-plan-views.js";
import { json, type Json } from "../desktop-parity/model.mjs";

export async function publicNodeProjection(input: {
  database: DrizzleDb;
  repository: AppRepository;
  app: FastifyInstance;
}) {
  const progress = readAcceptedPlanProgressBatch({ db: input.database, schema, tenantId: "default", sqlite: true }, [1]).get(1);
  assert(progress, "Production progress batch omitted requested profile");
  const checkoff = toAcceptedCheckoffView({ profileId: 1, accepted: input.repository.readAcceptedPlanOperationalSnapshot(1) });
  const response = await input.app.inject({ method: "GET", url: "/plans/1/checkoff" });
  assert.equal(response.statusCode, 200, "Current ready-state public Checkoff fixture must be readable");
  return { progress: json(progress), checkoff: json(checkoff), http: { status: response.statusCode, body: json(response.json()) } };
}

export type PublicProjection = Awaited<ReturnType<typeof publicNodeProjection>>;
export type ProjectionPair = { node: PublicProjection; rust: Json; phase: "mutation" | "reopened" };
