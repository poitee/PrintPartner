/**
 * POST /api/discord-digest
 *
 * Trigger the morning farm digest and post it to the configured Discord webhook.
 * Called by an external morning-digest cron. Requires no body — all data is
 * sourced from the local DB and live printer integrations.
 *
 * Auth: requires a valid API key or session (same as /metrics).
 */

import type { FastifyInstance } from "fastify";
import type { AppRepository } from "../db/repository.js";
import type { IntegrationPort } from "../integrations/store.js";
import { loadFleet } from "../services/printer-fleet.js";
import {
  sendFarmDigest,
  type FarmDigestData,
  type FarmDigestPlanCollection,
} from "../services/discord-notify.js";
import { getLogger } from "../services/logger.js";

type DigestDeps = {
  repo: AppRepository;
  integrations?: IntegrationPort;
};

export async function registerDiscordDigestRoute(
  app: FastifyInstance,
  deps: DigestDeps,
): Promise<void> {
  app.post("/api/discord-digest", async (request, reply) => {
    const logger = getLogger();

    // Auth check: session or API key (same pattern as /metrics)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessionUser = (request as any).sessionUser;
    const authHeader = request.headers["authorization"];
    const apiKey = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!sessionUser && !apiKey) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { config } = app as any;
      if (config?.authRequired) {
        return reply.status(401).send({ detail: "Authentication required" });
      }
    }

    const webhookUrl = deps.repo.getSetting("discord_notify_webhook_url") || null;
    if (!webhookUrl) {
      return reply.status(422).send({ detail: "discord_notify_webhook_url not configured" });
    }

    // Collect print stats for overnight window (last 8 hours)
    const windowHours = 8;
    const since = new Date(Date.now() - windowHours * 3600 * 1000).toISOString();
    let platesOvernight = 0;
    try {
      platesOvernight = deps.repo.recentPrintJobs(since, 1000).length;
    } catch {
      // table may not exist yet — proceed with 0
    }

    // Collect farm status
    const fleet = loadFleet(deps.repo);
    const printers = await Promise.all(
      fleet.map(async (m) => {
        let state = "unknown";
        let activeJob: string | null = null;
        if (m.integration_id && deps.integrations) {
          try {
            const status = await deps.integrations.getStatus(m.integration_id);
            state = status.state;
            activeJob = (status as Record<string, unknown>).filename as string | null ?? null;
          } catch {
            state = "offline";
          }
        }
        return { name: m.name, state, active_job: activeJob };
      }),
    );

    let activePlans: FarmDigestPlanCollection;
    try {
      activePlans = {
        kind: "available",
        plans: deps.repo
          .listAcceptedProfileSummaries()
          .filter(({ header }) => !header.archived_at)
          .map(({ header, progress }) => ({ plan_name: header.name, progress })),
      };
    } catch {
      activePlans = { kind: "unavailable" };
      logger.log(
        "error",
        "[discord-digest] Plan progress collection unavailable",
        { failure: "unexpected", operation: "discord_digest_plan_progress" },
      );
    }

    const digestData: FarmDigestData = {
      platesOvernight,
      windowHours,
      printers,
      activePlans,
    };

    try {
      await sendFarmDigest(webhookUrl, digestData);
      logger.log("info", "[discord-digest] Morning digest sent", {
        plates: platesOvernight,
        printers: printers.length,
      });
      return reply.send({ ok: true, plates_overnight: platesOvernight });
    } catch (err) {
      logger.log("error", `[discord-digest] Failed: ${err instanceof Error ? err.message : String(err)}`, {});
      return reply.status(500).send({ detail: "Failed to send digest" });
    }
  });
}
