/**
 * Slicer Sidecar integration adapter.
 *
 * The sidecar is a small HTTP companion service that runs on the same host as
 * the slicer CLI (OrcaSlicer, PrusaSlicer, BambuStudio). PP sends a plate 3MF
 * plus resolved profile JSON, the sidecar invokes the CLI, and returns the
 * gcode + thumbnail.
 *
 * Two wire protocols are supported:
 *
 *  - v1 (preferred, slicer_sidecar service): POST <url>/v1/slice with fields
 *    file / slicer / resolved_flat_configs / timeout_s, answering with
 *    {ok, meta, gcode_filename, gcode_base64, thumbnail_filename, thumbnail_base64}
 *    or an {ok:false, error:{code,message,details}} envelope. This is the one
 *    the per-printer routing flow uses because it carries the slicer selector
 *    and PP's resolved_flat_configs verbatim.
 *  - legacy (slicer-sidecar/sidecar.py): POST <url>/slice with
 *    model / machine_config / process_config / filament_configs, answering with
 *    {gcode, thumbnail, filename} base64 JSON.
 *
 * Config fields:
 *   url      - Base URL of the sidecar HTTP service.
 *              On the host, http://localhost:2814. From the Print Partner
 *              Compose service, http://slicer-sidecar-orca:2814 (the sidecar
 *              only exposes 2814 on the Compose network).
 *   slicer   - Which CLI the sidecar wraps: "orca" | "prusa" | "bambu"
 *   api      - Optional protocol pin: "v1" | "legacy" (default: try v1, fall back)
 */

import type { IntegrationConfig, IntegrationTestResult } from "@print-partner/contracts";
import type { IntegrationAdapter } from "../store.js";
import { safeConnectorFetch } from "../../lib/outbound-url.js";
import {
  cancelResponseBody,
  readBoundedResponseBody,
  ResponseBodyTooLargeError,
} from "../../lib/bounded-response.js";

const MAX_CONTROL_RESPONSE_BYTES = 64 * 1024;

/**
 * Fetch the sidecar with Connection: close.
 * Retries once on transient socket errors for idempotent GET/HEAD only —
 * never retry POST /slice (would start a second concurrent CLI run).
 */
async function fetchSidecar(url: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  // Prefer closing the connection after each call so undici does not reuse a
  // half-closed socket left by a previous long-running slice.
  headers.set("Connection", "close");
  const next: RequestInit = { ...init, headers };
  const method = (init.method ?? "GET").toUpperCase();
  const canRetry = method === "GET" || method === "HEAD";
  try {
    return await safeConnectorFetch(url, next);
  } catch (err) {
    if (!canRetry) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    const transient =
      /ECONNRESET|ECONNREFUSED|socket hang up|fetch failed|network/i.test(msg) ||
      (err instanceof TypeError && /fetch/i.test(msg));
    if (!transient) throw err;
    return await safeConnectorFetch(url, next);
  }
}

/** Structured sidecar failure so callers can surface code + message in the UI. */
class SlicerSidecarError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly details: Record<string, unknown>;

  constructor(
    message: string,
    options: { code?: string; status?: number | null; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "SlicerSidecarError";
    this.code = options.code ?? "sidecar_error";
    this.status = options.status ?? null;
    this.details = options.details ?? {};
  }
}

function normUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  return raw.trim().replace(/\/+$/, "");
}

function healthResponseIsHealthy(body: unknown): boolean {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  const hasPositiveSignal =
    ("ok" in body && body.ok === true) ||
    ("status" in body && body.status === "ok");
  return (
    hasPositiveSignal &&
    (!("ok" in body) || body.ok !== false) &&
    (!("status" in body) || body.status !== "unhealthy") &&
    (!("exists" in body) || body.exists !== false) &&
    (!("executable" in body) || body.executable !== false)
  );
}

async function readSidecarBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  try {
    return await readBoundedResponseBody(response, maxBytes);
  } catch (error) {
    if (error instanceof ResponseBodyTooLargeError) {
      throw new SlicerSidecarError(`Slicer sidecar response exceeds ${maxBytes} bytes`, {
        code: "response_too_large",
        status: response.status,
      });
    }
    throw error;
  }
}

async function readSidecarJson(response: Response, maxBytes: number): Promise<unknown> {
  const bytes = await readSidecarBody(response, maxBytes);
  return JSON.parse(new TextDecoder().decode(bytes));
}

export const slicerSidecarAdapter: IntegrationAdapter = {
  type: "slicer_sidecar",

  async testConnection(config: IntegrationConfig): Promise<IntegrationTestResult> {
    const base = normUrl(config.url);
    if (!base) return { ok: false, message: "url is required (e.g. http://localhost:2814)" };
    const slicer = typeof config.slicer === "string" ? config.slicer : "orca";

    // v1 exposes /healthz, the legacy sidecar exposes /health. Probe both so a
    // correctly configured service of either generation tests green.
    const attempts: Array<{ path: string; protocol: string }> = [
      { path: "/healthz", protocol: "v1" },
      { path: "/health", protocol: "legacy" },
    ];
    let lastMessage = "Sidecar unreachable";
    for (const attempt of attempts) {
      const healthUrl = `${base}${attempt.path}`;
      try {
        const res = await fetchSidecar(healthUrl, {
          method: "GET",
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          await cancelResponseBody(res);
          lastMessage = `Sidecar returned HTTP ${res.status}`;
          continue;
        }

        const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
        if (!contentType.includes("application/json")) {
          await cancelResponseBody(res);
          return { ok: true, message: `Slicer sidecar reachable (${slicer}, ${attempt.protocol})` };
        }

        let body: unknown;
        try {
          body = await readSidecarJson(res, MAX_CONTROL_RESPONSE_BYTES);
        } catch {
          lastMessage = "Sidecar returned an invalid JSON health response";
          continue;
        }
        if (healthResponseIsHealthy(body)) {
          return { ok: true, message: `Slicer sidecar reachable (${slicer}, ${attempt.protocol})` };
        }
        lastMessage = "Sidecar health check reported unhealthy";
      } catch (e) {
        lastMessage = e instanceof Error ? e.message : String(e);
      }
    }
    return { ok: false, message: lastMessage };
  },
};
