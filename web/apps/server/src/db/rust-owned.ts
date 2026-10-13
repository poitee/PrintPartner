import Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { processIdentity } from "../storage-lease.js";
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

// Linux compares boot_id:starttime. Elsewhere Rust stores a private instance token
// that Node cannot recompute, so two instance tokens still name one live process.
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
  if (actual === identity) return true;
  return actual.startsWith("instance:") && identity.startsWith("instance:");
}

function recordedChildIsLive(marker: RustOwnerMarker): boolean {
  if (marker.child_pid === undefined) return false;
  const identity = recordedIdentity(marker, "child_process_identity");
  if (!identity) return true;
  return processStillOwnsIdentity(marker.child_pid, identity);
}

type MarkerFile =
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "other" }
  | { readonly kind: "live"; readonly marker: RustOwnerMarker };

function readMarkerFile(dataDir: string): MarkerFile {
  const markerPath = join(dataDir, ".desktop-owner.json");
  if (!existsSync(markerPath)) return { kind: "missing" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    return { kind: "unreadable" };
  }
  if (!isRustOwnerMarker(parsed)) return { kind: "other" };
  const ownerLive = processStillOwnsIdentity(parsed.pid, recordedIdentity(parsed, "process_identity"));
  if (!ownerLive && !recordedChildIsLive(parsed)) return { kind: "other" };
  return { kind: "live", marker: parsed };
}

function isLeaseOwner(value: unknown): value is { pid: number; process_identity?: string } {
  if (typeof value !== "object" || value === null || !("pid" in value) || !isPid(value.pid)) return false;
  if (
    "process_identity" in value &&
    value.process_identity !== undefined &&
    typeof value.process_identity !== "string"
  ) {
    return false;
  }
  return true;
}

// The lease directory is published before the owner marker. A live other process
// holding it already owns the copy, including while the marker is still being written.
function leaseBlocksOtherWriters(dataDir: string): boolean {
  const ownerPath = join(dataDir, ".desktop-lease", "owner.json");
  if (!existsSync(ownerPath)) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(ownerPath, "utf8"));
  } catch {
    return true;
  }
  if (!isLeaseOwner(parsed)) return true;
  const identity = typeof parsed.process_identity === "string" ? parsed.process_identity : undefined;
  if (parsed.pid === process.pid && processStillOwnsIdentity(parsed.pid, identity)) return false;
  return processStillOwnsIdentity(parsed.pid, identity);
}

function isRecordedChild(marker: RustOwnerMarker): boolean {
  if (marker.child_pid !== process.pid) return false;
  const identity = recordedIdentity(marker, "child_process_identity");
  if (!identity) return false;
  return processStillOwnsIdentity(process.pid, identity);
}

export function rustOwnedCopy(dataDir: string): RustOwnedCopy {
  const marker = readMarkerFile(dataDir);
  if (marker.kind === "live") {
    if (isRecordedChild(marker.marker)) return { kind: "child" };
    return { kind: "foreign" };
  }
  if (marker.kind === "unreadable" || leaseBlocksOtherWriters(dataDir)) return { kind: "foreign" };
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

export function assertSupportedRustSchema(dbPath: string): void {
  const sqlite = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const version = readSchemaVersion(sqlite);
    if (version !== currentSchemaVersion) {
      throw new Error(
        `Rust-owned database schema ${version} is not the supported schema ${currentSchemaVersion}`,
      );
    }
  } finally {
    sqlite.close();
  }
}
