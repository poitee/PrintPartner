import type {
  IntegrationConfig,
  IntegrationTestResult,
  PrinterCamera,
  PrinterHostStatus,
  PrinterStoredFile,
  PrinterUploadResult,
} from "@print-partner/contracts";
import type { IntegrationAdapter, PrinterUploadSource } from "../store.js";
import { assertSafeOutboundUrl } from "../../lib/outbound-url.js";

function normalizeBaseUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  return raw.trim().replace(/\/+$/, "");
}

function authHeaders(config: IntegrationConfig): Record<string, string> {
  const apiKeyRaw = config.api_key ?? config.apiKey;
  if (typeof apiKeyRaw !== "string") return {};
  const key = apiKeyRaw.trim();
  if (!key || key === "****") return {};
  // Moonraker API keys use X-Api-Key; JWTs use Authorization Bearer (three base64url segments).
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key)) {
    return { Authorization: `Bearer ${key}` };
  }
  return { "X-Api-Key": key };
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
 * Moonraker legitimately lives on LAN/private IPs; metadata endpoints stay blocked.
 * Follows redirects manually: each Location is SSRF-checked, and auth headers are
 * not forwarded across cross-origin hops.
 */
async function moonrakerFetch(
  url: string,
  config: IntegrationConfig,
  init: RequestInit = {},
  credentialOrigin = new URL(url).origin,
): Promise<Response> {
  const auth = authHeaders(config);
  let current = url;
  const signal = init.signal ?? AbortSignal.timeout(30_000);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertSafeOutboundUrl(current, { allowPrivate: true });
    const headers = new Headers(init.headers);
    headers.delete("Authorization");
    headers.delete("X-Api-Key");
    if (new URL(current).origin === credentialOrigin) {
      for (const [k, v] of Object.entries(auth)) {
        if (!headers.has(k)) headers.set(k, v);
      }
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

function safeRelativePath(raw: string): string | null {
  const normalized = raw.replace(/\\/g, "/").replace(/^\/+/, "");
  const segments = normalized.split("/");
  if (
    !normalized ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return null;
  }
  return segments.join("/");
}

function encodedPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

async function listStoredFiles(config: IntegrationConfig): Promise<PrinterStoredFile[]> {
  const baseUrl = normalizeBaseUrl(config.base_url ?? config.baseUrl);
  if (!baseUrl) throw new Error("base_url is required");
  const response = await moonrakerFetch(
    `${baseUrl}/server/files/list?root=gcodes`,
    config,
    { signal: AbortSignal.timeout(15_000) },
  );
  if (!response.ok) {
    throw new Error(`Moonraker file list returned HTTP ${response.status}`);
  }
  const body = await response.json() as unknown;
  if (!Array.isArray(body)) return [];
  return body.flatMap((value): PrinterStoredFile[] => {
    if (!value || typeof value !== "object") return [];
    const row = value as Record<string, unknown>;
    const path = typeof row.path === "string" ? safeRelativePath(row.path) : null;
    if (!path) return [];
    const modified = typeof row.modified === "number" && Number.isFinite(row.modified)
      ? new Date(row.modified * 1_000).toISOString()
      : undefined;
    const size = typeof row.size === "number" && Number.isFinite(row.size) && row.size >= 0
      ? Math.round(row.size)
      : undefined;
    return [{
      id: path,
      path,
      filename: path.split("/").at(-1) ?? path,
      ...(size === undefined ? {} : { size_bytes: size }),
      ...(modified === undefined ? {} : { modified_at: modified }),
    }];
  });
}

type MoonrakerWebcam = {
  uid?: unknown;
  name?: unknown;
  service?: unknown;
  enabled?: unknown;
  stream_url?: unknown;
  snapshot_url?: unknown;
  aspect_ratio?: unknown;
};

async function readWebcams(config: IntegrationConfig): Promise<MoonrakerWebcam[]> {
  const baseUrl = normalizeBaseUrl(config.base_url ?? config.baseUrl);
  if (!baseUrl) throw new Error("base_url is required");
  const response = await moonrakerFetch(
    `${baseUrl}/server/webcams/list`,
    config,
    { signal: AbortSignal.timeout(10_000) },
  );
  if (!response.ok) {
    if (response.status === 404) return [];
    throw new Error(`Moonraker webcam list returned HTTP ${response.status}`);
  }
  const body = await response.json() as { webcams?: unknown };
  return Array.isArray(body.webcams) ? body.webcams as MoonrakerWebcam[] : [];
}

function cameraId(camera: MoonrakerWebcam, index: number): string {
  const uid = typeof camera.uid === "string" ? camera.uid.trim() : "";
  return uid || `camera-${index}`;
}

function supportsMjpeg(service: string, streamUrl: string): boolean {
  const normalized = service.toLowerCase();
  return normalized.includes("mjpeg") || normalized.includes("ustreamer") || /action=stream/i.test(streamUrl);
}

async function listCameras(config: IntegrationConfig): Promise<PrinterCamera[]> {
  const cameras = await readWebcams(config);
  return cameras.flatMap((camera, index): PrinterCamera[] => {
    if (camera.enabled === false) return [];
    const streamUrl = typeof camera.stream_url === "string" ? camera.stream_url.trim() : "";
    const snapshotUrl = typeof camera.snapshot_url === "string" ? camera.snapshot_url.trim() : "";
    const service = typeof camera.service === "string" ? camera.service.trim() : "";
    const view = streamUrl && supportsMjpeg(service, streamUrl)
      ? "mjpeg"
      : snapshotUrl
        ? "snapshot"
        : null;
    if (!view) return [];
    const name = typeof camera.name === "string" && camera.name.trim()
      ? camera.name.trim()
      : `Camera ${index + 1}`;
    const aspectRatio = typeof camera.aspect_ratio === "string" && camera.aspect_ratio.trim()
      ? camera.aspect_ratio.trim()
      : undefined;
    return [{
      id: cameraId(camera, index),
      name,
      view,
      ...(service ? { service } : {}),
      ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
    }];
  });
}

function mapPrintState(raw: string | undefined): PrinterHostStatus["state"] {
  const state = (raw ?? "").toLowerCase();
  if (state === "printing") return "printing";
  if (state === "paused") return "paused";
  if (state === "complete") return "complete";
  if (state === "error") return "error";
  // cancelled / standby → idle (must not auto-checkoff)
  if (state === "standby" || state === "cancelled") return "idle";
  if (!state) return "unknown";
  // Unrecognized non-empty states are not "ready to start"
  return "unknown";
}

async function querySystemUptime(baseUrl: string, config: IntegrationConfig): Promise<number | undefined> {
  try {
    const response = await moonrakerFetch(`${baseUrl}/machine/proc_stats`, config);
    if (!response.ok) return undefined;
    const body = await response.json() as { result?: { system_uptime?: unknown } };
    const value = body.result?.system_uptime;
    return typeof value === "number" && Number.isFinite(value) && value >= 0
      ? Math.round(value)
      : undefined;
  } catch {
    return undefined;
  }
}

async function queryStatus(config: IntegrationConfig): Promise<PrinterHostStatus> {
  const baseUrl = normalizeBaseUrl(config.base_url ?? config.baseUrl);
  if (!baseUrl) return { state: "offline", message: "base_url is required" };

  const objects = "print_stats&virtual_sdcard&display_status&extruder&heater_bed";
  const res = await moonrakerFetch(
    `${baseUrl}/printer/objects/query?${objects}`,
    config,
  );
  if (!res.ok) {
    return { state: "offline", message: `Moonraker returned HTTP ${res.status}` };
  }
  const body = (await res.json()) as {
    result?: {
      status?: {
        print_stats?: { state?: string; filename?: string };
        virtual_sdcard?: { progress?: number };
        display_status?: { progress?: number };
        extruder?: { temperature?: number; target?: number };
        heater_bed?: { temperature?: number; target?: number };
      };
    };
  };
  const status = body.result?.status;
  const printStats = status?.print_stats;
  const progressFraction =
    status?.virtual_sdcard?.progress ?? status?.display_status?.progress;
  const progress =
    typeof progressFraction === "number" && Number.isFinite(progressFraction)
      ? Math.round(Math.min(100, Math.max(0, progressFraction * 100)))
      : undefined;
  const filename = printStats?.filename?.trim() || undefined;
  const state = mapPrintState(printStats?.state);
  const uptimeSeconds = await querySystemUptime(baseUrl, config);
  return {
    state,
    progress: state === "printing" || state === "paused" ? progress : undefined,
    filename,
    ip_address: new URL(baseUrl).hostname,
    uptime_seconds: uptimeSeconds,
    nozzle_temperature_c: status?.extruder?.temperature,
    nozzle_target_c: status?.extruder?.target,
    bed_temperature_c: status?.heater_bed?.temperature,
    bed_target_c: status?.heater_bed?.target,
    message:
      state === "printing" && filename
        ? `Printing ${filename}`
        : state === "complete"
          ? filename
            ? `Complete · ${filename}`
            : "Complete"
          : state === "idle"
            ? "Idle"
            : printStats?.state,
  };
}

async function fetchObjectList(config: IntegrationConfig): Promise<string[]> {
  const baseUrl = normalizeBaseUrl(config.base_url ?? config.baseUrl);
  if (!baseUrl) return [];
  try {
    const res = await moonrakerFetch(
      `${baseUrl}/printer/objects/query?exclude_object`,
      config,
      { signal: AbortSignal.timeout(8_000) },
    );
    if (!res.ok) return [];
    const body = (await res.json()) as {
      result?: {
        status?: {
          exclude_object?: {
            objects?: Array<{ name?: string }>;
          };
        };
      };
    };
    const objects = body.result?.status?.exclude_object?.objects;
    if (!Array.isArray(objects)) return [];
    return objects
      .map((o) => (typeof o.name === "string" ? o.name.trim() : ""))
      .filter((n) => n.length > 0);
  } catch {
    return [];
  }
}

export const moonrakerAdapter: IntegrationAdapter = {
  type: "moonraker",

  files: {
    list: listStoredFiles,
    async open(config, fileId) {
      const baseUrl = normalizeBaseUrl(config.base_url ?? config.baseUrl);
      const path = safeRelativePath(fileId);
      if (!baseUrl || !path) throw new Error("Invalid Moonraker print-file path");
      return moonrakerFetch(
        `${baseUrl}/server/files/gcodes/${encodedPath(path)}`,
        config,
        { signal: AbortSignal.timeout(120_000) },
      );
    },
  },

  cameras: {
    list: listCameras,
    async open(config, requestedId) {
      const baseUrl = normalizeBaseUrl(config.base_url ?? config.baseUrl);
      if (!baseUrl) throw new Error("base_url is required");
      const cameras = await readWebcams(config);
      const entry = cameras.find((camera, index) => cameraId(camera, index) === requestedId);
      if (!entry || entry.enabled === false) throw new Error("Camera not found");
      const streamUrl = typeof entry.stream_url === "string" ? entry.stream_url.trim() : "";
      const snapshotUrl = typeof entry.snapshot_url === "string" ? entry.snapshot_url.trim() : "";
      const service = typeof entry.service === "string" ? entry.service.trim() : "";
      const selected = streamUrl && supportsMjpeg(service, streamUrl) ? streamUrl : snapshotUrl;
      if (!selected) throw new Error("Camera has no browser-compatible view");
      const url = new URL(selected, `${baseUrl}/`).toString();
      return moonrakerFetch(
        url,
        config,
        { signal: AbortSignal.timeout(10 * 60_000) },
        new URL(baseUrl).origin,
      );
    },
  },

  async testConnection(config: IntegrationConfig): Promise<IntegrationTestResult> {
    const baseUrl = normalizeBaseUrl(config.base_url ?? config.baseUrl);
    if (!baseUrl) {
      return { ok: false, message: "base_url is required" };
    }
    try {
      const res = await moonrakerFetch(`${baseUrl}/server/info`, config, {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        return { ok: false, message: `Moonraker returned HTTP ${res.status}` };
      }
      const body = (await res.json()) as { result?: { klippy_state?: string } };
      const state = body.result?.klippy_state ?? "unknown";
      return { ok: true, message: `Connected (klippy: ${state})` };
    } catch (e) {
      return {
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      };
    }
  },

  async listDevices(config: IntegrationConfig) {
    const baseUrl = normalizeBaseUrl(config.base_url ?? config.baseUrl);
    if (!baseUrl) return [];
    try {
      const status = await queryStatus(config);
      return [
        {
          id: "default",
          name: "Moonraker printer",
          type: "moonraker",
          status: status.state,
        },
      ];
    } catch {
      return [];
    }
  },

  async getStatus(config: IntegrationConfig): Promise<PrinterHostStatus> {
    try {
      return await queryStatus(config);
    } catch (e) {
      return {
        state: "offline",
        message: e instanceof Error ? e.message : String(e),
      };
    }
  },

  async getObjectList(config: IntegrationConfig): Promise<string[]> {
    return fetchObjectList(config);
  },

  async getFilamentUsed(config: IntegrationConfig): Promise<number | null> {
    const baseUrl = normalizeBaseUrl(config.base_url ?? config.baseUrl);
    if (!baseUrl) return null;
    try {
      const res = await moonrakerFetch(
        `${baseUrl}/printer/objects/query?print_stats`,
        config,
        { signal: AbortSignal.timeout(8_000) },
      );
      if (!res.ok) return null;
      const body = (await res.json()) as {
        result?: { status?: { print_stats?: { filament_used?: number } } };
      };
      const used = body.result?.status?.print_stats?.filament_used;
      if (typeof used === "number" && Number.isFinite(used) && used >= 0) {
        return used;
      }
      return null;
    } catch {
      return null;
    }
  },

  async uploadFile(
    config: IntegrationConfig,
    source: PrinterUploadSource,
    filename: string,
    options?: { start?: boolean },
  ): Promise<PrinterUploadResult> {
    const baseUrl = normalizeBaseUrl(config.base_url ?? config.baseUrl);
    if (!baseUrl) {
      return { ok: false, message: "base_url is required" };
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
      form.append("root", "gcodes");

      const uploadUrl = `${baseUrl}/server/files/upload`;
      const uploadRes = await moonrakerFetch(uploadUrl, config, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(120_000),
      });
      if (!uploadRes.ok) {
        const text = await uploadRes.text().catch(() => "");
        return {
          ok: false,
          message: `Upload failed (HTTP ${uploadRes.status})${text ? `: ${text.slice(0, 200)}` : ""}`,
        };
      }

      let started = false;
      if (options?.start) {
        const startUrl = `${baseUrl}/printer/print/start?filename=${encodeURIComponent(safeName)}`;
        const startRes = await moonrakerFetch(startUrl, config, {
          method: "POST",
          signal: AbortSignal.timeout(15_000),
        });
        if (!startRes.ok) {
          const text = await startRes.text().catch(() => "");
          return {
            ok: true,
            remote_path: safeName,
            started: false,
            message: `Uploaded, but start failed (HTTP ${startRes.status})${text ? `: ${text.slice(0, 200)}` : ""}`,
          };
        }
        started = true;
      }

      return {
        ok: true,
        remote_path: safeName,
        started,
        message: started ? `Uploaded and started ${safeName}` : `Uploaded ${safeName}`,
      };
    } catch (e) {
      return {
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      };
    }
  },
};
