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
import { Unzip, UnzipInflate } from "fflate";
import type { IntegrationAdapter } from "../store.js";
import { assertSafeOutboundUrl } from "../../lib/outbound-url.js";
import {
  cancelResponseBody,
  isJsonObject,
  readBoundedResponseBody,
  ResponseBodyTooLargeError,
} from "../../lib/bounded-response.js";

export type SlicerKind = "orca" | "prusa" | "bambu";

export const SLICER_KINDS: readonly SlicerKind[] = ["orca", "prusa", "bambu"] as const;

const MAX_CONTROL_RESPONSE_BYTES = 64 * 1024;
const MAX_SLICE_RESPONSE_BYTES = 512 * 1024 * 1024;
const MAX_SLICE_ARCHIVE_ENTRIES = 256;
const MAX_SLICE_ARCHIVE_EXPANDED_BYTES = 512 * 1024 * 1024;
const MAX_SLICE_ARCHIVE_COMPRESSION_RATIO = 200;
const MAX_SLICE_ARCHIVE_ENTRY_NAME_BYTES = 4 * 1024;
const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_LOCAL_FILE_HEADER_BYTES = 30;
const ZIP_CENTRAL_DIRECTORY_HEADER_BYTES = 46;
const ZIP_END_OF_CENTRAL_DIRECTORY_BYTES = 22;
const ZIP_MAX_COMMENT_BYTES = 0xffff;

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

function toBlob(bytes: Uint8Array): Blob {
  return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/octet-stream" });
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
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

function invalidJsonResponse(
  protocol: "v1" | "legacy",
  status: number,
  field?: string,
): SlicerSidecarError {
  const suffix = field ? `: ${field} has the wrong type` : "";
  return new SlicerSidecarError(
    `Slicer sidecar returned an invalid ${protocol} JSON response${suffix}`,
    { code: "invalid_response", status },
  );
}

function optionalStringField(
  body: Record<string, unknown>,
  field: string,
  protocol: "v1" | "legacy",
  status: number,
): string | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw invalidJsonResponse(protocol, status, field);
  return value;
}

function parseV1SliceResponse(value: unknown, status: number): {
  gcodeBase64?: string;
  gcodeFilename?: string;
  thumbnailBase64?: string;
  thumbnailFilename?: string;
  warnings: string[];
} {
  if (!isJsonObject(value)) throw invalidJsonResponse("v1", status);
  if (value.ok !== undefined && typeof value.ok !== "boolean") {
    throw invalidJsonResponse("v1", status, "ok");
  }
  if (value.ok === false) {
    throw new SlicerSidecarError("Slicer sidecar reported failure", {
      code: "sidecar_error",
      status,
    });
  }

  let warnings: string[] = [];
  if (value.meta !== undefined) {
    if (!isJsonObject(value.meta)) throw invalidJsonResponse("v1", status, "meta");
    if (value.meta.warnings !== undefined) {
      if (
        !Array.isArray(value.meta.warnings) ||
        value.meta.warnings.some((warning) => typeof warning !== "string")
      ) {
        throw invalidJsonResponse("v1", status, "meta.warnings");
      }
      warnings = [...value.meta.warnings];
    }
  }

  return {
    gcodeBase64: optionalStringField(value, "gcode_base64", "v1", status),
    gcodeFilename: optionalStringField(value, "gcode_filename", "v1", status),
    thumbnailBase64: optionalStringField(value, "thumbnail_base64", "v1", status),
    thumbnailFilename: optionalStringField(value, "thumbnail_filename", "v1", status),
    warnings,
  };
}

function parseLegacySliceResponse(value: unknown, status: number): {
  gcode?: string;
  thumbnail?: string;
  filename?: string;
} {
  if (!isJsonObject(value)) throw invalidJsonResponse("legacy", status);
  return {
    gcode: optionalStringField(value, "gcode", "legacy", status),
    thumbnail: optionalStringField(value, "thumbnail", "legacy", status),
    filename: optionalStringField(value, "filename", "legacy", status),
  };
}

