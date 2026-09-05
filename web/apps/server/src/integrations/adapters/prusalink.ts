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
import {
  cancelResponseBody,
  isJsonObject as isRecord,
  readBoundedJsonResponse,
  readBoundedResponseText,
  readResponsePrefix,
} from "../../lib/bounded-response.js";
import { buildDigestAuthorization, parseWwwAuthenticate } from "../digest-auth.js";
import { encodeStoragePath, joinStoragePath, safeStoragePath } from "./storage-path.js";

const MAX_METADATA_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_DIRECTORY_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 64 * 1024;
const FILE_DOWNLOAD_IDLE_MS = 120_000;

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
  await cancelResponseBody(res);
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

async function fetchWithIdleTimeout(
  url: string,
  config: IntegrationConfig,
  { idleMs, headers, timeoutMessage }: {
    idleMs: number;
    headers?: RequestInit["headers"];
    timeoutMessage: string;
  },
): Promise<Response> {
  const abortController = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  const finish = () => {
    finished = true;
    clearTimeout(idleTimer);
  };
  const resetIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      abortController.abort(new DOMException(
        timeoutMessage,
        "TimeoutError",
      ));
    }, idleMs);
    idleTimer.unref();
  };

  resetIdleTimer();
  try {
    const response = await prusalinkFetch(url, config, { headers, signal: abortController.signal });
    if (!response.body) {
      finish();
      return response;
    }
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (finished) return;
          if (chunk.done) {
            finish();
            reader.releaseLock();
            controller.close();
            return;
          }
          if (chunk.value.byteLength > 0) resetIdleTimer();
          controller.enqueue(chunk.value);
        } catch (error) {
          if (finished) return;
          finish();
          reader.releaseLock();
          controller.error(error);
        }
      },
      async cancel(reason: unknown) {
        finish();
        const cancelled = reader.cancel(reason);
        abortController.abort(reason);
        try {
          await cancelled;
        } finally {
          reader.releaseLock();
        }
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    finish();
    throw error;
  }
}

function downloadPrintFile(url: string, config: IntegrationConfig): Promise<Response> {
  return fetchWithIdleTimeout(url, config, {
    idleMs: FILE_DOWNLOAD_IDLE_MS,
    timeoutMessage: "PrusaLink download received no data for 120 seconds",
  });
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

function parseFileMeta(value: unknown): PrusaFileMeta | undefined {
  if (!isRecord(value)) return undefined;
  const file: PrusaFileMeta = {};
  if (typeof value.name === "string") file.name = value.name;
  if (typeof value.display_name === "string") file.display_name = value.display_name;
  if (typeof value.path === "string") file.path = value.path;
  return file;
}

function parseJobBody(value: unknown): PrusaJobBody {
  if (!isRecord(value)) return {};
  const body: PrusaJobBody = {};
  if (typeof value.state === "string") body.state = value.state;
  const file = parseFileMeta(value.file);
  if (file) body.file = file;
  if (typeof value.progress === "number") body.progress = value.progress;
  if (typeof value.time_remaining === "number") body.time_remaining = value.time_remaining;
  if (typeof value.consumed_material === "number") {
    body.consumed_material = value.consumed_material;
  }
  if (isRecord(value.refs)) {
    const refs: NonNullable<PrusaJobBody["refs"]> = {};
    if (typeof value.refs.download === "string") refs.download = value.refs.download;
    if (typeof value.refs.icon === "string") refs.icon = value.refs.icon;
    if (typeof value.refs.thumbnail === "string") refs.thumbnail = value.refs.thumbnail;
    body.refs = refs;
  }
  return body;
}

function parseStatusBody(value: unknown): PrusaStatusBody {
  if (!isRecord(value)) return {};
  const body: PrusaStatusBody = {};
  if (isRecord(value.printer)) {
    const printer: NonNullable<PrusaStatusBody["printer"]> = {};
    if (typeof value.printer.state === "string") printer.state = value.printer.state;
    if (typeof value.printer.status === "string") printer.status = value.printer.status;
    if (typeof value.printer.temp_nozzle === "number") {
      printer.temp_nozzle = value.printer.temp_nozzle;
    }
    if (typeof value.printer.target_nozzle === "number") {
      printer.target_nozzle = value.printer.target_nozzle;
    }
    if (typeof value.printer.temp_bed === "number") printer.temp_bed = value.printer.temp_bed;
    if (typeof value.printer.target_bed === "number") {
      printer.target_bed = value.printer.target_bed;
    }
    body.printer = printer;
  }
  if (isRecord(value.job)) {
    const job: NonNullable<PrusaStatusBody["job"]> = {};
    if (typeof value.job.progress === "number") job.progress = value.job.progress;
    const file = parseFileMeta(value.job.file);
    if (file) job.file = file;
    if (typeof value.job.time_remaining === "number") {
      job.time_remaining = value.job.time_remaining;
    }
    body.job = job;
  }
  return body;
}

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
    const body = parseJobBody(
      await readBoundedJsonResponse(res, MAX_METADATA_RESPONSE_BYTES),
    );
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
    await drainResponseBody(res);
    return { state: "idle", message: "Idle" };
  }
  if (!res.ok) {
    await drainResponseBody(res);
    return { state: "offline", message: `PrusaLink returned HTTP ${res.status}` };
  }
  const body = parseStatusBody(
    await readBoundedJsonResponse(res, MAX_METADATA_RESPONSE_BYTES),
  );
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

