import * as Sentry from "@sentry/node";
import type { ServerConfig } from "../config.js";

export type PrinterFailure = {
  operation: "browse" | "download" | "inspect";
  failure: "timeout" | "stream_interrupted" | "upstream_error";
  status?: number;
  headersSent?: boolean;
};

type ReportingConfig = Pick<ServerConfig, "printerErrorReporting" | "releaseIdentity">;
let client: ReturnType<typeof Sentry.init> | null = null;
const SHUTDOWN_TIMEOUT_MS = 500;

function parseDsn(dsn: string | null): string | null {
  if (!dsn) return null;
  try {
    const url = new URL(dsn);
    const valid = (url.protocol === "https:" || url.protocol === "http:") &&
      /^\w+$/.test(url.username) && !url.password && !url.search && !url.hash &&
      /\/\d+$/.test(url.pathname);
    return valid ? url.href : null;
  } catch {
    return null;
  }
}

type SafeErrorEvent = Sentry.ErrorEvent & { event_id: string };

function safeEvent(value: unknown, release: string, environment: string): SafeErrorEvent | null {
  if (typeof value !== "object" || value === null || !("tags" in value)) return null;
  const tags = value.tags;
  if (typeof tags !== "object" || tags === null || !("operation" in tags) || !("failure" in tags)) return null;
  const { operation, failure } = tags;
  if (operation !== "browse" && operation !== "download" && operation !== "inspect") return null;
  if (failure !== "timeout" && failure !== "stream_interrupted" && failure !== "upstream_error") return null;
  if (!("event_id" in value) || typeof value.event_id !== "string" || !/^[a-f0-9]{32}$/.test(value.event_id)) return null;
  const event: SafeErrorEvent = {
    type: undefined,
    event_id: value.event_id,
    platform: "node",
    level: "error",
    message: `Printer file ${operation} failed`,
    release,
    environment,
    fingerprint: ["printer-file", operation, failure],
    tags: { operation, failure },
  };
  if ("timestamp" in value && typeof value.timestamp === "number" && Number.isFinite(value.timestamp)) {
    event.timestamp = value.timestamp;
  }
  if ("http_status" in tags && typeof tags.http_status === "number" && Number.isInteger(tags.http_status) && tags.http_status >= 100 && tags.http_status <= 599) {
    event.tags = { ...event.tags, http_status: tags.http_status };
  }
  if ("headers_sent" in tags && typeof tags.headers_sent === "boolean") {
    event.tags = { ...event.tags, headers_sent: tags.headers_sent };
  }
  return event;
}

export function initializePrinterErrorReporting(config: ReportingConfig): boolean {
  const settings = config.printerErrorReporting;
  const dsn = settings.enabled ? parseDsn(settings.dsn) : null;
  if (!dsn) return false;
  if (client) return true;
  const release = `print-partner@${config.releaseIdentity.version}${config.releaseIdentity.commit ? `+${config.releaseIdentity.commit}` : "-dev"}`;
  const environment = settings.environment;
  try {
    client = Sentry.init({
      dsn,
      release,
      environment,
      debug: false,
      spotlight: false,
      defaultIntegrations: false,
      integrations: [],
      skipOpenTelemetrySetup: true,
      registerEsmLoaderHooks: false,
      includeServerName: false,
      maxBreadcrumbs: 0,
      attachStacktrace: false,
      sendClientReports: false,
      enableLogs: false,
      enableMetrics: false,
      tracesSampleRate: 0,
      profileSessionSampleRate: 0,
      tracePropagationTargets: [],
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: { request: false, response: false },
        httpBodies: [],
        urlQueryParams: false,
        genAI: { inputs: false, outputs: false },
        graphQL: { document: false, variables: false },
        databaseQueryData: false,
        stackFrameVariables: false,
        frameContextLines: 0,
      },
      beforeSend(event, hint) {
        hint.attachments = [];
        return safeEvent(event, release, environment);
      },
      beforeSendTransaction: () => null,
      transport(options) {
        const transport = Sentry.makeNodeTransport(options);
        return {
          async send(envelope) {
            // SDK-internal errors bypass beforeSend; attachments are added after it.
            const eventItem = envelope[1].find(([header]) => header.type === "event");
            const event = safeEvent(eventItem?.[1], release, environment);
            if (!event) return {};
            try {
              return await transport.send([
                { event_id: event.event_id, sent_at: new Date().toISOString() },
                [[{ type: "event" }, event]],
              ]);
            } catch {
              return {};
            }
          },
          async flush(timeout) {
            try {
              return await transport.flush(timeout);
            } catch {
              return false;
            }
          },
        };
      },
    });
    return true;
  } catch {
    client = null;
    return false;
  }
}

export function reportPrinterFailure(input: PrinterFailure): void {
  try {
    client?.captureEvent({
      tags: {
        operation: input.operation,
        failure: input.failure,
        http_status: input.status,
        headers_sent: input.headersSent,
      },
    });
  } catch {
    // Reporting must not change the printer operation's result.
  }
}

export async function shutdownPrinterErrorReporting(): Promise<void> {
  const closing = client;
  client = null;
  if (!closing) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      closing.close(SHUTDOWN_TIMEOUT_MS),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS); }),
    ]);
  } catch {
    // A failed reporting transport must not prevent the app from stopping.
  } finally {
    clearTimeout(timer);
  }
}
