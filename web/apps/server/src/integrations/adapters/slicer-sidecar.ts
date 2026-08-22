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
 *   url      - Base URL of the sidecar HTTP service, e.g. http://localhost:2814
 *   slicer   - Which CLI the sidecar wraps: "orca" | "prusa" | "bambu"
 *   api      - Optional protocol pin: "v1" | "legacy" (default: try v1, fall back)
 */

import type { IntegrationConfig, IntegrationTestResult } from "@print-partner/contracts";
import type { IntegrationAdapter } from "../store.js";
import { assertSafeOutboundUrl } from "../../lib/outbound-url.js";

export type SlicerKind = "orca" | "prusa" | "bambu";

export const SLICER_KINDS: readonly SlicerKind[] = ["orca", "prusa", "bambu"] as const;

export function isSlicerKind(value: unknown): value is SlicerKind {
  return typeof value === "string" && (SLICER_KINDS as readonly string[]).includes(value);
}

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
    return await fetch(url, next);
  } catch (err) {
    if (!canRetry) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    const transient =
      /ECONNRESET|ECONNREFUSED|socket hang up|fetch failed|network/i.test(msg) ||
      (err instanceof TypeError && /fetch/i.test(msg));
    if (!transient) throw err;
    return await fetch(url, next);
  }
}

export type SliceRequest = {
  /** Raw bytes of the plate 3MF file. */
  model: Uint8Array;
  /** Filename to advertise for the uploaded plate (defaults to plate.3mf). */
  filename?: string;
  /** Which slicer the sidecar should run (v1 protocol). */
  slicer?: SlicerKind;
  /**
   * PP's inheritance-resolved flat config docs keyed by role, e.g.
   * {machine: {...}, process: {...}, filament: {...}} (v1 protocol).
   */
  resolved_flat_configs?: Record<string, Record<string, unknown>>;
  /** Slice timeout in seconds (v1 protocol). Defaults to 300. */
  timeout_s?: number;
  /** Legacy protocol: machine.json content */
  machine_config?: Record<string, unknown>;
  /** Legacy protocol: process.json content */
  process_config?: Record<string, unknown>;
  /** Legacy protocol: array of filament config objects */
  filament_configs?: Array<Record<string, unknown>>;
};

export type SliceResult = {
  /** Gcode file bytes. */
  gcode: Uint8Array;
  /** Plate thumbnail PNG bytes (may be empty if sidecar did not produce one). */
  thumbnail: Uint8Array;
  /** Filename suggested by the sidecar (optional). */
  filename?: string;
  /** Thumbnail filename suggested by the sidecar, e.g. plate_1.png (optional). */
  thumbnail_filename?: string;
  /** Which protocol answered — useful in job metadata. */
  protocol?: "v1" | "legacy";
  /** Non-fatal notes reported by the sidecar. */
  warnings?: string[];
};

/** Structured sidecar failure so callers can surface code + message in the UI. */
export class SlicerSidecarError extends Error {
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

/**
 * Flatten a sidecar failure into the pieces a caller wants to log and show.
 *
 * The sidecar reports a CLI failure as `slicer_execution_failed` with the
 * process's `exit_code` and captured `stderr` in `error.details` — that stderr
 * is the only place the actual reason ("unknown config option", "invalid
 * printable_area", …) appears, so it has to reach the user rather than being
 * swallowed behind a generic "orca-slicer exited with code 1".
 */
export function describeSidecarError(e: unknown): {
  message: string;
  code: string;
  exitCode: number | null;
  stderr: string | null;
} {
  const message = e instanceof Error ? e.message : String(e);
  if (!(e instanceof SlicerSidecarError)) {
    return { message, code: "slice_failed", exitCode: null, stderr: null };
  }
  const rawStderr = e.details.stderr;
  const stderr = typeof rawStderr === "string" && rawStderr.trim() ? rawStderr.trim() : null;
  const rawExit = e.details.exit_code;
  const exitCode = typeof rawExit === "number" && Number.isFinite(rawExit) ? rawExit : null;
  return { message, code: e.code, exitCode, stderr };
}

/** Last `maxLines` non-blank lines of a CLI stderr blob, for a one-glance summary. */
export function stderrTail(stderr: string | null | undefined, maxLines = 6): string | null {
  if (!stderr) return null;
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
  if (!lines.length) return null;
  return lines.slice(-maxLines).join("\n");
}

function normUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  return raw.trim().replace(/\/+$/, "");
}

