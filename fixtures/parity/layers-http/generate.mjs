// Generates the layers-http parity golden: complete HTTP responses from Node's
// real app for the Plan layer mutations Rust serves (attach an add-on, replace
// it, set the base, detach) and their refusals, on the flat, /api/v1 and
// /api/v2 mounts, plus the database tables each request changed. Node opens a
// copy of the required-units `unchanged.db` fixture after `SEED` adds three
// Sources without files: two for tenant `default` and one for `foreign`.
// Plan 1 has base layer 1 on Source 1; Plan 2 belongs to `foreign`. The Rust
// test applies the same `SEED` to its copy. Run from the repo root after
// `npm --prefix web ci`:
//   node fixtures/parity/layers-http/generate.mjs          # write
//   node fixtures/parity/layers-http/generate.mjs --check  # verify, no writes
// No response carries a clock value, and layer ids are sequential on the
// copied database, so every path and body stays literal.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const output = join(here, "node.json");
const database = "rust/crates/pp-storage/tests/fixtures/required-units/unchanged.db";
const sources = [
  "web/apps/server/src/app.ts",
  "web/apps/server/src/routes/plans.ts",
  "web/apps/server/src/db/repository.ts",
];
const SEED = [
  "INSERT INTO projects (id, tenant_id, name, url) VALUES",
  "(2, 'default', 'Addon Source', 'https://example.test/addon'),",
  "(3, 'default', 'Second Source', 'https://example.test/second'),",
  "(4, 'foreign', 'Foreign Source', 'https://example.test/foreign');",
].join(" ");

// Each request runs in order on one database. Layer 2 is the add-on that
// `attach_v2` creates. A string body is sent verbatim as JSON text and
// recorded as `rawBody`, because JSON.stringify would write `2.0` as `2`.
const REQUESTS = [
  ["layers_flat", "GET", "/plans/1/layers"],
  ["attach_v2", "POST", "/api/v2/plans/1/layers", { project_id: 2 }],
  ["attach_again_flat", "POST", "/plans/1/layers", { project_id: 2 }],
  // Number() reads 2.0 as 2, so this is the duplicate refusal, not a 404.
  ["attach_float_source_v1", "POST", "/api/v1/plans/1/layers", '{"project_id":2.0}'],
  ["attach_base_source_v1", "POST", "/api/v1/plans/1/layers", { project_id: 1 }],
  ["attach_missing_source_v1", "POST", "/api/v1/plans/1/layers", { project_id: 999999 }],
  ["attach_foreign_source_flat", "POST", "/plans/1/layers", { project_id: 4 }],
  // Node coerces `project_id` with Number(), so a missing, null or zero id
  // finds no Source, after the Plan check.
  ["attach_no_source_v2", "POST", "/api/v2/plans/1/layers", {}],
  ["attach_null_source_flat", "POST", "/plans/1/layers", { project_id: null }],
  ["attach_zero_source_v1", "POST", "/api/v1/plans/1/layers", { project_id: 0 }],
  ["attach_no_source_missing_plan_flat", "POST", "/plans/999999/layers", {}],
  ["attach_missing_plan_flat", "POST", "/plans/999999/layers", { project_id: 3 }],
  ["attach_foreign_plan_v2", "POST", "/api/v2/plans/2/layers", { project_id: 3 }],
  ["layers_after_attach_v1", "GET", "/api/v1/plans/1/layers"],
  ["replace_v2", "PUT", "/api/v2/plans/1/layers/2", { project_id: 3 }],
  ["replace_missing_layer_flat", "PUT", "/plans/1/layers/999999", { project_id: 2 }],
  ["replace_missing_source_v1", "PUT", "/api/v1/plans/1/layers/2", { project_id: 999999 }],
  ["replace_foreign_plan_flat", "PUT", "/plans/2/layers/2", { project_id: 2 }],
  ["replace_no_source_v2", "PUT", "/api/v2/plans/1/layers/2", {}],
  ["replace_no_source_missing_layer_flat", "PUT", "/plans/1/layers/999999", {}],
  // Node checks the layer before the Source, so a foreign Source on a missing
  // layer is "Layer not found".
  ["replace_foreign_source_missing_layer_v2", "PUT", "/api/v2/plans/1/layers/999999", { project_id: 4 }],
  ["set_base_flat", "PUT", "/plans/1/layers/base", { project_id: 2 }],
  ["set_base_missing_source_v2", "PUT", "/api/v2/plans/1/layers/base", { project_id: 999999 }],
  ["set_base_missing_plan_v1", "PUT", "/api/v1/plans/999999/layers/base", { project_id: 2 }],
  ["set_base_no_source_flat", "PUT", "/plans/1/layers/base", {}],
  ["set_base_no_source_missing_plan_v2", "PUT", "/api/v2/plans/999999/layers/base", {}],
  ["layers_after_base_v2", "GET", "/api/v2/plans/1/layers"],
  ["detach_missing_plan_v2", "DELETE", "/api/v2/plans/999999/layers/2"],
  ["detach_v1", "DELETE", "/api/v1/plans/1/layers/2"],
  ["detach_again_flat", "DELETE", "/plans/1/layers/2"],
  ["layers_after_detach_flat", "GET", "/plans/1/layers"],
  ["set_base_float_source_v1", "PUT", "/api/v1/plans/1/layers/base", '{"project_id":1e0}'],
  ["layers_after_float_base_v2", "GET", "/api/v2/plans/1/layers"],
];

