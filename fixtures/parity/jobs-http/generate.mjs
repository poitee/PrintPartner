// Generates the jobs-http parity golden: complete HTTP responses from Node's
// registered job read routes, flat and under /api/v1. Run from the repo root
// after `npm --prefix web ci --ignore-scripts`:
//   node fixtures/parity/jobs-http/generate.mjs          # write
//   node fixtures/parity/jobs-http/generate.mjs --check  # verify, no writes
// Job ids and timestamps are random or clock-bound, so each distinct value is
// replaced by a label numbered in first-seen order across the whole capture
// (`job-1`, `time-1`). Equal values keep equal labels.
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
  "web/apps/server/src/routes/api-v1-extensions.ts",
  "web/apps/server/src/services/job-runner.ts",
];
const TIME_KEYS = new Set(["created_at", "started_at", "finished_at", "updated_at"]);

if (process.argv.includes("--probe")) {
  const load = (source) => import(pathToFileURL(join(root, source)).href);
  const require = createRequire(join(root, "web/package.json"));
  const Fastify = require("fastify");
  const { InProcessJobRunner } = await load(sources[2]);
  const { registerJobRoutes } = await load(sources[0]);
  const { registerApiV1ExtensionRoutes } = await load(sources[1]);
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
  // With no Sources the update check succeeds; the checklist export fails
  // because the probe repository has no plan. The second finishes later.
  const done = await settle("check-source-updates", {});
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const failed = await settle("export-checklist-html", { profile_id: 7 });

  const app = Fastify({ logger: false });
  app.decorateRequest("tenantId", "default");
  const jobRoutes = (scope) =>
    registerJobRoutes(scope, runner, { deployMode: "self-host", statusExecution: {} });
  await app.register(jobRoutes);
  await app.register(async (scope) => {
    await registerApiV1ExtensionRoutes(scope, { repo, jobs: runner });
    await jobRoutes(scope);
  }, { prefix: "/api/v1" });
  await app.ready();

  const requests = [
    ["list_all", "/api/v1/jobs"],
    ["list_done", "/api/v1/jobs?status=done"],
    ["list_unknown_status", "/api/v1/jobs?status=bogus"],
    ["list_profile_7", "/api/v1/jobs?profile_id=7"],
    ["list_profile_8", "/api/v1/jobs?profile_id=8"],
    ["list_since_future", "/api/v1/jobs?since=2100-01-01T00:00:00.000Z"],
    ["list_since_invalid", "/api/v1/jobs?since=invalid"],
    ["flat_done", `/jobs/${done}`],
    ["v1_done", `/api/v1/jobs/${done}`],
    ["flat_failed", `/jobs/${failed}`],
    ["v1_failed", `/api/v1/jobs/${failed}`],
    ["flat_missing", "/jobs/never-started"],
    ["v1_missing", "/api/v1/jobs/never-started"],
  ];
  const cases = [];
  for (const [id, path] of requests) {
    const response = await app.inject({ method: "GET", url: path });
    cases.push({
      id,
      path,
      node: {
        status: response.statusCode,
        body: response.body === "" ? null : response.json(),
        setCookie: [],
      },
    });
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
  const scrubbed = cases.map(({ id, path, node }) => ({
    id,
    path: path.replace(/[^/]+$/, (last) => ids.get(last) ?? last),
    node: scrub(node),
  }));
  assert.equal(scrubbed.find((c) => c.id === "flat_missing").node.status, 404);
  assert.deepEqual(
    scrubbed.find((c) => c.id === "flat_done").node,
    scrubbed.find((c) => c.id === "v1_done").node,
    "flat and v1 aliases answer the same",
  );
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
  "generated": ${JSON.stringify("@generated by fixtures/parity/jobs-http/generate.mjs. Do not edit.")},
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
