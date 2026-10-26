import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// pp-gateway commits this record after Node drains and exits gracefully, so Node
// only reads it at startup. Rust admits the record before launching Node.
export const OPERATION_CUTOVER_FILE = "operation-cutover.json";
const RECORD_LIMIT = 256 * 1024;

const cutoverRecordSchema = z.object({
  schema: z.literal("pp-operation-cutover-v1"),
  manifest_sha256: z.string(),
  operations: z.record(z.string(), z.object({
    parity_sha256: z.string(),
    fixtures: z.number().int().positive(),
    participants: z.array(z.string()),
  }).strict()),
}).strict();

const nodeFencedSchema = z.object({
  schema: z.literal("pp-node-fenced-participants-v1"),
  participants: z.array(z.string()),
}).strict();

// Participants Node skips when Rust owns them. pp-gateway reads the same file,
// and its tests pin the list to the fences app.ts implements.
function nodeFencedParticipants(): ReadonlySet<string> {
  const path = resolve(dirname(fileURLToPath(import.meta.url)), "../data/node-fenced-participants.json");
  return new Set(nodeFencedSchema.parse(JSON.parse(readFileSync(path, "utf8"))).participants);
}

function invalid(detail: string): never {
  throw new Error(`Operation cutover record is invalid: ${detail}`);
}

function readRecord(path: string): string | null {
  let fd: number;
  try {
    // Non-blocking so a planted FIFO cannot hang startup.
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    return invalid(error instanceof Error ? error.message : String(error));
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) invalid("not a regular file");
    if (stat.size > RECORD_LIMIT) invalid(`exceeds ${RECORD_LIMIT} bytes`);
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Which Node-fenced participants Rust owns. An absent record means Node owns
 * everything. A record Node cannot honor stops startup before any worker runs.
 */
export function rustOwnedNodeParticipants(dataDir: string): ReadonlySet<string> {
  const text = readRecord(join(dataDir, OPERATION_CUTOVER_FILE));
  if (text === null) return new Set();
  let parsed: z.infer<typeof cutoverRecordSchema>;
  try {
    parsed = cutoverRecordSchema.parse(JSON.parse(text));
  } catch (error) {
    return invalid(error instanceof Error ? error.message : String(error));
  }
  const fenced = nodeFencedParticipants();
  const owned = new Set<string>();
  for (const { participants } of Object.values(parsed.operations)) {
    for (const participant of participants) {
      if (participant.startsWith("http.")) continue;
      if (!fenced.has(participant)) {
        throw new Error(`Operation cutover assigns ${participant} to Rust, but Node cannot fence it`);
      }
      owned.add(participant);
    }
  }
  return owned;
}
