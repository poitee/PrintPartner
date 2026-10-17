import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { desktopOwnsDataDirectory } from "../desktop-child-credential.js";
import { processIdentity, readOwnershipRecord, storageParentIdentityEnv } from "../storage-lease.js";
import { currentSchemaVersion } from "./schema.js";
import { readSchemaVersion } from "./upgrade-guard.js";

type RustOwnedCopy =
  | { readonly kind: "absent" }
  | { readonly kind: "foreign" }
  | { readonly kind: "child" };

type RustOwnerMarker = {
  readonly storage_protocol_version: 1;
  readonly pid: number;
  readonly process_identity?: string;
  readonly child_pid?: number;
  readonly child_process_identity?: string;
};

function isPid(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 2147483647;
}

function isRustOwnerMarker(value: unknown): value is RustOwnerMarker {
  if (typeof value !== "object" || value === null) return false;
  if (!("storage_protocol_version" in value) || value.storage_protocol_version !== 1) return false;
  if (!("pid" in value) || !isPid(value.pid)) return false;
  if (
    "process_identity" in value &&
    value.process_identity !== undefined &&
    typeof value.process_identity !== "string"
  ) {
    return false;
  }
  if ("child_pid" in value && value.child_pid !== undefined && !isPid(value.child_pid)) return false;
  if (
    "child_process_identity" in value &&
    value.child_process_identity !== undefined &&
    typeof value.child_process_identity !== "string"
  ) {
    return false;
  }
  return true;
}

function recordedIdentity(marker: RustOwnerMarker, key: "process_identity" | "child_process_identity"): string | undefined {
  const value = marker[key];
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value;
}

// A live process owns the recorded identity only when it still matches.
// A missing lookup fails closed. PID reuse is not ownership.
function processStillOwnsIdentity(pid: number, identity: string | undefined): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
  if (!identity) return true;
  let actual: string;
  try {
    actual = processIdentity(pid);
  } catch {
    return true;
  }
  return actual === identity;
}

function recordedChildIsLive(marker: RustOwnerMarker): boolean {
  if (marker.child_pid === undefined) return false;
  const identity = recordedIdentity(marker, "child_process_identity");
  if (!identity) return true;
  if (marker.child_pid === process.pid) return isRecordedChild(marker);
  return processStillOwnsIdentity(marker.child_pid, identity);
}

type MarkerFile =
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "retirable" }
  | { readonly kind: "unrecognized" }
  | { readonly kind: "live"; readonly marker: RustOwnerMarker };

function recordOf(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return value as Record<string, unknown>;
}

// Standalone Node retains recovery of legacy protocol markers.
function markerIsRetirable(value: unknown): boolean {
  const record = recordOf(value);
  if (!record || !isPid(record.pid)) return false;
  const ownerIdentity = typeof record.process_identity === "string" ? record.process_identity : undefined;
  if (processStillOwnsIdentity(record.pid, ownerIdentity)) return false;
  if (record.kind === "standalone") return true;
  const childPidPresent = "child_pid" in record && record.child_pid !== undefined;
  const childIdentityPresent = "child_process_identity" in record && record.child_process_identity !== undefined;
  if (record.storage_protocol_version === 1 && !childPidPresent && !childIdentityPresent) return true;
  if (!isPid(record.child_pid) || typeof record.child_process_identity !== "string") return false;
  if (record.child_process_identity.length === 0) return false;
  return !processStillOwnsIdentity(record.child_pid, record.child_process_identity);
}

function markerIsOurStandalone(value: unknown): boolean {
  const record = recordOf(value);
  if (!record || record.kind !== "standalone" || record.pid !== process.pid) return false;
  const identity = typeof record.process_identity === "string" && record.process_identity.length > 0
    ? record.process_identity
    : undefined;
  return processStillOwnsIdentity(process.pid, identity);
}

function readMarkerFile(dataDir: string): MarkerFile {
  const markerPath = join(dataDir, ".desktop-owner.json");
  if (!existsSync(markerPath)) return { kind: "missing" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readOwnershipRecord(markerPath));
  } catch {
    return { kind: "unreadable" };
  }
  if (isRustOwnerMarker(parsed)) {
    const ownerLive = processStillOwnsIdentity(parsed.pid, recordedIdentity(parsed, "process_identity"));
    if (ownerLive || recordedChildIsLive(parsed)) return { kind: "live", marker: parsed };
  }
  if (markerIsRetirable(parsed) || markerIsOurStandalone(parsed)) return { kind: "retirable" };
  return { kind: "unrecognized" };
}

function isCompleteLeaseOwner(value: unknown): value is { pid: number; process_identity: string } {
  const record = recordOf(value);
  if (!record || !isPid(record.pid)) return false;
  if (typeof record.process_identity !== "string" || record.process_identity.length === 0) return false;
  return typeof record.instance === "string" && /^[0-9a-fA-F]{32}$/.test(record.instance);
}

// Standalone Node recovers only complete legacy lease records.
function leaseBlocksOtherWriters(dataDir: string): boolean {
  const leaseDir = join(dataDir, ".desktop-lease");
  if (!existsSync(leaseDir)) return false;
  const ownerPath = join(leaseDir, "owner.json");
  if (!existsSync(ownerPath)) return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readOwnershipRecord(ownerPath));
  } catch {
    return true;
  }
  if (!isCompleteLeaseOwner(parsed)) return true;
  if (parsed.pid === process.pid && processStillOwnsIdentity(parsed.pid, parsed.process_identity)) return false;
  return processStillOwnsIdentity(parsed.pid, parsed.process_identity);
}

function isRecordedChild(marker: RustOwnerMarker): boolean {
  if (marker.child_pid !== process.pid) return false;
  const identity = recordedIdentity(marker, "child_process_identity");
  if (!identity) return false;
  try {
    return processIdentity(process.pid) === identity;
  } catch {
    return false;
  }
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readOwnershipRecord(path));
  } catch {
    return null;
  }
}

/** True when the live standalone writer that reserved the copy is this process's parent. */
export function parentReservedCopy(dataDir: string): boolean {
  const lease = readJson(join(dataDir, ".desktop-lease", "owner.json"));
  if (!isCompleteLeaseOwner(lease) || lease.pid !== process.ppid) return false;
  // The parent hands over its identity explicitly. Off Linux the identity lookup
  // below cannot tell a reused PID apart, so the credential is what authenticates.
  if (process.env[storageParentIdentityEnv] !== lease.process_identity) return false;
  const marker = recordOf(readJson(join(dataDir, ".desktop-owner.json")));
  if (!marker || marker.kind !== "standalone" || marker.pid !== process.ppid) return false;
  if (marker.process_identity !== lease.process_identity) return false;
  return processStillOwnsIdentity(lease.pid, lease.process_identity);
}

export function rustOwnedCopy(dataDir: string): RustOwnedCopy {
  if (desktopOwnsDataDirectory(dataDir)) return { kind: "child" };
  const marker = readMarkerFile(dataDir);
  if (marker.kind === "live") {
    if (isRecordedChild(marker.marker)) return { kind: "child" };
    return { kind: "foreign" };
  }
  if (marker.kind === "unreadable" || marker.kind === "unrecognized" || leaseBlocksOtherWriters(dataDir)) {
    return { kind: "foreign" };
  }
  return { kind: "absent" };
}

/** True only when the file exists and app_settings already stamps the supported schema. */
export function databaseSchemaIsCurrent(dbPath: string): boolean {
  if (!existsSync(dbPath)) return false;
  const sqlite = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return readSchemaVersion(sqlite) === currentSchemaVersion;
  } finally {
    sqlite.close();
  }
}