type PrusaFileInfo = {
  name?: unknown;
  display_name?: unknown;
  type?: unknown;
  size?: unknown;
  m_timestamp?: unknown;
  children?: unknown;
  refs?: { download?: unknown };
};

function parseFileInfo(value: unknown): PrusaFileInfo | null {
  if (!isRecord(value)) return null;
  return {
    name: value.name,
    display_name: value.display_name,
    type: value.type,
    size: value.size,
    m_timestamp: value.m_timestamp,
    children: value.children,
    refs: isRecord(value.refs) ? { download: value.refs.download } : undefined,
  };
}

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
  const body = await readBoundedJsonResponse(response, MAX_METADATA_RESPONSE_BYTES);
  const storages = isRecord(body) && Array.isArray(body.storage_list) ? body.storage_list : [];
  for (const storage of storages) {
    if (!isRecord(storage)) continue;
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

  const response = await fetchWithIdleTimeout(prusaFileUrl(baseUrl, providerPath), config, {
    headers: { Accept: "application/json" },
    idleMs: 15_000,
    timeoutMessage: "PrusaLink file listing received no data for 15 seconds",
  });
  if (!response.ok) {
    await drainResponseBody(response);
    throw new Error(`PrusaLink file listing returned HTTP ${response.status}`);
  }
  const folder = parseFileInfo(
    await readBoundedJsonResponse(response, MAX_DIRECTORY_RESPONSE_BYTES),
  );
  const children = Array.isArray(folder?.children)
    ? folder.children.map(parseFileInfo).filter((child) => child !== null)
    : [];

  const entries: PrinterStorageEntry[] = [];
  for (const child of children) {
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

function parseCameraInfo(value: unknown): PrusaCameraInfo | null {
  if (!isRecord(value)) return null;
  return {
    camera_id: value.camera_id,
    connected: value.connected,
    config: isRecord(value.config) ? { name: value.config.name } : undefined,
  };
}

async function readCameras(config: IntegrationConfig): Promise<PrusaCameraInfo[]> {
  const baseUrl = normalizeBaseUrl(config.base_url ?? config.baseUrl);
  if (!baseUrl) throw new Error("base_url is required");
  const response = await prusalinkFetch(`${baseUrl}/api/v1/cameras`, config, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    await drainResponseBody(response);
    if (response.status === 404 || response.status === 403 || response.status === 503) return [];
    throw new Error(`PrusaLink camera list returned HTTP ${response.status}`);
  }
  const body = await readBoundedJsonResponse(response, MAX_METADATA_RESPONSE_BYTES);
  return Array.isArray(body)
    ? body.map(parseCameraInfo).filter((camera) => camera !== null)
    : [];
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
      const metadata = parseFileInfo(
        await readBoundedJsonResponse(metadataResponse, MAX_METADATA_RESPONSE_BYTES),
      );
      const downloadRef = typeof metadata?.refs?.download === "string"
        ? metadata.refs.download.trim()
        : "";
      if (!downloadRef) throw new Error("PrusaLink did not advertise a download URL");
      const downloadUrl = new URL(downloadRef, `${baseUrl}/`).toString();
      if (new URL(downloadUrl).origin !== new URL(baseUrl).origin) {
        throw new Error("PrusaLink advertised a cross-origin download URL");
      }
      return downloadPrintFile(downloadUrl, config);
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
        const info = await readBoundedJsonResponse(infoRes, MAX_METADATA_RESPONSE_BYTES);
        const label = isRecord(info)
          ? [info.name, info.hostname, info.printer_model]
              .find((value): value is string => typeof value === "string" && value.length > 0)
            ?? "PrusaLink"
          : "PrusaLink";
        const status = await readStatus(config).catch(() => null);
        const statePart = status?.state ? `, state: ${status.state}` : "";
        return { ok: true, message: `Connected (${label}${statePart})` };
      }
      // Fall back to status if /info is unavailable on older builds.
      await drainResponseBody(infoRes);
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
      const job = parseJobBody(
        await readBoundedJsonResponse(jobRes, MAX_METADATA_RESPONSE_BYTES),
      );

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

      // Some PrusaLink versions ignore Range, so cap the consumed prefix as well.
      const fileRes = await prusalinkFetch(downloadUrl, config, {
        headers: { Range: "bytes=0-65535" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!fileRes.ok && fileRes.status !== 206) {
        await drainResponseBody(fileRes);
        return [];
      }

      const buf = await readResponsePrefix(fileRes, 65_536);
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
      const parsed: unknown = JSON.parse(jsonStr);
      if (!isRecord(parsed) || !Array.isArray(parsed.objects)) return [];

      return parsed.objects
        .map((object) => isRecord(object) && typeof object.name === "string" ? object.name : "")
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
      const body = parseJobBody(
        await readBoundedJsonResponse(res, MAX_METADATA_RESPONSE_BYTES),
      );
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
        const text = await readBoundedResponseText(res, MAX_ERROR_RESPONSE_BYTES).catch(() => "");
        return {
          ok: false,
          message: `Upload failed (HTTP ${res.status})${text ? `: ${text.slice(0, 200)}` : ""}`,
        };
      }

      await drainResponseBody(res);

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
