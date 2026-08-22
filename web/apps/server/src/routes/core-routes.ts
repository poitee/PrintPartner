import type { FastifyInstance } from "fastify";
import { join } from "node:path";
import type { ServerConfig } from "../config.js";
import type { AppRepository } from "../db/repository.js";
import { registerExportRoutes } from "./exports.js";
import { registerImportRoutes } from "./imports.js";
import { registerLegalRoutes } from "./legal.js";
import { registerManifestRoutes } from "./manifest.js";
import { registerPartRoutes } from "./parts.js";
import { registerPlanRoutes, type PlanSummaryContract } from "./plans.js";
import { registerPrinterRoutes } from "./printers.js";
import { registerSlicerInstanceRoutes } from "./slicer-instances.js";
import { registerSlicerHandoffRoutes } from "./slicer-handoff.js";
import { registerProfileLibraryRoutes } from "./profile-library.js";
import { registerRepoManifestRoutes } from "./repo-manifest.js";
import { registerSourceDocsRoutes } from "./source-docs.js";
import {
  registerSettingsRoutes,
  registerSourceNamingRoutes,
  registerStubRoutes,
} from "./settings.js";
import { registerSourceRoutes } from "./sources.js";
import { registerJobRoutes, type InProcessJobRunner } from "./jobs.js";
import { registerApiV1ExtensionRoutes } from "./api-v1-extensions.js";
import { registerIntegrationRoutes } from "./integrations.js";
import { registerPrinterCheckoffRoutes } from "./printer-checkoff.js";
import { registerPrinterSendQueueRoutes } from "./printer-send-queue.js";
import { registerBambuConnectRoutes } from "./bambu-connect.js";
import { registerWebhookRoutes } from "./webhooks.js";
import { registerShareRoutes } from "./shares.js";
import { registerAssistantRoutes } from "./assistant.js";
import type { AuthStore } from "../services/auth-store.js";
import { createIntegrationPort } from "../integrations/store.js";
import { registerDiscordDigestRoute } from "./discord-digest.js";
import { getIntegrationAdapter } from "../integrations/registry.js";

export type CoreRouteDeps = {
  repo: AppRepository;
  reposDir: string;
  sourcesDir: string;
  thumbsDir: string;
  coversDir: string;
  dataDir: string;
  config: ServerConfig;
  jobs: InProcessJobRunner;
  authStore?: AuthStore | null;
};

export type CoreRouteOptions = {
  /** v1-only routes: integrations, webhooks, artifacts, job list */
  apiV1Extensions?: boolean;
  authStore?: AuthStore | null;
  planSummaryContract?: PlanSummaryContract;
};

export async function registerCoreRoutes(
  app: FastifyInstance,
  deps: CoreRouteDeps,
  options: CoreRouteOptions = {},
): Promise<void> {
  const routeDeps = {
    repo: deps.repo,
    reposDir: deps.reposDir,
    sourcesDir: deps.sourcesDir,
    thumbsDir: deps.thumbsDir,
    coversDir: deps.coversDir,
    jobs: deps.jobs,
  };

  await registerSourceRoutes(app, routeDeps);
  await registerPlanRoutes(app, {
    repo: deps.repo,
    dataDir: deps.dataDir,
    reposDir: deps.reposDir,
    thumbsDir: deps.thumbsDir,
  }, { summaryContract: options.planSummaryContract });
  await registerPartRoutes(app, {
    repo: deps.repo,
    reposDir: deps.reposDir,
    thumbsDir: deps.thumbsDir,
  });
  await registerExportRoutes(app, { dataDir: deps.dataDir });
  await registerImportRoutes(app, { repo: deps.repo });
  await registerSettingsRoutes(app, { repo: deps.repo, dataDir: deps.dataDir, config: deps.config });
  await registerSourceNamingRoutes(app, { repo: deps.repo, dataDir: deps.dataDir });
  await registerStubRoutes(app, { repo: deps.repo, dataDir: deps.dataDir });
  await registerLegalRoutes(app);
  await registerRepoManifestRoutes(app, { repo: deps.repo });
  await registerSourceDocsRoutes(app, { repo: deps.repo });
  await registerPrinterRoutes(app, { repo: deps.repo });
  await registerSlicerInstanceRoutes(app, {
    repo: deps.repo,
    deployMode: deps.config.deployMode,
  });
  await registerSlicerHandoffRoutes(app, {
    repo: deps.repo,
    config: deps.config,
    exportsDir: join(deps.dataDir, "exports"),
    dataDir: deps.dataDir,
    reposDir: deps.reposDir,
  });
  await registerProfileLibraryRoutes(app, { repo: deps.repo });
  await registerManifestRoutes(app, { repo: deps.repo });

  const authStore = options.authStore ?? deps.authStore;
  if (deps.config.multiUser && authStore) {
    registerShareRoutes(app, { repo: deps.repo, authStore, config: deps.config });
  }

  const integrations = createIntegrationPort({
    repo: deps.repo,
    getAdapter: getIntegrationAdapter,
  });
  await registerPrinterCheckoffRoutes(app, { integrations, repo: deps.repo });
  await registerDiscordDigestRoute(app, { repo: deps.repo, integrations });
  await registerPrinterSendQueueRoutes(app, {
    integrations,
    repo: deps.repo,
    jobs: deps.jobs,
  });
  await registerBambuConnectRoutes(app, { repo: deps.repo, jobs: deps.jobs });

  if (options.apiV1Extensions) {
    await registerApiV1ExtensionRoutes(app, {
      repo: deps.repo,
      jobs: deps.jobs,
    });
    await registerIntegrationRoutes(app, { integrations, repo: deps.repo });
    await registerWebhookRoutes(app, { repo: deps.repo });
  }

  await registerJobRoutes(app, deps.jobs, deps.config);
  await registerAssistantRoutes(app, {
    repo: deps.repo,
    config: deps.config,
    jobs: deps.jobs,
  });
}
