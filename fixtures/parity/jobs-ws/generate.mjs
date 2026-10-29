// Generates the jobs-ws parity golden: what Node's job WebSocket sends with
// PP_DESKTOP_REBUILD=1. Node mounts the socket only at /ws/jobs/:jobId. Run from the repo root after
// `npm --prefix web ci --ignore-scripts`:
//   node fixtures/parity/jobs-ws/generate.mjs          # write
//   node fixtures/parity/jobs-ws/generate.mjs --check  # verify, no writes
// Each case records every text frame (parsed) and the close code and reason
// the client saw. Job ids and timestamps become labels numbered in first-seen
// order (`job-1`, `time-1`), as in jobs-http.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const output = join(here, "node.json");
const sources = [
  "web/apps/server/src/routes/jobs.ts",
  "web/apps/server/src/services/job-runner.ts",
];
const TIME_KEYS = new Set(["created_at", "started_at", "finished_at", "updated_at"]);

if (process.argv.includes("--probe")) {
  // registerJobWebSocket reads the flag when it registers the route.
  process.env.PP_DESKTOP_REBUILD = "1";
  const load = (source) => import(pathToFileURL(join(root, source)).href);
  const require = createRequire(join(root, "web/package.json"));
  const Fastify = require("fastify");
  const websocket = require("@fastify/websocket");
  const WebSocket = require("ws");
  const { InProcessJobRunner } = await load(sources[1]);
  const { registerJobWebSocket } = await load(sources[0]);
  const repo = { getSetting: () => null, setSetting: () => undefined, listSources: () => [] };
  const runner = new InProcessJobRunner({
    getRepo: () => repo,
    reposDir: "/nonexistent/repos",
    exportsDir: "/nonexistent/exports",
    dataDir: "/nonexistent",
  });
  const settle = async (kind, payload) => {
    const jobId = await runner.start(kind, payload, "default");
    for (;;) {
      const snapshot = await runner.get(jobId, "default");
      if (snapshot.status !== "pending" && snapshot.status !== "running") return jobId;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  // The same two retained jobs as jobs-http: a finished update check, then a
  // second later a checklist export that fails because there is no plan.
  const done = await settle("check-source-updates", {});
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const failed = await settle("export-checklist-html", { profile_id: 7 });

  const app = Fastify({ logger: false });
  await app.register(websocket);
  // Node's app resolves the tenant from the session; here a header picks it so
  // one case can read another tenant's job.
  app.decorateRequest("tenantId", "default");
  app.addHook("onRequest", async (request) => {
    const tenant = request.headers["x-parity-tenant"];
    if (typeof tenant === "string") request.tenantId = tenant;
  });
  registerJobWebSocket(app, runner);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });

  const requests = [
    ["ws_done", `/ws/jobs/${done}`, "default"],
    ["ws_failed", `/ws/jobs/${failed}`, "default"],
    ["ws_missing", "/ws/jobs/never-started", "default"],
    ["ws_foreign", `/ws/jobs/${done}`, "other"],
  ];
  const observe = (path, tenant) =>
    new Promise((resolve, reject) => {
      const frames = [];
      const socket = new WebSocket(`${address.replace("http", "ws")}${path}`, {
        headers: { "x-parity-tenant": tenant },
      });
      socket.on("unexpected-response", (_request, response) =>
        reject(new Error(`${path} answered HTTP ${response.statusCode}`)),
      );
      socket.on("message", (data, binary) => {
        assert.equal(binary, false, "text frames only");
        frames.push(JSON.parse(data.toString("utf8")));
      });
      socket.on("close", (code, reason) =>
        resolve({ frames, close: { code, reason: reason.toString("utf8") } }),
      );
      socket.on("error", reject);
    });
  const cases = [];
  for (const [id, path, tenant] of requests) {
    cases.push({ id, path, tenant, node: { status: 101, body: await observe(path, tenant), setCookie: [] } });
  }
  await app.close();

  const labels = new Map();
  const label = (prefix, value) => {
    const key = `${prefix}\u0000${value}`;
    if (!labels.has(key)) {
      labels.set(key, `${prefix}-${[...labels.keys()].filter((k) => k.startsWith(`${prefix}\u0000`)).length + 1}`);
    }
    return labels.get(key);
  };
  const ids = new Map([[done, "{done}"], [failed, "{failed}"]]);
  const scrub = (value, key) => {
    if (Array.isArray(value)) return value.map((item) => scrub(item));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, k)]));
    }
    if (key === "job_id" && typeof value === "string") return label("job", value);
    if (TIME_KEYS.has(key) && typeof value === "string") return label("time", value);
    return value;
  };
  const scrubbed = cases.map(({ id, path, tenant, node }) => ({
    id,
    path: path.replace(/[^/]+$/, (last) => ids.get(last) ?? last),
    tenant,
    node: scrub(node),
  }));
  const byId = (id) => scrubbed.find((c) => c.id === id).node;
  assert.deepEqual(byId("ws_missing").body, { frames: [], close: { code: 1008, reason: "Job not found" } });
  assert.deepEqual(byId("ws_foreign"), byId("ws_missing"), "a foreign job reads as missing");
  process.stdout.write(`\n${JSON.stringify({ cases: scrubbed })}`);
  process.exit(0);
}

const tsx = join(root, "web/node_modules/tsx/dist/esm/index.mjs");
const probe = JSON.parse(
  execFileSync(
    process.execPath,
    ["--conditions=development", "--import", pathToFileURL(tsx).href, fileURLToPath(import.meta.url), "--probe"],
    { cwd: join(root, "web/apps/server"), encoding: "utf8" },
  )
    .split("\n")
    .at(-1),
);
const text = `{
  "generated": ${JSON.stringify("@generated by fixtures/parity/jobs-ws/generate.mjs. Do not edit.")},
  "sources": ${JSON.stringify(sources)},
  "cases": [
${probe.cases.map((item) => `    ${JSON.stringify(item)}`).join(",\n")}
  ]
}
`;
const check = process.argv.includes("--check");
if (check) {
  assert.equal(readFileSync(output, "utf8"), text, "node.json is out of date");
} else {
  writeFileSync(output, text);
}
console.log(JSON.stringify({ cases: probe.cases.length, check }));
