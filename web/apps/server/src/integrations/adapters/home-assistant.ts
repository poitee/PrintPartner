import type {
  IntegrationConfig,
  IntegrationTestResult,
  PrinterHostStatus,
  PrinterUploadResult,
} from "@print-partner/contracts";
import type { IntegrationAdapter, PrinterUploadSource } from "../store.js";
import { assertSafeOutboundUrl } from "../../lib/outbound-url.js";

/**
 * Home Assistant integration adapter.
 *
 * Supports two modes:
 *   1. Printer proxy — polls a HA template sensor / input_boolean to expose
 *      a virtual printer host.  Set `entity_id` to a sensor or input_boolean
 *      that exposes state "printing" | "paused" | "idle" | "complete" | "error"
 *      and optional attributes: progress (0-100), filename.
 *   2. Outbound webhook notifications — when used as a notification target,
 *      the caller may POST to HA's webhook endpoint directly via the webhook
 *      system; this adapter validates the configured base URL and token.
 *
 * Config keys:
 *   base_url   – e.g. "http://192.168.1.10:8123"
 *   token      – Long-Lived Access Token (redacted on read)
 *   entity_id  – HA entity to read state from (optional; required for getStatus)
 *
 * SSRF notes: HA legitimately lives on LAN/private IPs; allowPrivate: true
 * mirrors the moonraker/prusalink pattern.
 */

function normalizeBaseUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  return raw.trim().replace(/\/+$/, "");
}

function bearerToken(config: IntegrationConfig): string | null {
  const tokenRaw = config.token ?? config.api_key;
  if (typeof tokenRaw !== "string") return null;
  const t = tokenRaw.trim();
  if (!t || t === "****") return null;
  return t;
}

function entityId(config: IntegrationConfig): string | null {
  const raw = config.entity_id ?? config.entityId;
  if (typeof raw !== "string" || !raw.trim()) return null;
  return raw.trim();
}

const MAX_REDIRECTS = 5;

async function drainResponseBody(res: Response): Promise<void> {
  try {
    await res.arrayBuffer();
  } catch {
    /* ignore */
  }
}

/**
 * HA lives on LAN; mirrors moonraker's manual-redirect fetch with SSRF guard
 * on each hop and bearer-token stripping across cross-origin redirects.
 */
async function haFetch(
  url: string,
  config: IntegrationConfig,
  init: RequestInit = {},
): Promise<Response> {
  const token = bearerToken(config);
  const originalOrigin = new URL(url).origin;
  let current = url;
  const signal = init.signal ?? AbortSignal.timeout(30_000);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertSafeOutboundUrl(current, { allowPrivate: true });
    const headers = new Headers(init.headers);
    headers.delete("Authorization");
    if (token && new URL(current).origin === originalOrigin) {
      headers.set("Authorization", `Bearer ${token}`);
    }
    const response = await fetch(current, {
      ...init,
      headers,
      signal,
      redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return response;
      await drainResponseBody(response);
      current = new URL(location, current).toString();
      continue;
    }
    return response;
  }
  throw new Error(`Too many redirects fetching ${url}`);
}

/**
 * Map a raw HA entity state string to PrinterHostState.
 *
 * HA sensors typically use freeform state values; we normalise common
 * printer-proxy patterns.  A sensor that is "unavailable" or "unknown"
 * maps to offline so the UI shows the right icon.
 */
function mapHaState(raw: string | undefined): PrinterHostStatus["state"] {
  const s = (raw ?? "").toLowerCase().trim();
  if (s === "printing") return "printing";
  if (s === "paused") return "paused";
  if (s === "complete" || s === "done" || s === "finished") return "complete";
  if (s === "error" || s === "failure") return "error";
  if (s === "idle" || s === "standby" || s === "ready") return "idle";
  if (s === "unavailable" || s === "unknown" || !s) return "offline";
  // Unrecognised non-empty states (could be a friendly HA state name)
  return "unknown";
}

type HaStateResponse = {
  state?: string;
  attributes?: {
    progress?: number | string;
    filename?: string;
    friendly_name?: string;
    [key: string]: unknown;
  };
};

async function queryEntityStatus(
  config: IntegrationConfig,
): Promise<PrinterHostStatus> {
  const baseUrl = normalizeBaseUrl(config.base_url ?? config.baseUrl);
  if (!baseUrl) return { state: "offline", message: "base_url is required" };
  const eid = entityId(config);
  if (!eid) return { state: "offline", message: "entity_id is required" };
  if (!bearerToken(config)) {
    return { state: "offline", message: "token is required" };
  }

  const url = `${baseUrl}/api/states/${encodeURIComponent(eid)}`;
  const res = await haFetch(url, config, {
    signal: AbortSignal.timeout(10_000),
  });

  if (res.status === 404) {
    return {
      state: "offline",
      message: `Entity '${eid}' not found in Home Assistant`,
    };
  }
  if (!res.ok) {
    return {
      state: "offline",
      message: `Home Assistant returned HTTP ${res.status}`,
    };
  }

  const body = (await res.json()) as HaStateResponse;
  const rawState = body.state;
  const state = mapHaState(rawState);

  const attrs = body.attributes ?? {};
  const rawProgress = attrs.progress;
  const progressNum =
    typeof rawProgress === "number"
      ? rawProgress
      : typeof rawProgress === "string"
        ? parseFloat(rawProgress)
        : NaN;
  const progress =
    Number.isFinite(progressNum)
      ? Math.round(Math.min(100, Math.max(0, progressNum)))
      : undefined;

  const filename =
    typeof attrs.filename === "string" ? attrs.filename.trim() || undefined : undefined;

  return {
    state,
    progress: state === "printing" || state === "paused" ? progress : undefined,
    filename,
    message:
      state === "printing" && filename
        ? `Printing ${filename}`
        : state === "complete"
          ? filename
            ? `Complete · ${filename}`
            : "Complete"
          : state === "idle"
            ? "Idle"
            : state === "offline"
              ? (rawState ?? "Offline")
              : rawState,
  };
}

