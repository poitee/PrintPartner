import type {
  IntegrationConfig,
  IntegrationTestResult,
  PrinterCamera,
  PrinterHostStatus,
  PrinterStorageEntry,
  PrinterStorageListing,
  PrinterUploadResult,
} from "@print-partner/contracts";
import type { IntegrationAdapter, PrinterUploadSource } from "../store.js";
import { assertSafeOutboundUrl } from "../../lib/outbound-url.js";
import {
  encodeStoragePath,
  joinStoragePath,
  safeStoragePath,
} from "./storage-path.js";

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

/** Moonraker's print-file root. Every browsable path is relative to it. */
const GCODES_ROOT = "gcodes";

/**
 * One row of Moonraker's directory response. Directories report `dirname`,
 * files report `filename`; both are untrusted network input, so every field
 * arrives as `unknown` and is narrowed before use.
 */
type MoonrakerDirectoryRow = {
  dirname?: unknown;
  filename?: unknown;
  modified?: unknown;
  size?: unknown;
};

function directoryRows(value: unknown): MoonrakerDirectoryRow[] {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is MoonrakerDirectoryRow =>
    typeof row === "object" && row !== null
  );
}

/**
 * Read a bare entry name from a directory row.
 *
 * The directory endpoint reports one path segment per entry, so a value with a
 * separator in it is a provider surprise rather than something to browse into.
 */
function entryName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = safeStoragePath(raw, { trimTrailing: true });
  if (!name || name.includes("/")) return null;
  return name;
}

/**
 * Moonraker reports `modified: 0` for entries whose timestamp it does not have.
 * The epoch is a guess, not a modification time, so it stays absent.
 */
function modifiedAt(raw: unknown): string | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return undefined;
  return new Date(raw * 1_000).toISOString();
}

/**
 * Browse one directory of the `gcodes` root.
 *
 * Uses `/server/files/directory` rather than the flat `/server/files/list`:
 * the flat endpoint only reports files Moonraker recognizes as valid G-code, so
 * it hides folders and every other file an operator may need to see. Moonraker
 * supplies no revision or etag for stored files, so `provider_revision` is
 * never populated here; size and modification time carry the drift signal.
 */
async function browseStorage(
  config: IntegrationConfig,
  path: string,
): Promise<PrinterStorageListing> {
  const baseUrl = normalizeBaseUrl(config.base_url ?? config.baseUrl);
  if (!baseUrl) throw new Error("base_url is required");
  // Only an empty or all-slashes path means the root; anything else is validated.
  const stripped = path.replace(/^\/+|\/+$/g, "");
  const requested = stripped ? safeStoragePath(stripped, { trimTrailing: true }) : "";
  const providerPath = requested === null ? null : joinStoragePath(GCODES_ROOT, requested);
  if (requested === null || !providerPath) {
    throw new Error("Invalid Moonraker print-file path");
  }

  const response = await moonrakerFetch(
    `${baseUrl}/server/files/directory?path=${encodeStoragePath(providerPath)}&extended=true`,
    config,
    { signal: AbortSignal.timeout(15_000) },
  );
  if (!response.ok) {
    throw new Error(`Moonraker directory listing returned HTTP ${response.status}`);
  }
  // Moonraker's HTTP API wraps nearly every success in `{ "result": ... }`.
  // Reading the payload fields off the top level silently yields an empty
  // listing against a real host, which is how this went unnoticed.
  const body = await response.json() as { result?: { dirs?: unknown; files?: unknown } };
  const dirRows = directoryRows(body.result?.dirs);
  const fileRows = directoryRows(body.result?.files);
  const prefix = requested ? `${requested}/` : "";

  const directories = dirRows.flatMap((row): PrinterStorageEntry[] => {
    const name = entryName(row.dirname);
    if (!name) return [];
    const modified = modifiedAt(row.modified);
    return [{
      kind: "directory",
      path: `${prefix}${name}`,
      name,
      ...(modified === undefined ? {} : { modified_at: modified }),
    }];
  });
  const files = fileRows.flatMap((row): PrinterStorageEntry[] => {
    const name = entryName(row.filename);
    if (!name) return [];
    const size = typeof row.size === "number" && Number.isFinite(row.size) && row.size >= 0
      ? Math.round(row.size)
      : undefined;
    const modified = modifiedAt(row.modified);
    return [{
      kind: "file",
      path: `${prefix}${name}`,
      name,
      ...(size === undefined ? {} : { size_bytes: size }),
      ...(modified === undefined ? {} : { modified_at: modified }),
    }];
  });

  return { path: requested, entries: [...directories, ...files] };
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
  // Same `result` envelope as every other Moonraker HTTP endpoint.
  const body = await response.json() as { result?: { webcams?: unknown } };
  const webcams = body.result?.webcams;
  return Array.isArray(webcams) ? webcams as MoonrakerWebcam[] : [];
}

function cameraId(camera: MoonrakerWebcam, index: number): string {
  const uid = typeof camera.uid === "string" ? camera.uid.trim() : "";
  return uid || `camera-${index}`;
}

