import type { FastifyReply } from "fastify";
import type { AssignAcceptedFilamentResult } from "../db/accepted-part-filament.js";
import { acceptedStateDetail } from "./accepted-state-detail.js";

export function sendAcceptedFilamentFailure(
  reply: FastifyReply,
  failure: AssignAcceptedFilamentResult,
) {
  if (failure.kind === "updated") {
    throw new Error("Accepted filament success cannot be sent as a failure");
  }
  if (failure.kind === "accepted_state_unavailable") {
    return reply.status(409).send({ detail: acceptedStateDetail(failure.reason) });
  }
  if (failure.kind === "stale_accepted_plan") {
    return reply.status(409).send({ detail: "Accepted Plan changed; reload and retry" });
  }
  if (failure.kind === "transaction_unavailable") {
    return reply.status(503).send({ detail: "Accepted Plan update is unavailable" });
  }
  if (failure.kind === "plan_archived") {
    return reply.status(409).send({ detail: "Archived Plan Progress cannot be changed" });
  }
  return reply.status(404).send({ detail: "Part not found" });
}
