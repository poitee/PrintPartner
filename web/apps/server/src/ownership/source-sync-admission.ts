import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Node remains the Source Sync owner. Rust is rejected, not routed back here. */
export const SOURCE_SYNC_OPERATION = "source.sync";
export const SOURCE_SYNC_PARTICIPANTS = [
  "http.POST /jobs/sync",
  "http.POST /api/v1/jobs/sync",
  "http.POST /sources",
  "mcp.start_sync",
  "job.sync",
  "startup.startSourceWatcher",
  "worker.startSourceWatcher",
] as const;

const MANIFEST_FIELDS = new Set(["operation", "owner", "live_format", "participants"]);
const LIVE_FORMAT_FIELDS = new Set(["id", "rollback"]);
const PARTICIPANT_FIELDS = new Set(["id", "kind", "owner", "resources"]);
const KINDS = new Set(["http", "http_alias", "mcp_action", "job", "startup_watcher", "worker"]);

export class OwnershipAdmissionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "OwnershipAdmissionError";
    this.code = code;
  }
}

type RuntimeOwner = "node" | "rust";

type ParsedParticipant = {
  id: string;
  kind: string;
  owner: RuntimeOwner;
  resources: string[];
};

function fail(code: string, message: string): never {
  throw new OwnershipAdmissionError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownFields(value: Record<string, unknown>, allowed: Set<string>): string | null {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return key;
  }
  return null;
}

function parseOwner(value: unknown): RuntimeOwner {
  if (value === "node" || value === "compat") return "node";
  if (value === "rust") return "rust";
  return fail("unknown_owner", `unknown owner ${String(value)}`);
}

function resourceName(resource: string): string | null {
  if (resource.startsWith("table:")) return resource.slice("table:".length);
  if (resource.startsWith("file:")) return resource.slice("file:".length);
  return null;
}

