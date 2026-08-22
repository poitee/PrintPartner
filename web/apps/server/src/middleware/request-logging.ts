import type { FastifyInstance, FastifyRequest } from "fastify";
import { getLogger, type LogSeverity } from "../services/logger.js";

type RequestWithTiming = FastifyRequest & { startTime?: number; userId?: string };

export async function registerRequestLoggingMiddleware(app: FastifyInstance): Promise<void> {
  const logger = getLogger();

  // Track request timing and outcome
  app.addHook("preHandler", async (request) => {
    (request as RequestWithTiming).startTime = Date.now();
  });

  app.addHook("onResponse", async (request, reply) => {
    const startTime = (request as RequestWithTiming).startTime ?? Date.now();
    const duration = Date.now() - startTime;

    // Determine severity based on status code
    let severity: LogSeverity = "info";
    if (reply.statusCode >= 500) {
      severity = "error";
    } else if (reply.statusCode >= 400) {
      severity = "warn";
    } else if (reply.statusCode < 200) {
      severity = "debug";
    }

    // Skip noise: health checks, static files, polling endpoints
    const isHealthCheck = request.url === "/health";
    const isStaticFile = /\.(js|css|png|jpg|gif|svg|woff|woff2|ttf|eot)$/i.test(request.url);
    const isPollingEndpoint = /\/(printer-send-queue|filaments)/.test(request.url);
    
    if (isHealthCheck || isStaticFile || isPollingEndpoint) {
      return;
    }

    logger.logWorkflow({
      method: request.method,
      url: request.url,
      userId: (request as RequestWithTiming).userId,
      duration,
      statusCode: reply.statusCode,
      severity,
      message: `${request.method} ${request.url}`,
      context: {
        params: request.params,
        query: request.query,
      },
    });
  });

  // Log unhandled errors
  app.setErrorHandler(async (error, request, reply) => {
    const startTime = (request as RequestWithTiming).startTime ?? Date.now();
    const duration = Date.now() - startTime;

    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;

    logger.logWorkflow({
      method: request.method,
      url: request.url,
      userId: (request as RequestWithTiming).userId,
      duration,
      statusCode: reply.statusCode || 500,
      severity: "error",
      message: `Error in ${request.method} ${request.url}`,
      error: {
        message: errorMessage,
        stack: errorStack,
      },
    });

    // Re-throw to let Fastify handle the response
    throw error;
  });
}
