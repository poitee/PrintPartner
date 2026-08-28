import type {
  IntegrationConfig,
  IntegrationTestResult,
  PrinterCamera,
  PrinterHostStatus,
  PrinterStorageEntry,
  PrinterStorageListing,
  PrinterUploadResult,
} from "@print-partner/contracts";
import { createReadStream, statSync } from "node:fs";
import type { IntegrationAdapter, PrinterUploadSource } from "../store.js";
import { assertSafeOutboundUrl } from "../../lib/outbound-url.js";
import { buildDigestAuthorization, parseWwwAuthenticate } from "../digest-auth.js";
import { encodeStoragePath, joinStoragePath, safeStoragePath } from "./storage-path.js";

function normalizeBaseUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  return raw.trim().replace(/\/+$/, "");
}

function credentials(config: IntegrationConfig): { username: string; password: string } | null {
  const username = String(config.username ?? config.user ?? "").trim();
  const passwordRaw = config.password ?? config.api_key;
  if (typeof passwordRaw !== "string" || !passwordRaw.trim() || passwordRaw === "****") {
    return null;
  }
  return { username, password: passwordRaw.trim() };
}

/** Storage root the operator pinned on the integration, if any. */
function configuredStorageRoot(config: IntegrationConfig): string | null {
  const raw = config.storage ?? config.storage_path;
  if (typeof raw !== "string" || !raw.trim()) return null;
  return safeStoragePath(raw, { trimTrailing: true });
}

/**
 * PrusaLink HTTP Digest fetch.
 * Obtain the Digest challenge via a bodyless GET to /api/v1/status — never probe
 * with PUT/POST (a bodyless write can corrupt or create empty jobs on the printer).
 * Then send the real request (with body, if any) using Digest Authorization.
 * Every hop is SSRF-checked with allowPrivate.
 */
async function drainResponseBody(res: Response): Promise<void> {
  try {
    await res.arrayBuffer();
  } catch {
    /* ignore */
  }
}

async function obtainDigestChallenge(
  requestUrl: string,
  signal: AbortSignal,
): Promise<Record<string, string> | null> {
  const origin = new URL(requestUrl).origin;
  const probeUrl = `${origin}/api/v1/status`;
  await assertSafeOutboundUrl(probeUrl, { allowPrivate: true });
  const probe = await fetch(probeUrl, {
    method: "GET",
    signal,
    redirect: "manual",
  });
  await drainResponseBody(probe);
  if (probe.status !== 401) return null;
  const challenge = parseWwwAuthenticate(probe.headers.get("www-authenticate") ?? "");
  return challenge.nonce ? challenge : null;
}

async function prusalinkFetch(
  url: string,
  config: IntegrationConfig,
  init: RequestInit = {},
): Promise<Response> {
  await assertSafeOutboundUrl(url, { allowPrivate: true });
  const creds = credentials(config);
  const method = (init.method ?? "GET").toUpperCase();
  const signal = init.signal ?? AbortSignal.timeout(30_000);

  if (!creds) {
    return fetch(url, { ...init, method, signal, redirect: "manual" });
  }

  const challenge = await obtainDigestChallenge(url, signal);
  let authorization: string | undefined;
  if (challenge) {
    const parsed = new URL(url);
    authorization = buildDigestAuthorization({
      username: creds.username,
      password: creds.password,
      method,
      uri: `${parsed.pathname}${parsed.search}`,
      challenge,
    });
  }

  const headers = new Headers(init.headers);
  if (authorization) headers.set("Authorization", authorization);
  await assertSafeOutboundUrl(url, { allowPrivate: true });
  let res = await fetch(url, { ...init, method, headers, signal, redirect: "manual" });

  // Stale/missing challenge: retry once from the real response's WWW-Authenticate.
  if (res.status === 401) {
    const retryChallenge = parseWwwAuthenticate(res.headers.get("www-authenticate") ?? "");
    await drainResponseBody(res);
    if (retryChallenge.nonce) {
      const parsed = new URL(url);
      const retryAuth = buildDigestAuthorization({
        username: creds.username,
        password: creds.password,
        method,
        uri: `${parsed.pathname}${parsed.search}`,
        challenge: retryChallenge,
      });
      const retryHeaders = new Headers(init.headers);
      retryHeaders.set("Authorization", retryAuth);
      await assertSafeOutboundUrl(url, { allowPrivate: true });
      res = await fetch(url, {
        ...init,
        method,
        headers: retryHeaders,
        signal,
        redirect: "manual",
      });
    }
  }

  return res;
}