if (process.argv.includes("--probe")) {
  const load = (source) => import(pathToFileURL(join(root, source)).href);
  const require = createRequire(join(root, "web/apps/server/package.json"));
  const Database = require("better-sqlite3");
  const dataDir = mkdtempSync(join(tmpdir(), "pp-parity-layers-http-"));
  try {
    copyFileSync(join(root, database), join(dataDir, "print-partner.db"));
    const seeder = new Database(join(dataDir, "print-partner.db"));
    seeder.exec(SEED);
    seeder.close();
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

    const cases = [];
    for (const [id, method, path, payload] of REQUESTS) {
      const before = graph();
      const raw = typeof payload === "string";
      const response = await app.inject({
        method,
        url: path,
        ...(payload ? { payload } : {}),
        ...(raw ? { headers: { "content-type": "application/json" } } : {}),
      });
      const after = graph();
      cases.push({
        id,
        method,
        path,
        ...(raw ? { rawBody: payload } : payload ? { body: payload } : {}),
        node: { status: response.statusCode, body: response.body === "" ? null : response.json(), setCookie: [] },
        changed: tables.filter((table) => before.get(table) !== after.get(table)),
      });
    }
    reader.close();
    await app.close();
    await ports.db.close?.();

    const byId = Object.fromEntries(cases.map((item) => [item.id, item]));
    assert.equal(byId.attach_v2.node.status, 200);
    assert.equal(byId.detach_v1.node.status, 204);
    assert.equal(byId.attach_float_source_v1.node.status, 409);
    assert.equal(byId.set_base_float_source_v1.node.status, 200);
    for (const item of cases) {
      if (item.method === "GET") assert.deepEqual(item.changed, [], `${item.id} wrote state`);
    }
    // The app logs to stdout, so the probe hands its result over in a file.
    writeFileSync(process.argv.at(-1), JSON.stringify(cases));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
  process.exit(0);
}

const tsx = join(root, "web/node_modules/tsx/dist/esm/index.mjs");
const scratch = mkdtempSync(join(tmpdir(), "pp-parity-layers-http-probe-"));
let cases;
try {
  const result = join(scratch, "probe.json");
  execFileSync(
    process.execPath,
    ["--conditions=development", "--import", pathToFileURL(tsx).href, fileURLToPath(import.meta.url), "--probe", result],
    { cwd: join(root, "web/apps/server"), stdio: ["ignore", "ignore", "inherit"] },
  );
  cases = JSON.parse(readFileSync(result, "utf8"));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
const text = `{
  "generated": ${JSON.stringify("@generated by fixtures/parity/layers-http/generate.mjs. Do not edit.")},
  "sources": ${JSON.stringify(sources)},
  "database": ${JSON.stringify(database)},
  "seed": ${JSON.stringify(SEED)},
  "cases": [
${cases.map((item) => `    ${JSON.stringify(item)}`).join(",\n")}
  ]
}
`;
const check = process.argv.includes("--check");
if (check) {
  assert.equal(readFileSync(output, "utf8"), text, "node.json is out of date");
} else {
  writeFileSync(output, text);
}
console.log(JSON.stringify({ cases: cases.length, check }));
