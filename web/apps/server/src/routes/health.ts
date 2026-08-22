import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../config.js";
import type { AppPorts } from "../ports/index.js";
import { pingBundle } from "../db/database.js";
import type { SaasDbStore } from "../adapters/saas/index.js";
import { deploymentCapability } from "../lib/deployment-capability.js";
import { getVersionInfo, getBuildSemver } from "../lib/version.js";

export async function registerHealthRoutes(
  app: FastifyInstance,
  config: ServerConfig,
  ports: AppPorts,
): Promise<void> {
  app.get("/health", async () => {
    let dbOk = false;
    let postgresOk: boolean | null = null;

    try {
      await ports.db.ping();
      dbOk = true;
    } catch {
      /* dbOk stays false */
    }

    const saasDb = ports.db as Partial<SaasDbStore>;
    if (saasDb.bundle) {
      try {
        const status = await pingBundle(saasDb.bundle);
        dbOk = status.app;
        postgresOk = status.postgres;
      } catch {
        /* ignore */
      }
    }

    return {
      ok: dbOk,
      version: config.version,
      semver: getBuildSemver(config.releaseIdentity),
      build: getVersionInfo(config.releaseIdentity),
      release: config.releaseIdentity,
      deploy_mode: config.deployMode,
      multi_user: config.multiUser,
      data_dir: config.dataDir,
      port: config.port,
      api_version: "v1",
      capabilities: [
        "kit_planning",
        "accepted_plate_revisions",
        "accepted_plate_export",
        "jobs_ws",
        "fleet_presets",
        "integrations_api",
        ...(config.multiUser ? ["multi_user_auth", "plan_sharing"] : []),
        ...(config.smtpConfigured ? ["password_reset_email"] : []),
        "mcp_http",
        ...(config.googleClientId ? ["google_drive_manifest"] : []),
        "backups",
        "logging",
        "api_key_management",
        "webhook_security",
      ],
      db: {
        connected: dbOk,
        driver: saasDb.bundle?.driver ?? "sqlite",
        postgres: postgresOk,
        support_status:
          saasDb.bundle?.driver === "postgres" ? "experimental" : "supported",
      },
      deployment: deploymentCapability({
        databaseDriver: saasDb.bundle?.driver === "postgres" ? "postgres" : "sqlite",
        s3Bucket: config.s3Bucket,
        multiUser: config.multiUser,
      }),
      google_drive: {
        client_id: config.googleClientId,
      },
    };
  });
}
