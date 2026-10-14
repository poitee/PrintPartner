import Fastify from "fastify";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import WebSocket from "ws";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  unsubscribeCalls = 0;
  lookup: (() => Promise<JobSnapshot | null>) | null = null;
  readonly subscribers = new Set<(event: JobSnapshot) => void>();

  async get(jobId: string, tenantId: string): Promise<JobSnapshot | null> {
    if (this.lookup) return this.lookup();
    return jobId === this.snapshot.job_id && tenantId === "default" ? this.snapshot : null;
  }

  subscribe(jobId: string, tenantId: string, listener: (event: JobSnapshot) => void) {
    if (jobId !== this.snapshot.job_id || tenantId !== "default") return null;
    this.subscribers.add(listener);
    return () => { this.unsubscribeCalls++; this.subscribers.delete(listener); };
  }

  publish(snapshot: JobSnapshot) {
    this.snapshot = snapshot;
    for (const listener of this.subscribers) listener({ ...snapshot });
  }
}

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  vi.restoreAllMocks();
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
  const ownerCookie = `pp_session=${auth.createSession(owner.id, "email")}`;
  const otherCookie = `pp_session=${auth.createSession(other.id, "email")}`;
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

describe.each([undefined, "1"])("job stream through the bound Fastify route, gate %s", (gate) => {
  beforeEach(() => {
    if (gate === undefined) vi.stubEnv("PP_DESKTOP_REBUILD", undefined);
    else vi.stubEnv("PP_DESKTOP_REBUILD", gate);
  });
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}

async function transport(address: string, sessionCookie: string) {
  const socket = new WebSocket(address.replace("http:", "ws:") + "/ws/jobs/local-job", {
    headers: { cookie: sessionCookie },
  });
  cleanup.push(() => socket.terminate());
  const frames: string[] = [];
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
  socket.on("message", (frame) => frames.push(frame.toString()));
  await new Promise<void>((resolve, reject) => {
    socket.on("open", resolve);
    socket.on("error", reject);
  });
  return { socket, frames, closed };
}

const runningFrame = '{"job_id":"local-job","kind":"sync","status":"running","message":"Working","progress":10,"result":null,"error":null}';
const progressFrame = '{"job_id":"local-job","kind":"sync","status":"running","message":"Progress","progress":50,"result":null,"error":null}';
const doneFrame = '{"job_id":"local-job","kind":"sync","status":"done","message":"Complete","progress":100,"result":{},"error":null}';

async function heldLookup() {
  const context = await fixture();
  const started = deferred<void>();
  const result = deferred<JobSnapshot | null>();
  const baseline = { ...context.jobs.snapshot };
  context.jobs.lookup = () => { started.resolve(); return result.promise; };
  const peer = await transport(context.address, context.ownerCookie);
  await started.promise;
  return { ...context, ...peer, result, baseline };
}

describe("enabled job stream lifecycle", () => {
  beforeEach(() => vi.stubEnv("PP_DESKTOP_REBUILD", "true"));

  it("coalesces progress across a detached lookup", async () => {
    const { jobs, frames, result, baseline } = await heldLookup();
    jobs.publish({ ...baseline, message: "Earlier", progress: 25 });
    jobs.publish({ ...baseline, message: "Progress", progress: 50 });
    expect(frames).toEqual([]);
    result.resolve(baseline);
    await vi.waitFor(() => expect(frames).toEqual([progressFrame]));
    expect(jobs.subscribers.size).toBe(1);
    jobs.publish({ ...baseline, message: "Working", progress: 10 });
    await vi.waitFor(() => expect(frames).toEqual([progressFrame, runningFrame]));
  });

  it.each(["done", "error", "cancelled"] as const)("keeps a pending terminal %s ahead of later running updates and stale lookup", async (status) => {
    const { jobs, frames, closed, result, baseline } = await heldLookup();
    jobs.publish({ ...baseline, status, message: "Complete", progress: 100, result: {} });
    jobs.publish({ ...baseline, message: "Progress", progress: 50 });
    result.resolve(baseline);
    expect(await closed).toEqual({ code: 1005, reason: "" });
    expect(frames).toEqual([`{"job_id":"local-job","kind":"sync","status":"${status}","message":"Complete","progress":100,"result":{},"error":null}`]);
    expect(jobs.subscribers.size).toBe(0);
    expect(jobs.unsubscribeCalls).toBe(1);
  });

  it("prefers a mutable terminal lookup over buffered running progress", async () => {
    const { jobs, frames, closed, result, baseline } = await heldLookup();
    jobs.publish({ ...baseline, message: "Progress", progress: 50 });
    baseline.status = "cancelled";
    result.resolve(baseline);
    expect(await closed).toEqual({ code: 1005, reason: "" });
    expect(frames).toEqual(['{"job_id":"local-job","kind":"sync","status":"cancelled","message":"Working","progress":10,"result":null,"error":null}']);
    expect(jobs.subscribers.size).toBe(0);
    expect(jobs.unsubscribeCalls).toBe(1);
  });

  it.each(["resolve", "reject"])("releases before late lookup %s after peer disconnect", async (settlement) => {
    const { jobs, frames, socket, closed, result, baseline } = await heldLookup();
    socket.close();
    await closed;
    await vi.waitFor(() => expect(jobs.subscribers.size).toBe(0));
    if (settlement === "resolve") result.resolve(baseline);
    else result.reject(new Error("Late lookup failure"));
    await result.promise.catch(() => undefined);
    expect(frames).toEqual([]);
    expect(jobs.subscribers.size).toBe(0);
    expect(jobs.unsubscribeCalls).toBe(1);
  });

  it.each(["done", "error", "cancelled"] as const)("sends an initial %s snapshot before closing", async (status) => {
    const { jobs, address, ownerCookie } = await fixture();
    jobs.snapshot.status = status;
    const { frames, closed } = await transport(address, ownerCookie);
    expect(await closed).toEqual({ code: 1005, reason: "" });
    expect(frames).toEqual([`{"job_id":"local-job","kind":"sync","status":"${status}","message":"Working","progress":10,"result":null,"error":null}`]);
    expect(jobs.subscribers.size).toBe(0);
    expect(jobs.unsubscribeCalls).toBe(1);
  });

  it("streams progress and a full terminal snapshot", async () => {
    const { jobs, address, ownerCookie } = await fixture();
    const { frames, closed } = await transport(address, ownerCookie);
    await vi.waitFor(() => expect(frames).toEqual([runningFrame]));
    jobs.publish({ ...jobs.snapshot, message: "Progress", progress: 50 });
    jobs.publish({ ...jobs.snapshot, status: "done", message: "Complete", progress: 100, result: {} });
    expect(await closed).toEqual({ code: 1005, reason: "" });
    expect(frames).toEqual([runningFrame, progressFrame, doneFrame]);
    expect(jobs.subscribers.size).toBe(0);
    expect(jobs.unsubscribeCalls).toBe(1);
  });

  it.each(["null", "reject"])("contains a lookup %s", async (outcome) => {
    const { jobs, frames, closed, result, baseline } = await heldLookup();
    jobs.publish({ ...baseline, message: "Progress", progress: 50 });
    if (outcome === "null") result.resolve(null);
    else result.reject(new Error("Private lookup detail"));
    expect(await closed).toEqual(outcome === "null"
      ? { code: 1008, reason: "Job not found" }
      : { code: 1011, reason: "Job stream unavailable" });
    expect(frames).toEqual([]);
    expect(jobs.subscribers.size).toBe(0);
    expect(jobs.unsubscribeCalls).toBe(1);
  });

  it("closes without a frame when subscription is missing", async () => {
    const { jobs, address, ownerCookie } = await fixture();
    vi.spyOn(jobs, "subscribe").mockReturnValue(null);
    const { frames, closed } = await transport(address, ownerCookie);
    expect(await closed).toEqual({ code: 1008, reason: "Job not found" });
    expect(frames).toEqual([]);
    expect(jobs.subscribers.size).toBe(0);
    expect(jobs.unsubscribeCalls).toBe(0);
  });

  it.each(["throw", "callback"])("contains initial send %s with a healthy peer", async (failure) => {
    const { app, jobs, frames, closed, result, baseline, address, ownerCookie } = await heldLookup();
    const server = [...app.websocketServer.clients][0];
    if (!server) throw new Error("Missing accepted socket");
    vi.spyOn(server, "send").mockImplementation((_data, optionsOrCallback, callback) => {
      if (failure === "throw") throw new Error("Initial send failed");
      const done = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
      done?.(new Error("Initial callback failed"));
    });
    jobs.lookup = null;
    const healthy = await transport(address, ownerCookie);
    await vi.waitFor(() => expect(healthy.frames).toEqual([runningFrame]));
    result.resolve(baseline);
    expect(await closed).toEqual({ code: 1011, reason: "Job stream unavailable" });
    expect(frames).toEqual([]);
    jobs.publish({ ...baseline, message: "Progress", progress: 50 });
    await vi.waitFor(() => expect(healthy.frames).toEqual([runningFrame, progressFrame]));
    expect(jobs.subscribers.size).toBe(1);
    expect(jobs.unsubscribeCalls).toBe(1);
  });

  it("production client reconnects to a terminal snapshot completed while disconnected", async () => {
    const { app, jobs, address, ownerCookie, requests } = await fixture();
    const connect = await client(address, ownerCookie);
    const events: JobEvent[] = [];
    const errors: Error[] = [];
    cleanup.push(connect("local-job", (event) => events.push(event), (error) => errors.push(error)));
    await vi.waitFor(() => expect(events).toHaveLength(1));
    for (const socket of app.websocketServer.clients) socket.terminate();
    await vi.waitFor(() => expect(jobs.subscribers.size).toBe(0));
    jobs.publish({ ...jobs.snapshot, status: "done", message: "Complete", progress: 100, result: {} });
    await vi.waitFor(() => expect(events.map((event) => JSON.stringify(event))).toEqual([runningFrame, doneFrame]), { timeout: 3000 });
    expect(requests).toEqual(["/ws/jobs/local-job", "/ws/jobs/local-job"]);
    expect(errors).toEqual([]);
    expect(jobs.subscribers.size).toBe(0);
    expect(jobs.unsubscribeCalls).toBe(2);
  });

  it("production client rechecks a session revoked between connections", async () => {
    const { app, jobs, auth, address, ownerCookie, requests } = await fixture();
    const connect = await client(address, ownerCookie);
    const events: JobEvent[] = [];
    const errors: Error[] = [];
    const disconnect = connect("local-job", (event) => events.push(event), (error) => {
      errors.push(error);
      disconnect();
    });
    cleanup.push(disconnect);
    await vi.waitFor(() => expect(events.map((event) => JSON.stringify(event))).toEqual([runningFrame]));
    auth.deleteSession(ownerCookie.slice("pp_session=".length));
    for (const socket of app.websocketServer.clients) socket.terminate();
    await vi.waitFor(() => expect(errors.map((error) => error.message)).toEqual(["Job event stream failed"]), { timeout: 3000 });
    expect(requests).toEqual(["/ws/jobs/local-job", "/ws/jobs/local-job"]);
    expect(events.map((event) => JSON.stringify(event))).toEqual([runningFrame]);
    expect(jobs.subscribers.size).toBe(0);
    expect(jobs.unsubscribeCalls).toBe(1);
  });

  it("releases when progress reaches a socket already closing", async () => {
    const { app, jobs, address, ownerCookie } = await fixture();
    const peer = await transport(address, ownerCookie);
    await vi.waitFor(() => expect(peer.frames).toEqual([runningFrame]));
    const server = [...app.websocketServer.clients][0];
    if (!server) throw new Error("Missing accepted socket");
    server.close();
    jobs.publish({ ...jobs.snapshot, message: "Progress", progress: 50 });
    expect(jobs.subscribers.size).toBe(0);
    expect(jobs.unsubscribeCalls).toBe(1);
    expect(await peer.closed).toEqual({ code: 1005, reason: "" });
    expect(peer.frames).toEqual([runningFrame]);
  });

  it("contains a terminal callback failure after cleanup and a failed close", async () => {
    const { app, jobs, address, ownerCookie } = await fixture();
    const peer = await transport(address, ownerCookie);
    await vi.waitFor(() => expect(peer.frames).toEqual([runningFrame]));
    const server = [...app.websocketServer.clients][0];
    if (!server) throw new Error("Missing accepted socket");
    const callback = deferred<(error?: Error) => void>();
    vi.spyOn(server, "send").mockImplementation((_data, optionsOrCallback, done) => {
      const handler = typeof optionsOrCallback === "function" ? optionsOrCallback : done;
      if (!handler) throw new Error("Missing send callback");
      callback.resolve(handler);
    });
    const closes: Array<{ code: number | undefined; reason: string | Buffer | undefined }> = [];
    vi.spyOn(server, "close").mockImplementation((code, reason) => {
      closes.push({ code, reason });
      if (code === 1011) throw new Error("Close failed");
    });
    jobs.publish({ ...jobs.snapshot, status: "done", message: "Complete", progress: 100, result: {} });
    expect(jobs.subscribers.size).toBe(0);
    expect(jobs.unsubscribeCalls).toBe(1);
    expect(closes).toEqual([{ code: undefined, reason: undefined }]);
    const failSend = await callback.promise;
    failSend(new Error("Terminal write failed"));
    failSend(new Error("Repeated callback"));
    expect(await peer.closed).toEqual({ code: 1006, reason: "" });
    expect(closes).toEqual([
      { code: undefined, reason: undefined },
      { code: 1011, reason: "Job stream unavailable" },
    ]);
    expect(peer.frames).toEqual([runningFrame]);
    expect(jobs.subscribers.size).toBe(0);
    expect(jobs.unsubscribeCalls).toBe(1);
  });

  it.each(["throw", "callback"])("contains send %s while another peer receives progress", async (failure) => {
    const { app, jobs, address, ownerCookie } = await fixture();
    const broken = await transport(address, ownerCookie);
    await vi.waitFor(() => expect(broken.frames).toEqual([runningFrame]));
    const server = [...app.websocketServer.clients][0];
    if (!server) throw new Error("Missing accepted socket");
    vi.spyOn(server, "send").mockImplementation((_data, optionsOrCallback, callback) => {
      if (failure === "throw") throw new Error("Private send detail");
      const done = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
      done?.(new Error("Private callback detail"));
    });
    const healthy = await transport(address, ownerCookie);
    await vi.waitFor(() => expect(healthy.frames).toEqual([runningFrame]));
    jobs.publish({ ...jobs.snapshot, message: "Progress", progress: 50 });
    expect(await broken.closed).toEqual({ code: 1011, reason: "Job stream unavailable" });
    await vi.waitFor(() => expect(healthy.frames).toEqual([runningFrame, progressFrame]));
    expect(jobs.subscribers.size).toBe(1);
    expect(jobs.unsubscribeCalls).toBe(1);
  });
});

it.each([undefined, "", "0", "false", "TRUE", "True", " 1", "1 ", "yes", "1", "true"])(
  "captures the exact rebuild gate %s at registration", async (gate) => {
    if (gate === undefined) vi.stubEnv("PP_DESKTOP_REBUILD", undefined);
    else vi.stubEnv("PP_DESKTOP_REBUILD", gate);
    const context = await fixture();
    vi.stubEnv("PP_DESKTOP_REBUILD", gate === "1" || gate === "true" ? "false" : "true");
    const started = deferred<void>();
    const result = deferred<JobSnapshot | null>();
    const baseline = { ...context.jobs.snapshot };
    context.jobs.lookup = () => { started.resolve(); return result.promise; };
    const { frames } = await transport(context.address, context.ownerCookie);
    await started.promise;
    expect(context.jobs.subscribers.size).toBe(gate === "1" || gate === "true" ? 1 : 0);
    context.jobs.publish({ ...baseline, message: "Progress", progress: 50 });
    result.resolve(baseline);
    await vi.waitFor(() => expect(frames).toEqual([
      gate === "1" || gate === "true" ? progressFrame : runningFrame,
    ]));
  },
);
