import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";
import { chromium } from "playwright-core";
import { browserExecutable } from "./browserExecutable.mjs";

// These modules come from the build that precedes browser verification.
const serverRuntime = new URL("../../../server/dist/current/", import.meta.url);
const { startServer } = await import(new URL("app.js", serverRuntime).href);
const { loadConfig } = await import(new URL("config.js", serverRuntime).href);

// Hold GitHub API calls so the update-check job stays open long enough for the
// browser to drop the socket and take the next snapshot.
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init) => {
  const target = input instanceof globalThis.Request ? input.url : String(input);
  if (target.includes("api.github.com")) {
    const signal = init?.signal ?? (input instanceof globalThis.Request ? input.signal : undefined);
    return new Promise((_resolve, reject) => {
      const abort = () => reject(signal?.reason ?? new Error("GitHub fixture aborted"));
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  }
  return realFetch(input, init);
};

let queue = Promise.resolve();

function serial(name, fn) {
  test(name, async () => {
    const previous = queue;
    let release;
    queue = new Promise((resolve) => { release = resolve; });
    await previous;
    try { await fn(); }
    finally { release(); }
  });
}

function waitFor(predicate, label, timeoutMs = 20_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) resolve();
      else if (Date.now() - started > timeoutMs) reject(new Error(`timed out waiting for ${label}`));
      else globalThis.setTimeout(tick, 50);
    };
    tick();
  });
}

function gate() {
  let open = () => {};
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
}

