import type { FastifyInstance } from "fastify";
import type { AppRepository } from "../db/repository.js";
import type { AuthStore } from "../services/auth-store.js";
import type { ServerConfig } from "../config.js";
import {
  AcceptedOperationalExportPublicError,
  acceptedOperationalExportHttpStatus,
  acceptedOperationalExportPublicError,
  captureAcceptedOperationalExport,
} from "../services/accepted-operational-export.js";
import { buildKitBundleData } from "../services/export-kit.js";
import { getLogger } from "../services/logger.js";

export function registerShareRoutes(
  app: FastifyInstance,
  deps: {
    repo: AppRepository;
    authStore: AuthStore;
    config: ServerConfig;
  },
): void {
  const { repo, authStore, config } = deps;
  const limited = { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };

  app.post("/plans/:id/shares", limited, async (request, reply) => {
    if (!config.multiUser || !request.sessionUser) {
      return reply.status(401).send({ detail: "Authentication required" });
    }
    const planId = Number((request.params as { id: string }).id);
    if (!Number.isFinite(planId)) return reply.status(400).send({ detail: "Invalid plan id" });
    const profile = repo.getOwnedProfileIdentity(planId);
    if (!profile) return reply.status(404).send({ detail: "Plan not found" });

    const body = request.body as {
      recipient_email?: string | null;
      include_print_progress?: boolean;
    };
    const includePrintProgress = body.include_print_progress ?? false;
    let bundleData: Record<string, unknown>;
    let revisionId: number | undefined;
    try {
      const accepted = includePrintProgress
        ? captureAcceptedOperationalExport({ repository: repo, profileId: planId })
        : null;
      if (accepted && accepted.kind !== "ready" && accepted.kind !== "empty") {
        throw acceptedOperationalExportPublicError(accepted);
      }
      revisionId = accepted?.kind === "ready" ? accepted.export.basis.revisionId : undefined;
      const recipe = repo.readEditableKitRecipe(planId);
      bundleData = buildKitBundleData({
        mode: accepted
          ? {
              kind: "accepted_progress",
              recipe,
              accepted: accepted.kind === "ready" ? accepted.export : null,
            }
          : { kind: "editable", recipe },
        exportedAt: new Date().toISOString(),
      });
    } catch (error) {
      const publicError = error instanceof AcceptedOperationalExportPublicError
        ? error
        : new AcceptedOperationalExportPublicError("unexpected");
      if (!(error instanceof AcceptedOperationalExportPublicError)) {
        getLogger().log("error", "Accepted operational share export failed unexpectedly", {
          operation: "accepted_share_progress_export",
          failure: "unexpected",
          profileId: planId,
          ...(revisionId == null ? {} : { revisionId }),
        });
      }
      return reply
        .status(acceptedOperationalExportHttpStatus(publicError))
        .send({ detail: publicError.message });
    }
    const share = authStore.createPlanShare({
      fromUserId: request.sessionUser.user_id,
      planId,
      planName: profile.name,
      bundleJson: JSON.stringify(bundleData),
      recipientEmail: body.recipient_email ?? null,
    });
    return {
      share_id: share.id,
      token: share.token,
      plan_name: profile.name,
    };
  });

  app.get("/shares/incoming", async (request, reply) => {
    if (!config.multiUser || !request.sessionUser) {
      return reply.status(401).send({ detail: "Authentication required" });
    }
    const shares = authStore.listIncomingShares(
      request.sessionUser.email,
      request.sessionUser.user_id,
    );
    return {
      shares: shares.map((s) => ({
        id: s.id,
        token: s.token,
        plan_name: s.planName,
        from_display_name: s.fromDisplayName,
        recipient_email: s.recipientEmail,
        created_at: s.createdAt,
      })),
    };
  });

  app.post("/shares/:token/accept", limited, async (request, reply) => {
    if (!config.multiUser || !request.sessionUser) {
      return reply.status(401).send({ detail: "Authentication required" });
    }
    const token = (request.params as { token: string }).token;
    const share = authStore.getShareByToken(token);
    if (!share || share.status !== "pending") {
      return reply.status(404).send({ detail: "Share not found or no longer available" });
    }
    if (share.recipientEmail && request.sessionUser.email) {
      if (share.recipientEmail !== request.sessionUser.email.toLowerCase()) {
        return reply.status(403).send({ detail: "This share is for a different recipient" });
      }
    }
    const body = request.body as { new_name?: string | null };
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(share.bundleJson ?? "{}") as Record<string, unknown>;
    } catch {
      return reply.status(500).send({ detail: "Invalid share bundle" });
    }
    const result = repo.importKitBundle(data, body.new_name ?? null);
    authStore.markShareAccepted(share.id);
    return result;
  });

  app.delete("/shares/:id", async (request, reply) => {
    if (!config.multiUser || !request.sessionUser) {
      return reply.status(401).send({ detail: "Authentication required" });
    }
    const id = (request.params as { id: string }).id;
    const ok = authStore.revokeShare(id, request.sessionUser.user_id);
    if (!ok) return reply.status(404).send({ detail: "Share not found" });
    return { ok: true };
  });
}