function mapPrinterState(raw: string | undefined): PrinterHostStatus["state"] {
  const state = (raw ?? "").toUpperCase();
  if (state === "PRINTING") return "printing";
  if (state === "PAUSED") return "paused";
  if (state === "FINISHED") return "complete";
  // READY / IDLE / STOPPED → idle (Buddy uses READY between jobs; cancel must not auto-checkoff)
  if (state === "READY" || state === "IDLE" || state === "STOPPED") return "idle";
  if (state === "ATTENTION" || state === "ERROR") return "error";
  if (!state) return "unknown";
  return "unknown";
}

type PrusaFileMeta = { name?: string; display_name?: string; path?: string };

type PrusaStatusBody = {
  printer?: {
    state?: string;
    status?: string;
    temp_nozzle?: number;
    target_nozzle?: number;
    temp_bed?: number;
    target_bed?: number;
  };
  job?: {
    progress?: number;
    file?: PrusaFileMeta;
    time_remaining?: number;
  };
};

type PrusaJobBody = {
  state?: string;
  file?: PrusaFileMeta;
  progress?: number;
  time_remaining?: number;
  consumed_material?: number;
  refs?: {
    download?: string;
    icon?: string;
    thumbnail?: string;
  };
};

function filenameFromFile(file: PrusaFileMeta | undefined): string | undefined {
  return file?.display_name ?? file?.name ?? file?.path ?? undefined;
}

async function readJobFileMeta(
  config: IntegrationConfig,
  baseUrl: string,
): Promise<{ filename?: string; progress?: number; eta_seconds?: number }> {
  try {
    const res = await prusalinkFetch(`${baseUrl}/api/v1/job`, config, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      await drainResponseBody(res);
      return {};
    }
    const body = (await res.json()) as PrusaJobBody;
    const progressRaw = body.progress;
    const progress =
      typeof progressRaw === "number" && Number.isFinite(progressRaw)
        ? Math.round(Math.min(100, Math.max(0, progressRaw)))
        : undefined;
    const eta =
      typeof body.time_remaining === "number" &&
      Number.isFinite(body.time_remaining) &&
      body.time_remaining >= 0
        ? body.time_remaining
        : undefined;
    return {
      filename: filenameFromFile(body.file),
      progress,
      eta_seconds: eta,
    };
  } catch {
    return {};
  }
}

