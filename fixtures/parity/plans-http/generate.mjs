// Generates the plans-http parity golden: complete HTTP responses from Node's
// real app for the Plan routes Rust serves, on the flat, /api/v1 and /api/v2
// mounts, plus the database tables each request changed. Run from the repo
// root after `npm --prefix web ci`:
//   node fixtures/parity/plans-http/generate.mjs          # write
//   node fixtures/parity/plans-http/generate.mjs --check  # verify, no writes
// Plan ids are sequential on a fresh database and stay literal. Timestamps are
// clock-bound, so each distinct value becomes a label numbered in first-seen
// order across the whole capture (`time-1`). Equal values keep equal labels.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const output = join(here, "node.json");
const sources = [
  "web/apps/server/src/app.ts",
  "web/apps/server/src/routes/api-v2.ts",
  "web/apps/server/src/routes/plans.ts",
];
const TIME_KEYS = new Set(["created_at", "updated_at", "last_used_at", "config_modified_at", "archived_at"]);

// Each request runs in order on one database. `{kit}` and the other names in
// braces are the ids of the Plans created by the earlier cases.
const REQUESTS = [
  ["create_flat", "POST", "/plans", { name: "  Kit  " }],
  ["create_v1", "POST", "/api/v1/plans", { name: "Kit v1" }],
  ["create_v2", "POST", "/api/v2/plans", { name: "Kit v2" }],
  ["create_duplicate", "POST", "/plans", { name: "Kit" }],
  ["create_duplicate_v2", "POST", "/api/v2/plans", { name: "Kit v1" }],
  ["create_blank", "POST", "/api/v1/plans", { name: "   " }],
  ["create_missing_name", "POST", "/api/v2/plans", {}],
  ["list_flat", "GET", "/plans"],
  ["list_v1", "GET", "/api/v1/plans"],
  ["list_v2", "GET", "/api/v2/plans"],
  ["detail_flat", "GET", "/plans/{kit}"],
  ["detail_v1", "GET", "/api/v1/plans/{kit}"],
  ["detail_v2", "GET", "/api/v2/plans/{kit}"],
  ["detail_missing_flat", "GET", "/plans/999999"],
  ["detail_missing_v2", "GET", "/api/v2/plans/999999"],
  ["layers_flat", "GET", "/plans/{kit}/layers"],
  ["layers_v2", "GET", "/api/v2/plans/{kit_v2}/layers"],
  ["layers_missing_v1", "GET", "/api/v1/plans/999999/layers"],
  ["touch_v2", "POST", "/api/v2/plans/{kit}/touch"],
  ["touch_missing_flat", "POST", "/plans/999999/touch"],
  ["detail_after_touch_v1", "GET", "/api/v1/plans/{kit}"],
  ["delete_v1", "DELETE", "/api/v1/plans/{kit_v1}"],
  ["detail_deleted_v1", "GET", "/api/v1/plans/{kit_v1}"],
  ["delete_again_flat", "DELETE", "/plans/{kit_v1}"],
  ["delete_missing_v2", "DELETE", "/api/v2/plans/999999"],
  ["list_after_delete_v2", "GET", "/api/v2/plans"],
  // Node inserts the Plan before it looks up the base project, so this refusal
  // leaves a Plan behind; the list after it shows that row.
  ["create_missing_base", "POST", "/plans", { name: "Orphan", base_project_id: 999999 }],
  ["list_after_refusal_v1", "GET", "/api/v1/plans"],
];

if (process.argv.includes("--probe")) {
  const load = (source) => import(pathToFileURL(join(root, source)).href);
  const require = createRequire(join(root, "web/apps/server/package.json"));
  const Database = require("better-sqlite3");
  const dataDir = mkdtempSync(join(tmpdir(), "pp-parity-plans-http-"));
  try {
    process.env.PRINT_PARTNER_DATA_DIR = dataDir;
    delete process.env.PRINT_PARTNER_API_KEY;
    const { createSelfHostPorts } = await load("web/apps/server/src/adapters/self-host/index.ts");
    const { buildApp } = await load("web/apps/server/src/app.ts");
    const { loadConfig } = await load("web/apps/server/src/config.ts");
    const ports = createSelfHostPorts(dataDir);
    await ports.db.connect();
    const app = await buildApp(loadConfig(), ports);
    await app.ready();

    // Every row of every table, so a case records which tables it changed.
    const reader = new Database(join(dataDir, "print-partner.db"), { readonly: true });
    const tables = reader
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => row.name);
    const graph = () =>
      new Map(tables.map((table) => [table, JSON.stringify(reader.prepare(`SELECT * FROM "${table}"`).raw().all())]));

    const ids = {};
    const cases = [];
    for (const [id, method, template, payload] of REQUESTS) {
      const url = template.replace(/\{(\w+)\}/g, (_, name) => String(ids[name]));
      const before = graph();
      const response = await app.inject({ method, url, ...(payload ? { payload } : {}) });
      const after = graph();
      const body = response.body === "" ? null : response.json();
      if (id.startsWith("create_") && response.statusCode === 200) {
        ids[id === "create_flat" ? "kit" : id.replace("create_", "kit_")] = body.id;
      }
      cases.push({
        id,
        method,
        path: template,
        ...(payload ? { body: payload } : {}),
        node: { status: response.statusCode, body, setCookie: [] },
        changed: tables.filter((table) => before.get(table) !== after.get(table)),
      });
    }
    reader.close();
    await app.close();
    await ports.db.close?.();

    const labels = new Map();
    const label = (value) => {
      if (!labels.has(value)) labels.set(value, `time-${labels.size + 1}`);
      return labels.get(value);
    };
    const scrub = (value, key) => {
      if (Array.isArray(value)) return value.map((item) => scrub(item));
      if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, k)]));
      }
      if (TIME_KEYS.has(key) && typeof value === "string") return label(value);
      return value;
    };
    const scrubbed = cases.map((item) => ({ ...item, node: scrub(item.node) }));
    const byId = Object.fromEntries(scrubbed.map((item) => [item.id, item]));
    assert.deepEqual(byId.list_flat.node, byId.list_v2.node, "flat and v2 lists answer the same");
    assert.deepEqual(byId.detail_flat.node, byId.detail_v2.node, "flat and v2 details answer the same");
    assert.equal(byId.delete_v1.node.status, 204);
    assert.deepEqual(byId.create_missing_base.changed, ["build_profiles"], "the refused create left a Plan");
    // The app logs to stdout, so the probe hands its result over in a file.
    writeFileSync(process.argv.at(-1), JSON.stringify({ ids, cases: scrubbed }));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
  process.exit(0);
}

const tsx = join(root, "web/node_modules/tsx/dist/esm/index.mjs");
const scratch = mkdtempSync(join(tmpdir(), "pp-parity-plans-http-probe-"));
let probe;
try {
  const result = join(scratch, "probe.json");
  execFileSync(
    process.execPath,
    ["--conditions=development", "--import", pathToFileURL(tsx).href, fileURLToPath(import.meta.url), "--probe", result],
    { cwd: join(root, "web/apps/server"), stdio: ["ignore", "ignore", "inherit"] },
  );
  probe = JSON.parse(readFileSync(result, "utf8"));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
const text = `{
  "generated": ${JSON.stringify("@generated by fixtures/parity/plans-http/generate.mjs. Do not edit.")},
  "sources": ${JSON.stringify(sources)},
  "ids": ${JSON.stringify(probe.ids)},
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