export const homeAssistantAdapter: IntegrationAdapter = {
  type: "home_assistant",

  async testConnection(config: IntegrationConfig): Promise<IntegrationTestResult> {
    const baseUrl = normalizeBaseUrl(config.base_url ?? config.baseUrl);
    if (!baseUrl) {
      return { ok: false, message: "base_url is required" };
    }
    const token = bearerToken(config);
    if (!token) {
      return { ok: false, message: "token (Long-Lived Access Token) is required" };
    }
    try {
      // /api/ returns minimal JSON: {"message":"API running."}
      const res = await haFetch(`${baseUrl}/api/`, config, {
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) {
        if (res.status === 401) {
          return { ok: false, message: "Unauthorized — check your Long-Lived Access Token" };
        }
        return {
          ok: false,
          message: `Home Assistant returned HTTP ${res.status}`,
        };
      }
      const body = (await res.json()) as { message?: string; version?: string };
      const versionPart = body.version ? ` (HA ${body.version})` : "";

      // Optionally verify entity_id is readable if provided
      const eid = entityId(config);
      if (eid) {
        const stateRes = await haFetch(
          `${baseUrl}/api/states/${encodeURIComponent(eid)}`,
          config,
          { signal: AbortSignal.timeout(8_000) },
        ).catch(() => null);
        if (!stateRes) {
          return {
            ok: true,
            message: `Connected${versionPart} (entity '${eid}' unreachable)`,
          };
        }
        if (stateRes.status === 404) {
          return {
            ok: false,
            message: `Connected but entity '${eid}' was not found`,
          };
        }
        if (!stateRes.ok) {
          return {
            ok: true,
            message: `Connected${versionPart} (entity check returned HTTP ${stateRes.status})`,
          };
        }
        const stateBody = (await stateRes.json()) as HaStateResponse;
        const state = stateBody.state ?? "unknown";
        return {
          ok: true,
          message: `Connected${versionPart} · ${eid}: ${state}`,
        };
      }

      return { ok: true, message: `Connected${versionPart}` };
    } catch (e) {
      return {
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      };
    }
  },

  async listDevices(config: IntegrationConfig) {
    const baseUrl = normalizeBaseUrl(config.base_url ?? config.baseUrl);
    if (!baseUrl || !bearerToken(config)) return [];
    try {
      const eid = entityId(config);
      if (!eid) return [];
      const status = await queryEntityStatus(config);
      return [
        {
          id: eid,
          name: `Home Assistant · ${eid}`,
          type: "home_assistant",
          status: status.state,
        },
      ];
    } catch {
      return [];
    }
  },

  async getStatus(config: IntegrationConfig): Promise<PrinterHostStatus> {
    try {
      return await queryEntityStatus(config);
    } catch (e) {
      return {
        state: "offline",
        message: e instanceof Error ? e.message : String(e),
      };
    }
  },

  /**
   * uploadFile is not natively supported by Home Assistant.
   * However, if the user configures a `webhook_id` we POST the file to
   * HA's webhook endpoint so an automation can handle it.
   * This is a best-effort integration; HA does not return status
   * like a printer API does.
   */
  async uploadFile(
    config: IntegrationConfig,
    source: PrinterUploadSource,
    filename: string,
    _options?: { start?: boolean },
  ): Promise<PrinterUploadResult> {
    const baseUrl = normalizeBaseUrl(config.base_url ?? config.baseUrl);
    if (!baseUrl) {
      return { ok: false, message: "base_url is required" };
    }
    const webhookId =
      typeof config.webhook_id === "string" ? config.webhook_id.trim() : "";
    if (!webhookId) {
      return {
        ok: false,
        message:
          "webhook_id is required for file uploads to Home Assistant. " +
          "Create a webhook automation in HA and set webhook_id.",
      };
    }

    const safeName = filename.replace(/[/\\]/g, "_").trim() || "print.gcode";
    try {
      const form = new FormData();
      if (source instanceof Uint8Array) {
        form.append("file", new Blob([Buffer.from(source)]), safeName);
      } else {
        const { openAsBlob } = await import("node:fs");
        const blob = await openAsBlob(source.path);
        form.append("file", blob, safeName);
      }
      form.append("filename", safeName);

      // HA webhooks do not require auth headers (webhook URL is the secret)
      const webhookUrl = `${baseUrl}/api/webhook/${encodeURIComponent(webhookId)}`;
      await assertSafeOutboundUrl(webhookUrl, { allowPrivate: true });

      const res = await fetch(webhookUrl, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(60_000),
      });

      // HA webhooks return 200 OK with an empty body on success when the
      // automation fires, or 200 with {} if no one is listening.
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return {
          ok: false,
          message: `HA webhook returned HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
        };
      }

      return {
        ok: true,
        remote_path: safeName,
        started: false,
        message: `Sent ${safeName} to Home Assistant webhook`,
      };
    } catch (e) {
      return {
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      };
    }
  },
};