function toBlob(bytes: Uint8Array): Blob {
  return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/octet-stream" });
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Read an {ok:false, error:{...}} envelope, tolerating non-JSON bodies. */
async function sidecarErrorFromResponse(res: Response): Promise<SlicerSidecarError> {
  const text = await res.text().catch(() => "");
  try {
    const body = JSON.parse(text) as {
      error?: { code?: string; message?: string; details?: Record<string, unknown> };
    };
    if (body?.error?.message) {
      return new SlicerSidecarError(body.error.message, {
        code: body.error.code ?? "sidecar_error",
        status: res.status,
        details: body.error.details ?? {},
      });
    }
  } catch {
    /* not a JSON envelope — fall through to the raw-text form */
  }
  return new SlicerSidecarError(
    `Slicer sidecar returned HTTP ${res.status}: ${text.slice(0, 200)}`,
    { code: "http_error", status: res.status },
  );
}

/** POST the v1 multipart contract (`/v1/slice`). */
async function sliceV1(base: string, req: SliceRequest): Promise<SliceResult> {
  const endpoint = `${base}/v1/slice`;
  await assertSafeOutboundUrl(endpoint, { allowPrivate: true });

  const timeoutS = req.timeout_s ?? 300;
  const form = new FormData();
  form.append("file", toBlob(req.model), req.filename ?? "plate.3mf");
  form.append("slicer", req.slicer ?? "orca");
  form.append("resolved_flat_configs", JSON.stringify(req.resolved_flat_configs ?? {}));
  form.append("timeout_s", String(timeoutS));

  const res = await fetchSidecar(endpoint, {
    method: "POST",
    body: form,
    // Give the HTTP call slack over the slicer's own budget so a slicer
    // timeout comes back as a structured 504 rather than an aborted socket.
    signal: AbortSignal.timeout(Math.round((timeoutS + 30) * 1000)),
  });

  if (!res.ok) throw await sidecarErrorFromResponse(res);

  const json = (await res.json()) as {
    ok?: boolean;
    meta?: { warnings?: string[] };
    gcode_base64?: string;
    gcode_filename?: string;
    thumbnail_base64?: string;
    thumbnail_filename?: string;
  };
  if (json.ok === false) {
    throw new SlicerSidecarError("Slicer sidecar reported failure", {
      code: "sidecar_error",
      status: res.status,
    });
  }
  const gcode = json.gcode_base64 ? base64ToBytes(json.gcode_base64) : new Uint8Array(0);
  if (!gcode.length) {
    throw new SlicerSidecarError("Slicer sidecar returned no gcode", {
      code: "empty_gcode",
      status: res.status,
    });
  }
  return {
    gcode,
    thumbnail: json.thumbnail_base64 ? base64ToBytes(json.thumbnail_base64) : new Uint8Array(0),
    ...(json.gcode_filename ? { filename: json.gcode_filename } : {}),
    ...(json.thumbnail_filename ? { thumbnail_filename: json.thumbnail_filename } : {}),
    protocol: "v1",
    warnings: json.meta?.warnings ?? [],
  };
}

/** POST the legacy multipart contract (`/slice`). */
async function sliceLegacy(base: string, req: SliceRequest): Promise<SliceResult> {
  const endpoint = `${base}/slice`;
  await assertSafeOutboundUrl(endpoint, { allowPrivate: true });

  // Map the v1-shaped settings onto the legacy machine/process/filament split
  // so a caller only has to build resolved_flat_configs once.
  const resolved = req.resolved_flat_configs ?? {};
  const machine = req.machine_config ?? resolved.machine;
  const process = req.process_config ?? resolved.process;
  const filaments =
    req.filament_configs ??
    Object.entries(resolved)
      .filter(([key]) => key.toLowerCase().includes("filament"))
      .map(([, value]) => value);

  const form = new FormData();
  form.append("model", toBlob(req.model), req.filename ?? "plate.3mf");
  if (machine) form.append("machine_config", JSON.stringify(machine));
  if (process) form.append("process_config", JSON.stringify(process));
  if (filaments?.length) form.append("filament_configs", JSON.stringify(filaments));

  const res = await fetchSidecar(endpoint, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(Math.round(((req.timeout_s ?? 300) + 30) * 1000)),
  });

  if (!res.ok) throw await sidecarErrorFromResponse(res);

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/zip") || contentType.includes("application/octet-stream")) {
    return { ...extractSliceZip(new Uint8Array(await res.arrayBuffer())), protocol: "legacy" };
  }
  if (contentType.includes("application/json")) {
    const json = (await res.json()) as {
      gcode?: string;
      thumbnail?: string;
      filename?: string;
    };
    return {
      gcode: json.gcode ? base64ToBytes(json.gcode) : new Uint8Array(0),
      thumbnail: json.thumbnail ? base64ToBytes(json.thumbnail) : new Uint8Array(0),
      ...(json.filename ? { filename: json.filename } : {}),
      protocol: "legacy",
    };
  }
  // Fall back: treat entire body as raw gcode
  return {
    gcode: new Uint8Array(await res.arrayBuffer()),
    thumbnail: new Uint8Array(0),
    protocol: "legacy",
  };
}

