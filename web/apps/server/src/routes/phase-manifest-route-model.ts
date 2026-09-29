import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  type Stats,
} from "node:fs";
import { MAX_PHASE_MANIFEST_BYTES } from "../services/upload-limits.js";

function sameFileState(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

/** Read one regular phase manifest through a bounded, stable file descriptor. */
export function readPhaseManifestFile(path: string): string | null {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.size < 0 ||
      opened.size > MAX_PHASE_MANIFEST_BYTES
    ) {
      return null;
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = readSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
      if (read === 0) return null;
      offset += read;
    }
    if (!sameFileState(opened, fstatSync(descriptor))) return null;
    return bytes.toString("utf8");
  } catch {
    return null;
  } finally {
    if (descriptor != null) closeSync(descriptor);
  }
}

/**
 * Parse a source's pp-phases.json. Accepts a bare array or { phases: [...] }.
 * Every entry needs a name and a folders list. Order and dependency edges are
 * normalized so the client always receives the full shape.
 */
export function parsePhaseManifestText(text: string): Array<Record<string, unknown>> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  const rawPhases = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { phases?: unknown }).phases)
      ? (parsed as { phases: unknown[] }).phases
      : null;
  if (!rawPhases || !rawPhases.length) return null;

  const phases: Array<Record<string, unknown>> = [];
  for (const [index, entry] of rawPhases.entries()) {
    if (!entry || typeof entry !== "object") return null;
    const phase = entry as Record<string, unknown>;
    if (typeof phase.name !== "string" || !phase.name.trim()) return null;
    if (!Array.isArray(phase.folders) || phase.folders.some((folder) => typeof folder !== "string")) {
      return null;
    }
    phases.push({
      ...phase,
      order: typeof phase.order === "number" ? phase.order : index,
      depends_on: Array.isArray(phase.depends_on)
        ? phase.depends_on.filter((dependency) => typeof dependency === "string")
        : [],
    });
  }
  return phases;
}