export function defaultSourceSyncManifestPath(): string {
  const override = process.env.PP_SOURCE_SYNC_OWNERSHIP_MANIFEST;
  if (override) return override;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = resolve(dir, "rust/crates/pp-gateway/source-sync-ownership.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return fail("malformed", "malformed ownership manifest: source sync ownership manifest is missing");
}

export function admitSourceSyncManifest(text: string): {
  operation: string;
  owner: "node";
  participantIds: string[];
  manifestSha256: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return fail("malformed", `malformed ownership manifest: ${detail}`);
  }
  if (!isRecord(parsed)) return fail("malformed", "malformed ownership manifest: expected object");
  const extra = unknownFields(parsed, MANIFEST_FIELDS);
  if (extra) return fail("malformed", `malformed ownership manifest: unknown field ${extra}`);
  if (parsed.operation !== SOURCE_SYNC_OPERATION) {
    return fail("unknown_operation", `unknown operation ${String(parsed.operation)}`);
  }
  if (!isRecord(parsed.live_format)) {
    return fail("malformed", "malformed ownership manifest: live_format");
  }
  const liveExtra = unknownFields(parsed.live_format, LIVE_FORMAT_FIELDS);
  if (liveExtra) return fail("malformed", `malformed ownership manifest: unknown field ${liveExtra}`);
  const formatId = parsed.live_format.id;
  if (typeof formatId !== "string" || formatId.trim() === "") {
    return fail("unknown_live_format", `unknown live format rollback ${String(formatId)}`);
  }
  if (parsed.live_format.rollback === "incompatible") {
    return fail("incompatible_rollback", "incompatible live-format rollback for source.sync");
  }
  if (parsed.live_format.rollback !== "compatible") {
    return fail(
      "unknown_live_format",
      `unknown live format rollback ${String(parsed.live_format.rollback)}`,
    );
  }
  const operationOwner = parseOwner(parsed.owner);
  if (!Array.isArray(parsed.participants)) {
    return fail("malformed", "malformed ownership manifest: participants");
  }
  const seen = new Set<string>();
  const participants: ParsedParticipant[] = [];
  for (const entry of parsed.participants) {
    if (!isRecord(entry)) return fail("malformed", "malformed ownership manifest: participant");
    const participantExtra = unknownFields(entry, PARTICIPANT_FIELDS);
    if (participantExtra) {
      return fail("malformed", `malformed ownership manifest: unknown field ${participantExtra}`);
    }
    if (typeof entry.id !== "string" || entry.id === "") {
      return fail("malformed", "malformed ownership manifest: participant id");
    }
    if (seen.has(entry.id)) return fail("duplicate_participant", `duplicate participant ${entry.id}`);
    seen.add(entry.id);
    if (typeof entry.kind !== "string" || !KINDS.has(entry.kind)) {
      return fail("unknown_kind", `unknown participant kind ${String(entry.kind)}`);
    }
    if (!Array.isArray(entry.resources) || entry.resources.length === 0) {
      return fail("malformed", "malformed ownership manifest: participant resources must name a table or file");
    }
    const resources: string[] = [];
    for (const resource of entry.resources) {
      if (typeof resource !== "string" || !resourceName(resource)) {
        return fail("malformed", `malformed ownership manifest: resource ${String(resource)} is not table: or file:`);
      }
      resources.push(resource);
    }
    participants.push({
      id: entry.id,
      kind: entry.kind,
      owner: parseOwner(entry.owner),
      resources,
    });
  }
  const worker = participants.find((item) => item.kind === "worker");
  const startup = participants.find((item) => item.kind === "startup_watcher");
  if (worker && startup && worker.owner !== startup.owner) {
    return fail(
      "conflicting_participant",
      `conflicting ownership for source.sync: ${worker.id}:${worker.owner} vs ${startup.id}:${startup.owner}`,
    );
  }
  const resources = new Map<string, RuntimeOwner>();
  for (const participant of participants) {
    for (const resource of participant.resources) {
      const existing = resources.get(resource);
      if (existing && existing !== participant.owner) {
        return fail("conflicting_resource", `conflicting resource authority for ${resource}`);
      }
      resources.set(resource, participant.owner);
    }
    if (participant.owner !== operationOwner && (participant.owner === "rust" || operationOwner === "rust")) {
      return fail(
        "conflicting_participant",
        `conflicting ownership for source.sync: operation:${operationOwner} vs ${participant.id}:${participant.owner}`,
      );
    }
  }
  if (operationOwner === "rust" || participants.some((item) => item.owner === "rust")) {
    const participant = participants.find((item) => item.owner === "rust");
    return fail(
      "unsupported_rust_owner",
      `unsupported rust owner for ${participant?.id ?? SOURCE_SYNC_OPERATION}; Node remains the Source Sync owner`,
    );
  }
  const expected = new Set<string>(SOURCE_SYNC_PARTICIPANTS);
  const missing = [...expected].filter((id) => !seen.has(id));
  const unexpected = [...seen].filter((id) => !expected.has(id));
  if (missing.length > 0 || unexpected.length > 0) {
    return fail(
      "participant_set_mismatch",
      `participant set mismatch missing=${JSON.stringify(missing)} unexpected=${JSON.stringify(unexpected)}`,
    );
  }
  return {
    operation: SOURCE_SYNC_OPERATION,
    owner: "node",
    participantIds: [...seen],
    manifestSha256: createHash("sha256").update(text).digest("hex"),
  };
}

export function requireSourceSyncParticipant(id: string): void {
  const admitted = admitSourceSyncManifest(readFileSync(defaultSourceSyncManifestPath(), "utf8"));
  if (!admitted.participantIds.includes(id)) {
    fail("participant_set_mismatch", `participant set mismatch missing=${JSON.stringify([id])} unexpected=[]`);
  }
}

function runningAsCli(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return fileURLToPath(import.meta.url) === resolve(entry);
}

if (runningAsCli()) {
  const manifestFlag = process.argv.indexOf("--manifest");
  const participantFlag = process.argv.indexOf("--participant");
  try {
    if (manifestFlag >= 0) {
      process.env.PP_SOURCE_SYNC_OWNERSHIP_MANIFEST = process.argv[manifestFlag + 1];
    }
    if (participantFlag >= 0) {
      requireSourceSyncParticipant(process.argv[participantFlag + 1] ?? "");
    } else {
      admitSourceSyncManifest(readFileSync(defaultSourceSyncManifestPath(), "utf8"));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
