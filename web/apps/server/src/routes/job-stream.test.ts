import Fastify from "fastify";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import WebSocket from "ws";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobEvent, JobSnapshot } from "@print-partner/contracts";
import { getDb, SqliteDatabase } from "../db/client.js";
import { AppRepository } from "../db/repository.js";
import { loadConfig } from "../config.js";
import { registerTenantMiddleware } from "./auth.js";
import { registerJobWebSocket } from "./jobs.js";
import { AuthStore } from "../services/auth-store.js";
import { InProcessJobRunner } from "../services/job-runner.js";

class SimulatedJobRunner extends InProcessJobRunner {
  snapshot: JobSnapshot = {
    job_id: "local-job", kind: "sync", status: "running",
    message: "Working", progress: 10, result: null, error: null,
  };
  readonly subscribers = new Set<(event: JobSnapshot) => void>();

  async get(jobId: string, tenantId: string): Promise<JobSnapshot | null> {
    return jobId === this.snapshot.job_id && tenantId === "default" ? this.snapshot : null;
  }

  subscribe(jobId: string, tenantId: string, listener: (event: JobSnapshot) => void) {
    if (jobId !== this.snapshot.job_id || tenantId !== "default") return null;
    this.subscribers.add(listener);
    return () => { this.subscribers.delete(listener); };
  }

  publish(snapshot: JobSnapshot) {
    this.snapshot = snapshot;
    for (const listener of this.subscribers) listener(snapshot);
  }
}

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "pp-job-stream-"));
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const db = new SqliteDatabase(dataDir);
  db.connect();
  cleanup.push(() => db.close());
  const repository = new AppRepository(getDb(db), "default", db.reposDir);
  const auth = new AuthStore(getDb(db));
  const owner = auth.createUser({ displayName: "Owner" });
  const other = auth.createUser({ displayName: "Other" });
  const ownerCookie = `pp_session=${auth.createSession(owner.id)}`;
  const otherCookie = `pp_session=${auth.createSession(other.id)}`;
  const jobs = new SimulatedJobRunner({
    getRepo: () => repository, dataDir, reposDir: db.reposDir, exportsDir: join(dataDir, "exports"),
  });
  const app = Fastify({ forceCloseConnections: true });
  const requests: string[] = [];
  app.addHook("onRequest", async (request) => { requests.push(request.url); });
  const connections = new Set<Socket>();
  app.server.on("connection", (socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
  });
  cleanup.push(async () => {
    for (const socket of app.websocketServer.clients) socket.terminate();
    for (const socket of connections) socket.destroy();
    await app.close();
  });
  await app.register(cookie);
  registerTenantMiddleware(app, {
    ...loadConfig(), dataDir, multiUser: true, singleUserAuth: false, authRequired: true,
  }, auth);
  await app.register(websocket);
  registerJobWebSocket(app, jobs);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  return { app, jobs, auth, ownerCookie, otherCookie, address, requests };
}

async function client(address: string, sessionCookie: string) {
  vi.stubEnv("VITE_API_URL", address);
  vi.stubEnv("VITE_API_PREFIX", "/api/v2");
  vi.stubGlobal("WebSocket", class extends WebSocket {
    constructor(url: string) { super(url, { headers: { cookie: sessionCookie } }); }
  });
  vi.resetModules();
  const client = await vi.importActual<{
    connectJobWebSocket: (
      jobId: string, onEvent: (event: JobEvent) => void, onError: (error: Error) => void,
    ) => () => void;
  }>("../../../web/src/api/jobWebSocket.ts");
  return client.connectJobWebSocket;
}

describe("job stream through the bound Fastify route", () => {
  it("receives snapshots and terminal events with the stored owner session", async () => {
    const { jobs, ownerCookie, address, requests } = await fixture();
    const connect = await client(address, ownerCookie);
    const events: JobEvent[] = [];
    const errors: Error[] = [];
    const disconnect = connect("local-job", (event) => events.push(event), (error) => errors.push(error));
    cleanup.push(disconnect);
    await vi.waitFor(() => expect(events).toEqual([jobs.snapshot]), { timeout: 2000 });
    jobs.publish({ ...jobs.snapshot, status: "done", message: "Complete", progress: 100, result: {} });
    await vi.waitFor(() => expect(events.at(-1)?.status).toBe("done"));
    expect(errors).toEqual([]);
    process.stdout.write(JSON.stringify({ scenario: "authenticated-stream", paths: requests, frames: events }) + "\n");
  });

  it("reconnects and receives a fresh snapshot before later progress", async () => {
    const { app, jobs, ownerCookie, address, requests } = await fixture();
    const connect = await client(address, ownerCookie);
    const events: JobEvent[] = [];
    cleanup.push(connect("local-job", (event) => events.push(event), () => undefined));
    await vi.waitFor(() => expect(events).toHaveLength(1));
    for (const socket of app.websocketServer.clients) socket.terminate();
    await vi.waitFor(() => expect(jobs.subscribers.size).toBe(0));
    jobs.publish({ ...jobs.snapshot, message: "Resumed", progress: 50 });
    await vi.waitFor(() => expect(events.at(-1)?.progress).toBe(50), { timeout: 3000 });
    jobs.publish({ ...jobs.snapshot, message: "More progress", progress: 75 });
    await vi.waitFor(() => expect(events.at(-1)?.progress).toBe(75));
    expect(jobs.subscribers.size).toBe(1);
    process.stdout.write(JSON.stringify({ scenario: "reconnect", paths: requests, frames: events }) + "\n");
  });

  it("rejects missing and revoked sessions and hides jobs from another tenant", async () => {
    const { app, auth, ownerCookie, otherCookie, address } = await fixture();
    const streamUrl = address.replace("http:", "ws:") + "/ws/jobs/local-job";
    async function refused(sessionCookie: string) {
      return new Promise<number>((resolve, reject) => {
        const socket = new WebSocket(streamUrl, { headers: { cookie: sessionCookie } });
        cleanup.push(() => { socket.terminate(); });
        socket.on("unexpected-response", (request, response) => {
          response.resume();
          request.destroy();
          socket.terminate();
          resolve(response.statusCode ?? 0);
        });
        socket.on("error", () => undefined);
        socket.on("open", () => reject(new Error("Unauthorized connection upgraded")));
      });
    }
    const missing = await refused("");
    const invalid = await refused("pp_session=invalid");
    auth.deleteSession(ownerCookie.slice("pp_session=".length));
    const revoked = await refused(ownerCookie);
    expect({ missing, invalid, revoked }).toEqual({ missing: 401, invalid: 401, revoked: 401 });
    const other = new WebSocket(streamUrl, { headers: { cookie: otherCookie } });
    cleanup.push(() => { other.terminate(); });
    const frames: string[] = [];
    other.on("message", (frame) => frames.push(frame.toString()));
    const close = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
      other.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
      other.on("error", reject);
    });
    expect(close).toEqual({ code: 1008, reason: "Job not found" });
    expect(frames).toEqual([]);
    await vi.waitFor(() => expect(app.websocketServer.clients.size).toBe(0));
    process.stdout.write(JSON.stringify({ scenario: "authorization", missing, invalid, revoked, otherTenant: close, frames }) + "\n");
  });
});