/**
 * How long one proxied camera view may hold the connection.
 *
 * Stream duration has to be bounded, and an MJPEG connection never ends on its
 * own. A minute costs a watching operator a reconnect, which the browser issues
 * on its own, instead of pinning a proxy socket open for the whole shift.
 */
const CAMERA_VIEW_TIMEOUT_MS = 60_000;

/**
 * Resolve one advertised camera URL against the Moonraker origin.
 *
 * Returns null when the value does not land on that origin, including when it
 * cannot be resolved at all. Either way it is not a URL this adapter will fetch.
 */
function sameOriginCameraUrl(
  { advertised, baseUrl }: { advertised: string; baseUrl: string },
): string | null {
  try {
    const resolved = new URL(advertised, `${baseUrl}/`);
    return resolved.origin === new URL(baseUrl).origin ? resolved.toString() : null;
  } catch {
    return null;
  }
}

/** Outcome of picking a browser-renderable view for one webcam entry. */
type CameraViewResolution =
  | { outcome: "resolved"; view: PrinterCamera["view"]; url: string }
  | { outcome: "cross_origin" }
  | { outcome: "unsupported" };

/**
 * Choose the view to serve for one webcam entry, or say why there is none.
 *
 * Moonraker does not operate the camera. It replays whatever a camera service
 * or an operator wrote into its webcam database, so both URLs are SSRF
 * candidates. A cross-origin value rejects the whole entry rather than falling
 * back to its sibling URL: the same database row supplied both, so one bad
 * value discredits the other.
 */
function resolveCameraView(
  { baseUrl, camera }: { baseUrl: string; camera: MoonrakerWebcam },
): CameraViewResolution {
  const streamUrl = typeof camera.stream_url === "string" ? camera.stream_url.trim() : "";
  const snapshotUrl = typeof camera.snapshot_url === "string" ? camera.snapshot_url.trim() : "";
  const service = typeof camera.service === "string" ? camera.service.trim().toLowerCase() : "";
  // "" means the entry advertised nothing; null means it advertised something
  // this adapter refuses to fetch.
  const stream = streamUrl ? sameOriginCameraUrl({ advertised: streamUrl, baseUrl }) : "";
  const snapshot = snapshotUrl ? sameOriginCameraUrl({ advertised: snapshotUrl, baseUrl }) : "";
  if (stream === null || snapshot === null) return { outcome: "cross_origin" };
  // MJPEG is the only continuous format this adapter proxies. Moonraker's
  // service names vary by camera stack, and an `action=stream` query is the
  // mjpg-streamer convention.
  const mjpeg = service.includes("mjpeg")
    || service.includes("ustreamer")
    || /action=stream/i.test(streamUrl);
  if (stream && mjpeg) return { outcome: "resolved", view: "mjpeg", url: stream };
  if (snapshot) return { outcome: "resolved", view: "snapshot", url: snapshot };
  return { outcome: "unsupported" };
}

async function listCameras(config: IntegrationConfig): Promise<PrinterCamera[]> {
  const baseUrl = normalizeBaseUrl(config.base_url ?? config.baseUrl);
  if (!baseUrl) throw new Error("base_url is required");
  const cameras = await readWebcams(config);
  return cameras.flatMap((camera, index): PrinterCamera[] => {
    if (camera.enabled === false) return [];
    const resolution = resolveCameraView({ baseUrl, camera });
    if (resolution.outcome !== "resolved") return [];
    const service = typeof camera.service === "string" ? camera.service.trim() : "";
    const name = typeof camera.name === "string" && camera.name.trim()
      ? camera.name.trim()
      : `Camera ${index + 1}`;
    const aspectRatio = typeof camera.aspect_ratio === "string" && camera.aspect_ratio.trim()
      ? camera.aspect_ratio.trim()
      : undefined;
    return [{
      id: cameraId(camera, index),
      name,
      view: resolution.view,
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
    browse: browseStorage,
    async open(config, path) {
      const baseUrl = normalizeBaseUrl(config.base_url ?? config.baseUrl);
      const safePath = safeStoragePath(path);
      if (!baseUrl || !safePath) throw new Error("Invalid Moonraker print-file path");
      return moonrakerFetch(
        `${baseUrl}/server/files/${GCODES_ROOT}/${encodeStoragePath(safePath)}`,
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
      const resolution = resolveCameraView({ baseUrl, camera: entry });
      switch (resolution.outcome) {
        case "resolved":
          return moonrakerFetch(
            resolution.url,
            config,
            { signal: AbortSignal.timeout(CAMERA_VIEW_TIMEOUT_MS) },
            new URL(baseUrl).origin,
          );
        case "cross_origin":
          throw new Error("Moonraker advertised a cross-origin camera URL");
        case "unsupported":
          throw new Error("Camera has no browser-compatible view");
        default: {
          const _exhaustive: never = resolution;
          throw new Error(`Unhandled camera view outcome: ${JSON.stringify(_exhaustive)}`);
        }
      }
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