async function api(origin, path, init) {
  const response = await realFetch(`${origin}${path}`, {
    ...init,
    headers: {
      Origin: origin,
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const text = await response.text();
  assert.equal(response.status, 200, `${init?.method ?? "GET"} ${path}: ${text}`);
  return text ? JSON.parse(text) : null;
}

serial("desktop_rebuild_flag_off_keeps_existing_flow", () => prove(false));
serial("desktop_rebuild_opt_in_save_and_reconnect", () => prove(true));

async function prove(rebuild) {
  if (rebuild) process.env.PP_DESKTOP_REBUILD = "1";
  else delete process.env.PP_DESKTOP_REBUILD;

  const data = await mkdtemp(join(tmpdir(), "pp-gre-825-"));
  let app;
  let ports;
  let browser;
  let releaseLayers = () => {};
  try {
    await accessDist();
    ({ app, ports } = await startServer({
      ...loadConfig(),
      dataDir: data,
      host: "127.0.0.1",
      port: 0,
      deployMode: "self-host",
      multiUser: false,
      singleUserAuth: false,
      authRequired: false,
      sessionCookieSecure: false,
      databaseUrl: null,
      staticDir: fileURLToPath(new URL("../../dist", import.meta.url)),
    }));
    const address = app.server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const planId = await seedPlan(origin, data);

    browser = await chromium.launch({ executablePath: browserExecutable(), headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    const seen = observe(page, planId);
    await page.addInitScript(() => {
      const NativeWebSocket = globalThis.WebSocket;
      const opened = [];
      globalThis.__ppJobSockets = opened;
      function JobSocket(url, protocols) {
        const socket = protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
        opened.push(socket);
        return socket;
      }
      JobSocket.prototype = NativeWebSocket.prototype;
      JobSocket.CONNECTING = NativeWebSocket.CONNECTING;
      JobSocket.OPEN = NativeWebSocket.OPEN;
      JobSocket.CLOSING = NativeWebSocket.CLOSING;
      JobSocket.CLOSED = NativeWebSocket.CLOSED;
      globalThis.WebSocket = JobSocket;
    });
    // The Plan page applies the open draft once layers load. Hold that read so
    // Save pending choices can publish quantity 2 on the draft first.
    const layers = gate();
    releaseLayers = layers.open;
    await page.route((url) => url.pathname === `/plans/${planId}/layers`, async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      await layers.promise;
      await route.continue();
    });

    await page.goto(`${origin}/plan?profile=${planId}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Plan", exact: true }).waitFor();
    await waitFor(() => seen.healthCapabilities !== null, "health");
    assert.equal(seen.healthCapabilities.includes("tenant_feature_toggles"), rebuild);
    if (rebuild) {
      await waitFor(() => seen.reviews.some((row) => row.started >= seen.healthAt && row.status === 200), "opted-in plan review");
      await page.getByRole("heading", { name: "Plan feature toggles", exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Print farm: Inherit" }).getAttribute("aria-pressed"), "true");
    } else {
      await waitFor(() => seen.reviews.some((row) => row.status === 200), "plan review");
      assert.equal(await page.getByRole("heading", { name: "Plan feature toggles", exact: true }).count(), 0);
    }

    const form = page.getByRole("form", { name: "Pending Plan files" });
    await form.waitFor();
    await form.getByRole("spinbutton", { name: "Quantity for bracket.stl" }).fill("2");
    const patched = page.waitForResponse((response) => {
      const path = new URL(response.url()).pathname;
      return response.request().method() === "PATCH" && /^\/plans\/\d+\/drafts\/\d+\/parts$/.test(path);
    });
    const applied = page.waitForResponse((response) => {
      const path = new URL(response.url()).pathname;
      return response.request().method() === "POST" && /^\/plans\/\d+\/drafts\/\d+\/apply$/.test(path);
    });
    await form.getByRole("button", { name: "Save pending choices" }).click();
    const patchResponse = await patched;
    const patchText = await patchResponse.text();
    assert.equal(patchResponse.status(), 200, patchText);
    assert.equal(draftQuantity(JSON.parse(patchText)), 2);
    const applyResponse = await applied;
    const applyText = await applyResponse.text();
    assert.equal(applyResponse.status(), 200, applyText);
    layers.open();
    releaseLayers = () => {};

    await page.reload({ waitUntil: "domcontentloaded" });
    const kept = page.locator("#plan-parts").getByRole("spinbutton", { name: "Quantity for bracket.stl" });
    await kept.waitFor();
    assert.equal(await kept.inputValue(), "2");

    await page.goto(`${origin}/settings`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Source update checks", exact: true }).waitFor();
    if (rebuild) {
      await page.getByRole("heading", { name: "Feature toggles", exact: true }).waitFor();
      assert.equal(await page.getByRole("switch", { name: "Print farm", exact: true }).getAttribute("aria-checked"), "false");
      assert.equal(await page.getByRole("switch", { name: "Orders", exact: true }).getAttribute("aria-checked"), "false");
      assert.equal(await page.getByRole("switch", { name: "Bambu printers", exact: true }).getAttribute("aria-checked"), "false");
      assert.equal(await page.getByRole("switch", { name: "Spoolman", exact: true }).getAttribute("aria-checked"), "false");
    } else {
      assert.equal(await page.getByRole("heading", { name: "Feature toggles", exact: true }).count(), 0);
    }
    const features = await page.evaluate(async (url) => (await globalThis.fetch(url)).status, `${origin}/settings/features`);
    assert.equal(features, rebuild ? 200 : 404);

    const started = page.waitForResponse((response) => {
      const path = new URL(response.url()).pathname;
      return response.request().method() === "POST" && path === "/jobs/check-source-updates";
    });
    await page.getByRole("button", { name: "Check now", exact: true }).click();
    const startedText = await (await started).text();
    const jobId = JSON.parse(startedText).job_id;
    assert.equal(typeof jobId, "string");
    const mine = () => seen.sockets.filter((socket) => socket.url.endsWith(`/ws/jobs/${jobId}`));
    await waitFor(() => mine().some((socket) => socket.frames.length > 0), "job socket snapshot");
    const first = mine().find((socket) => socket.frames.length > 0);
    const firstEvent = JSON.parse(first.frames.at(-1));
    assert.equal(firstEvent.status === "done" || firstEvent.status === "error", false);
    await page.evaluate((id) => {
      const sockets = globalThis.__ppJobSockets ?? [];
      const open = sockets.filter((socket) => socket.url.endsWith(`/ws/jobs/${id}`) && socket.readyState === 1);
      if (open.length === 0) throw new Error(`no open socket for ${id}`);
      for (const socket of open) socket.close();
    }, jobId);
    await waitFor(() => first.closed, "job socket close");
    await waitFor(() => mine().filter((socket) => socket.frames.length > 0).length >= 2, "job socket reconnect");
    const secondEvent = JSON.parse(mine().filter((socket) => socket.frames.length > 0).at(-1).frames.at(-1));
    assert.equal(secondEvent.job_id, jobId);
    assert.equal(secondEvent.status === "done" || secondEvent.status === "error", false);
    await page.locator("footer.job-tray").getByText(secondEvent.message, { exact: true }).waitFor();
    const polls = () => seen.jobGets.filter((path) => path === `/jobs/${jobId}`).length;
    if (rebuild) {
      await waitForPollWindow();
      assert.equal(polls(), 0);
    } else {
      await waitFor(() => polls() > 0, "existing job poll");
    }
  } finally {
    releaseLayers();
    await browser?.close();
    await app?.close();
    await ports?.db.close();
    await rm(data, { recursive: true, force: true });
    delete process.env.PP_DESKTOP_REBUILD;
  }
}

function observe(page, planId) {
  const seen = { healthCapabilities: null, healthAt: 0, reviews: [], sockets: [], jobGets: [] };
  page.on("response", async (response) => {
    const path = new URL(response.url()).pathname;
    if (path === "/health" && response.ok()) {
      const body = await response.json();
      seen.healthCapabilities = Array.isArray(body.capabilities) ? body.capabilities : [];
      seen.healthAt = Date.now();
    }
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === `/plans/${planId}/review`) {
      const row = { started: Date.now(), status: 0 };
      seen.reviews.push(row);
      request.response().then((response) => { row.status = response?.status() ?? 0; }).catch(() => {});
    }
    if (request.method() === "GET" && /^\/jobs\/[^/]+$/.test(url.pathname)) seen.jobGets.push(url.pathname);
  });
  page.on("websocket", (socket) => {
    if (!socket.url().includes("/ws/jobs/")) return;
    const entry = { url: socket.url(), frames: [], closed: false };
    socket.on("framereceived", (event) => entry.frames.push(String(event.payload)));
    socket.on("close", () => { entry.closed = true; });
    seen.sockets.push(entry);
  });
  return seen;
}

async function seedPlan(origin, data) {
  const source = await api(origin, "/sources", {
    method: "POST",
    body: JSON.stringify({ name: "Local bracket", source_kind: "local" }),
  });
  const sourceDir = source.local_path || join(data, "repos", String(source.id));
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, "bracket.stl"), "solid bracket\nendsolid bracket\n");
  const plan = await api(origin, "/plans", {
    method: "POST",
    body: JSON.stringify({ name: "Browser proof", base_project_id: source.id }),
  });
  const draft = await api(origin, `/plans/${plan.id}/drafts/recompute`, {
    method: "POST",
    headers: { "Idempotency-Key": "gre-825-open-draft" },
    body: JSON.stringify({ apply_manifest: false }),
  });
  assert.equal(draftQuantity(draft), 1);
  await api(origin, "/sources", {
    method: "POST",
    body: JSON.stringify({
      name: "Held GitHub",
      source_kind: "github",
      url: "https://github.com/print-partner/browser-proof",
    }),
  });
  assert.equal(typeof plan.id, "number");
  return plan.id;
}

async function accessDist() {
  const { access } = await import("node:fs/promises");
  await access(fileURLToPath(new URL("../../dist/index.html", import.meta.url)));
}

function draftQuantity(workspace) {
  for (const part of workspace?.parts ?? []) {
    if (part.filename === "bracket.stl") return part.quantity_effective;
  }
  return null;
}

function waitForPollWindow() {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 900));
}