/** Read an {ok:false, error:{...}} envelope, tolerating non-JSON bodies. */
async function sidecarErrorFromResponse(res: Response): Promise<SlicerSidecarError> {
  let text: string;
  try {
    text = new TextDecoder().decode(
      await readBoundedResponseBody(res, MAX_CONTROL_RESPONSE_BYTES),
    );
  } catch (error) {
    if (error instanceof ResponseBodyTooLargeError) {
      return new SlicerSidecarError("Slicer sidecar error response was too large", {
        code: "response_too_large",
        status: res.status,
      });
    }
    text = "";
  }
  try {
    const body: unknown = JSON.parse(text);
    const error = isJsonObject(body) && isJsonObject(body.error) ? body.error : null;
    if (error && typeof error.message === "string" && error.message) {
      return new SlicerSidecarError(error.message, {
        code: typeof error.code === "string" ? error.code : "sidecar_error",
        status: res.status,
        details: isJsonObject(error.details) ? error.details : {},
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

  const json = parseV1SliceResponse(
    await readSidecarJson(res, MAX_SLICE_RESPONSE_BYTES),
    res.status,
  );
  const gcode = json.gcodeBase64 ? base64ToBytes(json.gcodeBase64) : new Uint8Array(0);
  if (!gcode.length) {
    throw new SlicerSidecarError("Slicer sidecar returned no gcode", {
      code: "empty_gcode",
      status: res.status,
    });
  }
  return {
    gcode,
    thumbnail: json.thumbnailBase64 ? base64ToBytes(json.thumbnailBase64) : new Uint8Array(0),
    ...(json.gcodeFilename ? { filename: json.gcodeFilename } : {}),
    ...(json.thumbnailFilename ? { thumbnail_filename: json.thumbnailFilename } : {}),
    protocol: "v1",
    warnings: json.warnings,
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
    return {
      ...extractSliceZip(await readSidecarBody(res, MAX_SLICE_RESPONSE_BYTES)),
      protocol: "legacy",
    };
  }
  if (contentType.includes("application/json")) {
    const json = parseLegacySliceResponse(
      await readSidecarJson(res, MAX_SLICE_RESPONSE_BYTES),
      res.status,
    );
    const gcode = json.gcode ? base64ToBytes(json.gcode) : new Uint8Array(0);
    if (!gcode.length) {
      throw new SlicerSidecarError("Slicer sidecar returned no gcode", {
        code: "empty_gcode",
        status: res.status,
      });
    }
    return {
      gcode,
      thumbnail: json.thumbnail ? base64ToBytes(json.thumbnail) : new Uint8Array(0),
      ...(json.filename ? { filename: json.filename } : {}),
      protocol: "legacy",
    };
  }
  const gcode = await readSidecarBody(res, MAX_SLICE_RESPONSE_BYTES);
  if (!gcode.length) {
    throw new SlicerSidecarError("Slicer sidecar returned no gcode", {
      code: "empty_gcode",
      status: res.status,
    });
  }
  return {
    gcode,
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

function archiveTooLarge(): SlicerSidecarError {
  return new SlicerSidecarError("Slicer sidecar zip exceeds the extraction budget", {
    code: "archive_too_large",
  });
}

function invalidZip(cause?: unknown): SlicerSidecarError {
  return new SlicerSidecarError("Slicer sidecar zip was not readable", {
    code: "invalid_zip",
    ...(cause === undefined
      ? {}
      : { details: { cause: cause instanceof Error ? cause.message : String(cause) } }),
  });
}

function outputKind(name: string): "gcode" | "thumbnail" | null {
  const lower = name.toLowerCase();
  if (lower.endsWith("/") || lower.endsWith("\\")) return null;
  if (lower.endsWith(".gcode") || lower.endsWith(".bgcode")) return "gcode";
  return /(?:^|\/)plate_\d+\.png$/.test(lower) ? "thumbnail" : null;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}

function inspectSliceZipDirectory(buf: Uint8Array): number {
  if (buf.byteLength < ZIP_END_OF_CENTRAL_DIRECTORY_BYTES) throw invalidZip();
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const firstCandidate = Math.max(
    0,
    buf.byteLength - ZIP_END_OF_CENTRAL_DIRECTORY_BYTES - ZIP_MAX_COMMENT_BYTES,
  );
  let endOffset = -1;
  for (
    let offset = buf.byteLength - ZIP_END_OF_CENTRAL_DIRECTORY_BYTES;
    offset >= firstCandidate;
    offset -= 1
  ) {
    if (view.getUint32(offset, true) !== ZIP_END_OF_CENTRAL_DIRECTORY) continue;
    const commentBytes = view.getUint16(offset + 20, true);
    if (offset + ZIP_END_OF_CENTRAL_DIRECTORY_BYTES + commentBytes === buf.byteLength) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw invalidZip();

  const disk = view.getUint16(endOffset + 4, true);
  const directoryDisk = view.getUint16(endOffset + 6, true);
  const entriesOnDisk = view.getUint16(endOffset + 8, true);
  const entryCount = view.getUint16(endOffset + 10, true);
  const directoryBytes = view.getUint32(endOffset + 12, true);
  const directoryOffset = view.getUint32(endOffset + 16, true);
  if (entryCount === 0xffff || entryCount > MAX_SLICE_ARCHIVE_ENTRIES) {
    throw archiveTooLarge();
  }
  if (disk !== 0 || directoryDisk !== 0 || entriesOnDisk !== entryCount) throw invalidZip();
  const directoryEnd = directoryOffset + directoryBytes;
  if (!Number.isSafeInteger(directoryEnd) || directoryEnd !== endOffset) throw invalidZip();

  const decoder = new TextDecoder();
  let cursor = directoryOffset;
  let declaredExpandedBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (
      cursor + ZIP_CENTRAL_DIRECTORY_HEADER_BYTES > directoryEnd ||
      view.getUint32(cursor, true) !== ZIP_CENTRAL_DIRECTORY_HEADER
    ) {
      throw invalidZip();
    }
    const flags = view.getUint16(cursor + 8, true);
    const compression = view.getUint16(cursor + 10, true);
    const compressedBytes = view.getUint32(cursor + 20, true);
    const expandedBytes = view.getUint32(cursor + 24, true);
    const nameBytes = view.getUint16(cursor + 28, true);
    const extraBytes = view.getUint16(cursor + 30, true);
    const commentBytes = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const entryEnd =
      cursor + ZIP_CENTRAL_DIRECTORY_HEADER_BYTES + nameBytes + extraBytes + commentBytes;
    if (nameBytes > MAX_SLICE_ARCHIVE_ENTRY_NAME_BYTES || entryEnd > directoryEnd) {
      throw invalidZip();
    }
    if (expandedBytes === 0xffff_ffff) throw archiveTooLarge();
    if (compressedBytes === 0xffff_ffff || localOffset === 0xffff_ffff) throw invalidZip();

    const centralName = buf.subarray(
      cursor + ZIP_CENTRAL_DIRECTORY_HEADER_BYTES,
      cursor + ZIP_CENTRAL_DIRECTORY_HEADER_BYTES + nameBytes,
    );
    const kind = outputKind(decoder.decode(centralName));
    if (kind) {
      declaredExpandedBytes += expandedBytes;
      if (
        !Number.isSafeInteger(declaredExpandedBytes) ||
        declaredExpandedBytes > MAX_SLICE_ARCHIVE_EXPANDED_BYTES
      ) {
        throw archiveTooLarge();
      }
    }

    if (
      localOffset + ZIP_LOCAL_FILE_HEADER_BYTES > directoryOffset ||
      view.getUint32(localOffset, true) !== ZIP_LOCAL_FILE_HEADER
    ) {
      throw invalidZip();
    }
    const localFlags = view.getUint16(localOffset + 6, true);
    const localCompression = view.getUint16(localOffset + 8, true);
    const localCompressedBytes = view.getUint32(localOffset + 18, true);
    const localExpandedBytes = view.getUint32(localOffset + 22, true);
    const localNameBytes = view.getUint16(localOffset + 26, true);
    const localExtraBytes = view.getUint16(localOffset + 28, true);
    const localNameStart = localOffset + ZIP_LOCAL_FILE_HEADER_BYTES;
    const localNameEnd = localNameStart + localNameBytes;
    if (
      flags !== localFlags ||
      compression !== localCompression ||
      (kind !== null && compression !== 0 && compression !== 8) ||
      (kind !== null && (flags & 1) !== 0) ||
      localNameBytes > MAX_SLICE_ARCHIVE_ENTRY_NAME_BYTES ||
      localNameEnd + localExtraBytes > directoryOffset ||
      !equalBytes(centralName, buf.subarray(localNameStart, localNameEnd))
    ) {
      throw invalidZip();
    }
    if (
      (flags & 8) === 0 &&
      (compressedBytes !== localCompressedBytes || expandedBytes !== localExpandedBytes)
    ) {
      throw invalidZip();
    }
    cursor = entryEnd;
  }
  if (cursor !== directoryEnd) throw invalidZip();
  return entryCount;
}

function concatenate(chunks: readonly Uint8Array[], byteLength: number): Uint8Array {
  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function extractSliceZip(buf: Uint8Array): SliceResult {
  const expectedEntries = inspectSliceZipDirectory(buf);
  const ratioBudget = buf.byteLength * MAX_SLICE_ARCHIVE_COMPRESSION_RATIO;
  const expandedBudget = Math.min(MAX_SLICE_ARCHIVE_EXPANDED_BYTES, ratioBudget);
  let discoveredEntries = 0;
  let activeEntries = 0;
  let expandedBytes = 0;
  let failure: SlicerSidecarError | null = null;
  let gcode: Uint8Array = new Uint8Array(0);
  let thumbnail: Uint8Array = new Uint8Array(0);
  let thumbnailName: string | undefined;
  const unzip = new Unzip((file) => {
    discoveredEntries += 1;
    if (discoveredEntries > MAX_SLICE_ARCHIVE_ENTRIES) {
      failure = archiveTooLarge();
      file.terminate();
      return;
    }
    const kind = outputKind(file.name);
    if (!kind) {
      file.terminate();
      return;
    }
    if (
      file.originalSize !== undefined &&
      file.originalSize > MAX_SLICE_ARCHIVE_EXPANDED_BYTES
    ) {
      failure = archiveTooLarge();
      file.terminate();
      return;
    }

    activeEntries += 1;
    let entryBytes = 0;
    const chunks: Uint8Array[] = [];
    file.ondata = (error, chunk, final) => {
      if (failure) return;
      if (error) {
        failure = invalidZip(error);
        file.terminate();
        return;
      }
      entryBytes += chunk.byteLength;
      expandedBytes += chunk.byteLength;
      if (
        !Number.isSafeInteger(expandedBytes) ||
        expandedBytes > expandedBudget
      ) {
        failure = archiveTooLarge();
        file.terminate();
        return;
      }
      if (chunk.byteLength > 0) chunks.push(new Uint8Array(chunk));
      if (!final) return;
      activeEntries -= 1;
      if (file.originalSize !== undefined && entryBytes !== file.originalSize) {
        failure = invalidZip(new Error(`${file.name} expanded size does not match its header`));
        return;
      }
      const data = concatenate(chunks, entryBytes);
      if (kind === "gcode") {
        if (!gcode.length || data.length > gcode.length) gcode = data;
        return;
      }
      thumbnail = data;
      thumbnailName = file.name.split("/").pop();
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  try {
    for (let offset = 0; offset < buf.byteLength && !failure; offset += 4_096) {
      const end = Math.min(buf.byteLength, offset + 4_096);
      unzip.push(buf.subarray(offset, end), end === buf.byteLength);
    }
  } catch (error) {
    if (!failure) failure = invalidZip(error);
  }
  if (failure) throw failure;
  if (discoveredEntries !== expectedEntries || activeEntries !== 0) throw invalidZip();
  if (!gcode.length) {
    throw new SlicerSidecarError("Slicer sidecar zip contained no gcode", {
      code: "empty_gcode",
    });
  }
  return { gcode, thumbnail, ...(thumbnailName ? { thumbnail_filename: thumbnailName } : {}) };
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
