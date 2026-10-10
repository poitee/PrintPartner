import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { acquireStorageLease, ownerIsStale } from "./storage-lease.js";
import type { SessionUser } from "./routes/auth-types.js";

const setupSchema = z.strictObject({
  version: z.literal(1),
  data_dir: z.string().min(1),
  socket_path: z.string().min(1),
  generation: z.string().regex(/^[a-f0-9]{32}$/),
  key: z.string().regex(/^[a-f0-9]{64}$/),
  lease: z.string().regex(/^[a-f0-9]{64}$/),
  parent_pid: z.number().int().positive(),
  port: z.number().int().min(1).max(65535),
});
const markerSchema = z.object({ pid: z.number().int().positive(), lease_hash: z.string() });
const assertionSchema = z.strictObject({
  version: z.literal(1), generation: z.string(), tenant: z.literal("default"),
  actor: z.literal("desktop-owner"), method: z.string(), target: z.string(),
  issued_at: z.number().int().nonnegative(),
});
let context: z.infer<typeof setupSchema> | null = null;
const principals = new WeakMap<FastifyRequest, SessionUser>();

export function desktopContext() {
  return context && { data_dir: context.data_dir, socket_path: context.socket_path, parent_pid: context.parent_pid, port: context.port };
}

export function installDesktopContext(input: unknown): void {
  if (context) throw new Error("Desktop context already installed");
  const parsed = setupSchema.parse(input);
  const dataDir = realpathSync(parsed.data_dir);
  const markerPath = join(dataDir, ".desktop-owner.json");
  const marker = markerSchema.parse(JSON.parse(readFileSync(markerPath, "utf8")));
  const mode = statSync(markerPath).mode & 0o777;
  const inherited = fstatSync(198);
  const ownerLock = statSync(join(dataDir, ".desktop.lock"));
  if (inherited.dev !== ownerLock.dev || inherited.ino !== ownerLock.ino) throw new Error("Inherited storage lock rejected");
  const leaseHash = createHash("sha256").update(parsed.lease).digest("hex");
  if (marker.pid !== process.ppid || parsed.parent_pid !== process.ppid ||
      marker.lease_hash !== leaseHash || mode !== 0o600 || parsed.data_dir !== dataDir) {
    throw new Error("Desktop storage lease rejected");
  }
  context = parsed;
}

function assertDataDirectoryAvailable(dataDir: string): void {
  if (!existsSync(dataDir)) return;
  const canonical = realpathSync(dataDir);
  if (!existsSync(join(canonical, ".desktop-owner.json"))) return;
  if (context?.data_dir === canonical) return;
  // Under the shared storage lease, recover stale markers from either runtime.
  const owner = z.object({ pid: z.number().int().positive().max(2147483647), process_identity: z.string().optional(),
    kind: z.string().optional(), child_pid: z.number().int().positive().max(2147483647).optional(),
    child_process_identity: z.string().min(1).optional() })
    .safeParse(JSON.parse(readFileSync(join(canonical, ".desktop-owner.json"), "utf8")));
  if (owner.success && ownerIsStale(owner.data) && (owner.data.kind === "standalone" ||
      // Spawn records the child before setup permits it to open storage.
      (owner.data.child_pid === undefined && owner.data.child_process_identity === undefined) ||
      (owner.data.child_pid !== undefined && owner.data.child_process_identity !== undefined &&
       ownerIsStale({ pid: owner.data.child_pid, process_identity: owner.data.child_process_identity })))) {
    renameSync(join(canonical, ".desktop-owner.json"), join(canonical, ".desktop-lease", "previous-marker.json"));
    return;
  }
  throw new Error("Data directory is already owned; stop the other process before opening another writer");
}

export function desktopPrincipal(request: FastifyRequest): SessionUser | null {
  return principals.get(request) ?? null;
}

export function registerDesktopBoundary(app: FastifyInstance): void {
  const setup = context;
  if (!setup) return;
  app.addHook("onRequest", async (request, reply) => {
    const encoded = request.headers["x-pp-principal"];
    const signature = request.headers["x-pp-signature"];
    delete request.headers["x-pp-principal"];
    delete request.headers["x-pp-signature"];
    try {
      const principal = verifyDesktopPrincipal({ encoded, signature, method: request.method, target: request.url, now: Date.now() }, setup);
      principals.set(request, { user_id: principal.actor, tenant_id: principal.tenant,
        login: "desktop", display_name: "Desktop owner", email: null, provider: "desktop", is_admin: true });
    } catch {
      return reply.status(401).send({ detail: "Valid desktop principal required" });
    }
  });
}

export function verifyDesktopPrincipal(
  request: { encoded: unknown; signature: unknown; method: string; target: string; now: number },
  setup: { key: string; generation: string },
) {
  const { encoded, signature } = request;
  if (typeof encoded !== "string" || typeof signature !== "string" ||
      !/^[a-f0-9]{64}$/.test(signature) || !/^[a-f0-9]+$/.test(encoded) || encoded.length > 4096) {
    throw new Error("Desktop principal rejected");
  }
  const expected = createHmac("sha256", Buffer.from(setup.key, "hex")).update(encoded).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) throw new Error("Desktop principal rejected");
  const principal = assertionSchema.parse(JSON.parse(Buffer.from(encoded, "hex").toString("utf8")));
  const age = request.now - principal.issued_at;
  if (principal.generation !== setup.generation || principal.method !== request.method ||
      principal.target !== request.target || age < -1000 || age > 30_000) throw new Error("Desktop principal rejected");
  return principal;
}

export function acquireDataDirectory(dataDir: string): () => void {
  if (context) {
    if (realpathSync(dataDir) !== context.data_dir) throw new Error("Desktop storage lease rejected");
    return () => {};
  }
  mkdirSync(dataDir, { recursive: true });
  const canonical = realpathSync(dataDir);
  const lease = acquireStorageLease(canonical);
  const marker = join(canonical, ".desktop-owner.json");
  try {
    assertDataDirectoryAvailable(canonical);
    const fd = openSync(marker, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid, kind: "standalone", process_identity: lease.identity })); }
    catch (error) { rmSync(marker); throw error; }
    finally { closeSync(fd); }
  } catch (error) {
    lease.release();
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    // Preserve ownership if marker cleanup fails, so callers can retry safely.
    rmSync(marker);
    lease.release();
    released = true;
  };
}
