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

function readLiveRustMarker(dataDir: string): RustOwnerMarker | null {
  const markerPath = join(dataDir, ".desktop-owner.json");
  if (!existsSync(markerPath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    return null;
  }
  if (!isRustOwnerMarker(parsed)) return null;
  const ownerLive = processStillOwnsIdentity(parsed.pid, recordedIdentity(parsed, "process_identity"));
  if (!ownerLive && !recordedChildIsLive(parsed)) return null;
  return parsed;
}

function isRecordedChild(marker: RustOwnerMarker): boolean {
  if (marker.child_pid !== process.pid) return false;
  const identity = recordedIdentity(marker, "child_process_identity");
  if (!identity) return false;
  return processStillOwnsIdentity(process.pid, identity);
}

export function rustOwnedCopy(dataDir: string): RustOwnedCopy {
  const marker = readLiveRustMarker(dataDir);
  if (!marker) return { kind: "absent" };
  if (isRecordedChild(marker)) return { kind: "child" };
  return { kind: "foreign" };
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