/**
 * Slice a plate through the sidecar.
 *
 * Protocol selection: `config.api` pins it explicitly, otherwise v1 is tried
 * first and a 404/405 (endpoint absent) transparently retries the legacy
 * `/slice` route so existing sidecar deployments keep working.
 */
export async function slicerSidecarSlice(
  config: IntegrationConfig,
  req: SliceRequest,
): Promise<SliceResult> {
  const base = normUrl(config.url);
  if (!base) throw new SlicerSidecarError("Slicer sidecar URL not configured", { code: "no_url" });

  const pinned = typeof config.api === "string" ? config.api.toLowerCase() : null;
  if (pinned === "legacy") return sliceLegacy(base, req);
  if (pinned === "v1") return sliceV1(base, req);

  try {
    return await sliceV1(base, req);
  } catch (e) {
    const endpointMissing =
      e instanceof SlicerSidecarError && (e.status === 404 || e.status === 405);
    if (!endpointMissing) throw e;
    return sliceLegacy(base, req);
  }
}

/**
 * Extract gcode and thumbnail from a ZIP returned by the sidecar.
 * Expects the OrcaSlicer output ZIP which contains:
 *   - *.gcode (or Metadata/*.gcode inside the gcode.3mf)
 *   - Metadata/plate_N.png
 * We use a simple streaming scan rather than pulling in a zip library.
 */
function extractSliceZip(buf: Uint8Array): SliceResult {
  // Dynamically import fflate (already in the project via domain package)
  // For server-side use we use the synchronous unzipSync from fflate.
  // We do a best-effort extraction here; if fflate is absent we return raw buf as gcode.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { unzipSync } = require("fflate") as { unzipSync: (data: Uint8Array) => Record<string, Uint8Array> };
    const files = unzipSync(buf);
    let gcode = new Uint8Array(0);
    let thumbnail = new Uint8Array(0);
    let thumbnailName: string | undefined;
    for (const [name, data] of Object.entries(files)) {
      if (name.endsWith(".gcode") || name.endsWith(".bgcode")) {
        if (!gcode.length || data.length > gcode.length) gcode = data as Uint8Array<ArrayBuffer>;
      }
      if (/plate_\d+\.png$/i.test(name)) {
        thumbnail = data as Uint8Array<ArrayBuffer>;
        thumbnailName = name.split("/").pop();
      }
    }
    return { gcode, thumbnail, ...(thumbnailName ? { thumbnail_filename: thumbnailName } : {}) };
  } catch {
    // Couldn't unzip — return the whole buffer as gcode (best effort).
    return { gcode: buf, thumbnail: new Uint8Array(0) };
  }
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
        await assertSafeOutboundUrl(healthUrl, { allowPrivate: true });
        const res = await fetchSidecar(healthUrl, {
          method: "GET",
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) {
          return { ok: true, message: `Slicer sidecar reachable (${slicer}, ${attempt.protocol})` };
        }
        lastMessage = `Sidecar returned HTTP ${res.status}`;
      } catch (e) {
        lastMessage = e instanceof Error ? e.message : String(e);
      }
    }
    return { ok: false, message: lastMessage };
  },
};
