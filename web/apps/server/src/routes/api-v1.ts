import type { FastifyInstance } from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { ServerConfig } from "../config.js";
import { registerCoreRoutes, type CoreRouteDeps } from "./core-routes.js";
import { registerMcpHttpRoutes } from "../mcp/http-routes.js";

export async function registerApiV1Plugin(
  app: FastifyInstance,
  deps: CoreRouteDeps,
  validateApiKey: (rawKey: string) => boolean,
): Promise<void> {
  app.get("/", async () => ({
    version: "1",
    openapi: "/api/v1/openapi.json",
    health: "/health",
    docs: "/api/v1/docs",
    mcp: "/api/v1/mcp",
  }));

  await registerCoreRoutes(app, deps, {
    apiV1Extensions: true,
    planSummaryContract: "legacy-v1",
  });
  await registerMcpHttpRoutes(app, {
    getRepo: () => deps.repo,
    jobs: deps.jobs,
    config: deps.config,
    validateApiKey,
  });
}

export async function registerOpenApi(app: FastifyInstance, _config: ServerConfig): Promise<void> {
  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Print Partner API",
        description: "Kit planning, exports, and integrations for self-host Docker.",
        version: "1.0.0",
      },
      tags: [
        { name: "health", description: "Health and capabilities" },
        { name: "plans", description: "Kit plans and parts" },
        { name: "jobs", description: "Background jobs and exports" },
        { name: "integrations", description: "External printer and filament connectors" },
      ],
      components: {
        schemas: {
          ApiError: {
            type: "object",
            properties: {
              detail: { type: "string" },
              title: { type: "string" },
              code: { type: "string" },
            },
            required: ["detail"],
          },
          JobStartResponse: {
            type: "object",
            properties: { job_id: { type: "string", format: "uuid" } },
            required: ["job_id"],
          },
        },
        securitySchemes: {
          ApiKeyHeader: {
            type: "apiKey",
            in: "header",
            name: "X-Print-Partner-Api-Key",
          },
          BearerAuth: { type: "http", scheme: "bearer" },
        },
      },
    },
  });

  const enableUi =
    process.env.NODE_ENV !== "production" || process.env.OPENAPI_UI === "1";
  if (enableUi) {
    await app.register(swaggerUi, {
      routePrefix: "/api/v1/docs",
      uiConfig: { docExpansion: "list", deepLinking: true },
    });
  }
}

/** Register OpenAPI JSON routes after all handlers are mounted. */
export function registerOpenApiJsonRoutes(app: FastifyInstance): void {
  app.get("/openapi.json", async (_request, reply) => {
    return reply.redirect("/api/v1/openapi.json");
  });
  app.get("/api/v1/openapi.json", async () => app.swagger());
  app.get("/api/v2/openapi.json", async () => app.swagger());
}