async function readStatus(config: IntegrationConfig): Promise<PrinterHostStatus> {
  const baseUrl = normalizeBaseUrl(config.base_url ?? config.baseUrl);
  if (!baseUrl) return { state: "offline", message: "base_url is required" };
  if (!credentials(config)) {
    return { state: "offline", message: "username and password are required" };
  }

  const res = await prusalinkFetch(`${baseUrl}/api/v1/status`, config, {
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 204) {
    return { state: "idle", message: "Idle" };
  }
  if (!res.ok) {
    return { state: "offline", message: `PrusaLink returned HTTP ${res.status}` };
  }
  const body = (await res.json()) as PrusaStatusBody;
  const rawState = body.printer?.state ?? body.printer?.status;
  const state = mapPrinterState(rawState);
  const progressRaw = body.job?.progress;
  let progress =
    typeof progressRaw === "number" && Number.isFinite(progressRaw)
      ? Math.round(Math.min(100, Math.max(0, progressRaw)))
      : undefined;
  let filename = filenameFromFile(body.job?.file);
  let eta =
    typeof body.job?.time_remaining === "number" &&
    Number.isFinite(body.job.time_remaining) &&
    body.job.time_remaining >= 0
      ? body.job.time_remaining
      : undefined;

  // While printing/paused, `/api/v1/job` is the reliable source for active file metadata.
  if (state === "printing" || state === "paused") {
    const jobMeta = await readJobFileMeta(config, baseUrl);
    if (jobMeta.filename) filename = jobMeta.filename;
    if (progress == null && jobMeta.progress != null) progress = jobMeta.progress;
    if (eta == null && jobMeta.eta_seconds != null) eta = jobMeta.eta_seconds;
  }

  return {
    state,
    progress: state === "printing" || state === "paused" ? progress : undefined,
    filename,
    eta_seconds: eta,
    ip_address: new URL(baseUrl).hostname,
    nozzle_temperature_c: body.printer?.temp_nozzle,
    nozzle_target_c: body.printer?.target_nozzle,
    bed_temperature_c: body.printer?.temp_bed,
    bed_target_c: body.printer?.target_bed,
    message:
      state === "printing" && filename
        ? `Printing ${filename}`
        : state === "complete"
          ? filename
            ? `Complete · ${filename}`
            : "Complete"
          : state === "idle"
            ? "Idle"
            : rawState,
  };
}

type PrusaStorage = {
  path?: unknown;
  available?: unknown;
};

type PrusaFileInfo = {
  name?: unknown;
  display_name?: unknown;
  type?: unknown;
  size?: unknown;
  m_timestamp?: unknown;
  children?: unknown;
  refs?: { download?: unknown };
};

function prusaFileUrl(baseUrl: string, providerPath: string): string {
  const suffix = providerPath.includes("/") ? "" : "/";
  return `${baseUrl}/api/v1/files/${encodeStoragePath(providerPath)}${suffix}`;
}

function displayName(row: PrusaFileInfo): string {
  if (typeof row.display_name === "string" && row.display_name.trim()) {
    return row.display_name.trim();
  }
  return typeof row.name === "string" ? row.name.trim() : "";
}

/** One directory is one screen for an operator, so one response is bounded too. */
const MAX_STORAGE_ENTRIES = 500;

/**
 * The provider storage prefix that browsing and downloading resolve against.
 *
 * The research doc is explicit that a `usb` path must not be assumed, so an
 * integration with no pinned storage takes the first storage the printer itself
 * reports as available.
 */
async function resolveStorageRoot(config: IntegrationConfig, baseUrl: string): Promise<string> {
  const configured = configuredStorageRoot(config);
  if (configured) return configured;
  const response = await prusalinkFetch(`${baseUrl}/api/v1/storage`, config, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    await drainResponseBody(response);
    throw new Error(`PrusaLink storage list returned HTTP ${response.status}`);
  }
  const body = await response.json() as { storage_list?: unknown };
  const storages = Array.isArray(body.storage_list) ? body.storage_list as PrusaStorage[] : [];
  for (const storage of storages) {
    if (storage.available === false || typeof storage.path !== "string") continue;
    const root = safeStoragePath(storage.path, { trimTrailing: true });
    if (root) return root;
  }
  throw new Error("PrusaLink reported no available storage");
}

/**
 * Normalize a caller path, or throw before any request goes out.
 *
 * Paths arrive from a browser and from the printer's own listings, so both are
 * untrusted: traversal segments, backslashes, and NUL bytes are rejected here
 * rather than handed to the printer as URL segments.
 */
function storageRelativePath(raw: string): string {
  if (!raw) return "";
  const relative = safeStoragePath(raw, { trimTrailing: true });
  if (!relative) throw new Error("Invalid PrusaLink storage path");
  return relative;
}

async function browseStorage(
  config: IntegrationConfig,
  path: string,
): Promise<PrinterStorageListing> {
  const baseUrl = normalizeBaseUrl(config.base_url ?? config.baseUrl);
  if (!baseUrl) throw new Error("base_url is required");
  if (!credentials(config)) throw new Error("username and password are required");
  const relative = storageRelativePath(path);
  const providerPath = joinStoragePath(await resolveStorageRoot(config, baseUrl), relative);
  if (!providerPath) throw new Error("Invalid PrusaLink storage path");

  const response = await prusalinkFetch(prusaFileUrl(baseUrl, providerPath), config, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    await drainResponseBody(response);
    throw new Error(`PrusaLink file listing returned HTTP ${response.status}`);
  }
  const folder = await response.json() as PrusaFileInfo;
  const children = Array.isArray(folder.children) ? folder.children as PrusaFileInfo[] : [];

  const entries: PrinterStorageEntry[] = [];
  for (const child of children) {
    if (entries.length >= MAX_STORAGE_ENTRIES) break;
    // A child name is one segment. Anything else is the printer reporting a
    // path where a name belongs, and it is not this directory's to serve.
    const name = typeof child.name === "string"
      ? safeStoragePath(child.name, { trimTrailing: true })
      : null;
    if (!name || name.includes("/")) continue;
    const childPath = relative ? `${relative}/${name}` : name;
    const modified = typeof child.m_timestamp === "number" && Number.isFinite(child.m_timestamp)
      ? { modified_at: new Date(child.m_timestamp * 1_000).toISOString() }
      : {};
    if (child.type === "FOLDER") {
      entries.push({
        kind: "directory",
        path: childPath,
        name: displayName(child) || name,
        ...modified,
      });
      continue;
    }
    if (child.type !== "PRINT_FILE") continue;
    // Absent size stays absent: unknown must not read as zero.
    const size = typeof child.size === "number" && Number.isFinite(child.size) && child.size >= 0
      ? { size_bytes: Math.round(child.size) }
      : {};
    // PrusaLink's file record carries no etag or revision, so provider_revision
    // is omitted rather than filled with a stand-in.
    entries.push({
      kind: "file",
      path: childPath,
      name: displayName(child) || name,
      ...size,
      ...modified,
    });
  }
  return { path: relative, entries };
}

type PrusaCameraInfo = {
  camera_id?: unknown;
  connected?: unknown;
  config?: { name?: unknown };
};

async function readCameras(config: IntegrationConfig): Promise<PrusaCameraInfo[]> {
  const baseUrl = normalizeBaseUrl(config.base_url ?? config.baseUrl);
  if (!baseUrl) throw new Error("base_url is required");
  const response = await prusalinkFetch(`${baseUrl}/api/v1/cameras`, config, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    if (response.status === 404 || response.status === 403 || response.status === 503) return [];
    throw new Error(`PrusaLink camera list returned HTTP ${response.status}`);
  }
  const body = await response.json() as unknown;
  return Array.isArray(body) ? body as PrusaCameraInfo[] : [];
}

async function listCameras(config: IntegrationConfig): Promise<PrinterCamera[]> {
  const cameras = await readCameras(config);
  return cameras.flatMap((camera, index): PrinterCamera[] => {
    const id = typeof camera.camera_id === "string" ? camera.camera_id.trim() : "";
    if (!id || camera.connected === false) return [];
    const name = typeof camera.config?.name === "string" && camera.config.name.trim()
      ? camera.config.name.trim()
      : `Camera ${index + 1}`;
    return [{ id, name, view: "snapshot", service: "prusalink" }];
  });
}

export const prusalinkAdapter: IntegrationAdapter = {
  type: "prusalink",

  files: {
    browse: browseStorage,
    async open(config, path) {
      const baseUrl = normalizeBaseUrl(config.base_url ?? config.baseUrl);
      if (!baseUrl) throw new Error("base_url is required");
      const relative = storageRelativePath(path);
      if (!relative) throw new Error("Invalid PrusaLink print-file path");
      const providerPath = joinStoragePath(await resolveStorageRoot(config, baseUrl), relative);
      if (!providerPath) throw new Error("Invalid PrusaLink print-file path");
      const metadataResponse = await prusalinkFetch(
        prusaFileUrl(baseUrl, providerPath),
        config,
        {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!metadataResponse.ok) return metadataResponse;
      const metadata = await metadataResponse.json() as PrusaFileInfo;
      const downloadRef = typeof metadata.refs?.download === "string"
        ? metadata.refs.download.trim()
        : "";
      if (!downloadRef) throw new Error("PrusaLink did not advertise a download URL");
      const downloadUrl = new URL(downloadRef, `${baseUrl}/`).toString();
      if (new URL(downloadUrl).origin !== new URL(baseUrl).origin) {
        throw new Error("PrusaLink advertised a cross-origin download URL");
      }
      return prusalinkFetch(downloadUrl, config, {
        signal: AbortSignal.timeout(120_000),
      });
    },
  },

  cameras: {
    list: listCameras,
    async open(config, cameraId) {
      const baseUrl = normalizeBaseUrl(config.base_url ?? config.baseUrl);
      if (!baseUrl) throw new Error("base_url is required");
      const cameras = await readCameras(config);
      const camera = cameras.find((row) => row.camera_id === cameraId && row.connected !== false);
      if (!camera) throw new Error("Camera not found");
      return prusalinkFetch(
        `${baseUrl}/api/v1/cameras/${encodeURIComponent(cameraId)}/snap`,
        config,
        { signal: AbortSignal.timeout(30_000) },
      );
    },
  },

  async testConnection(config: IntegrationConfig): Promise<IntegrationTestResult> {
    const baseUrl = normalizeBaseUrl(config.base_url ?? config.baseUrl);
    if (!baseUrl) {
      return { ok: false, message: "base_url is required" };
    }
    if (!credentials(config)) {
      return { ok: false, message: "username and password are required" };
    }
    try {
      const infoRes = await prusalinkFetch(`${baseUrl}/api/v1/info`, config, {
        signal: AbortSignal.timeout(8000),
      });
      if (infoRes.ok) {
        const info = (await infoRes.json()) as {
          name?: string;
          hostname?: string;
          printer_model?: string;
        };
        const label = info.name ?? info.hostname ?? info.printer_model ?? "PrusaLink";
        const status = await readStatus(config).catch(() => null);
        const statePart = status?.state ? `, state: ${status.state}` : "";
        return { ok: true, message: `Connected (${label}${statePart})` };
      }
      // Fall back to status if /info is unavailable on older builds.
      const status = await readStatus(config);
      if (status.state === "offline") {
        return { ok: false, message: status.message ?? `PrusaLink returned HTTP ${infoRes.status}` };
      }
      return { ok: true, message: `Connected (${status.message ?? status.state})` };
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
      const status = await readStatus(config);
      return [
        {
          id: "default",
          name: "PrusaLink printer",
          type: "prusalink",
          status: status.state,
        },
      ];
    } catch {
      return [];
    }
  },

  async getStatus(config: IntegrationConfig): Promise<PrinterHostStatus> {
    try {
      return await readStatus(config);
    } catch (e) {
      return {
        state: "offline",
        message: e instanceof Error ? e.message : String(e),
      };
    }
  },

  async getObjectList(config: IntegrationConfig): Promise<string[]> {
    try {
      const baseUrl = normalizeBaseUrl(config.base_url ?? config.baseUrl);
      if (!baseUrl) return [];

      // Fetch current job to get state and download path
      const jobRes = await prusalinkFetch(`${baseUrl}/api/v1/job`, config, {
        signal: AbortSignal.timeout(8000),
      });
      if (!jobRes.ok) {
        await drainResponseBody(jobRes);
        return [];
      }
      const job = (await jobRes.json()) as PrusaJobBody;

      // Only parse for active/finished jobs
      const rawState = (job.state ?? "").toUpperCase();
      if (rawState !== "PRINTING" && rawState !== "PAUSED" && rawState !== "FINISHED") {
        return [];
      }

      const downloadPath = job.refs?.download;
      if (!downloadPath) return [];

      // Build full download URL
      const downloadUrl = downloadPath.startsWith("http")
        ? downloadPath
        : `${baseUrl}${downloadPath.startsWith("/") ? "" : "/"}${downloadPath}`;

      // Download only the first 65536 bytes (bgcode metadata block is not compressed)
      const fileRes = await prusalinkFetch(downloadUrl, config, {
        headers: { Range: "bytes=0-65535" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!fileRes.ok && fileRes.status !== 206) {
        await drainResponseBody(fileRes);
        return [];
      }

      const buf = await fileRes.arrayBuffer();
      const text = new TextDecoder("latin1").decode(buf);

      // Find objects_info={ and extract the JSON by counting braces
      const MARKER = "objects_info=";
      const markerIdx = text.indexOf(MARKER);
      if (markerIdx === -1) return [];

      const jsonStart = markerIdx + MARKER.length;
      if (text[jsonStart] !== "{") return [];

      let depth = 0;
      let jsonEnd = -1;
      for (let i = jsonStart; i < text.length; i++) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}") {
          depth--;
          if (depth === 0) {
            jsonEnd = i;
            break;
          }
        }
      }
      if (jsonEnd === -1) return [];

      const jsonStr = text.slice(jsonStart, jsonEnd + 1);
      const parsed = JSON.parse(jsonStr) as { objects?: { name?: string }[] };
      if (!Array.isArray(parsed.objects)) return [];

      return parsed.objects
        .map((o) => (typeof o.name === "string" ? o.name : ""))
        .filter((n) => n.length > 0);
    } catch {
      return [];
    }
  },

  async getFilamentUsed(config: IntegrationConfig): Promise<number | null> {
    const baseUrl = normalizeBaseUrl(config.base_url ?? config.baseUrl);
    if (!baseUrl || !credentials(config)) return null;
    try {
      const res = await prusalinkFetch(`${baseUrl}/api/v1/job`, config, {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        await drainResponseBody(res);
        return null;
      }
      const body = (await res.json()) as PrusaJobBody;
      const consumed = body.consumed_material;
      if (typeof consumed === "number" && Number.isFinite(consumed) && consumed >= 0) {
        return consumed;
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
    if (!credentials(config)) {
      return { ok: false, message: "username and password are required" };
    }
    const safeName = (() => {
      const cleaned = filename.replace(/[/\\]/g, "_").trim() || "print.gcode";
      if (cleaned === "." || cleaned === ".." || /^\.+$/.test(cleaned)) return "print.gcode";
      return cleaned;
    })();
    // Uploads keep the historical `usb` default: that is the storage a Prusa
    // printer prints from, and browsing discovering `local` must not silently
    // redirect a write.
    const remotePath = `${configuredStorageRoot(config) ?? "usb"}/${safeName}`;
    const uploadUrl = `${baseUrl}/api/v1/files/${encodeStoragePath(remotePath)}`;

    try {
      const start = Boolean(options?.start);
      let body: Buffer | import("node:fs").ReadStream;
      let contentLength: number;
      const streamFromDisk = !(source instanceof Uint8Array);
      if (!streamFromDisk) {
        body = Buffer.from(source);
        contentLength = source.byteLength;
      } else {
        contentLength = statSync(source.path).size;
        body = createReadStream(source.path);
      }
      const res = await prusalinkFetch(uploadUrl, config, {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(contentLength),
          "Print-After-Upload": start ? "?1" : "?0",
          Overwrite: "?1",
        },
        body: body as RequestInit["body"],
        ...(streamFromDisk ? ({ duplex: "half" } as object) : {}),
        signal: AbortSignal.timeout(120_000),
      });

      if (res.status !== 201 && res.status !== 204 && !res.ok) {
        const text = await res.text().catch(() => "");
        return {
          ok: false,
          message: `Upload failed (HTTP ${res.status})${text ? `: ${text.slice(0, 200)}` : ""}`,
        };
      }

      return {
        ok: true,
        remote_path: remotePath,
        started: start,
        message: start
          ? `Uploaded and started ${safeName}`
          : `Uploaded ${safeName}`,
      };
    } catch (e) {
      return {
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      };
    }
  },
};
