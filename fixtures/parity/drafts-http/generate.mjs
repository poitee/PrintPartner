// Generates the drafts-http parity golden: complete HTTP responses from Node's
// real app for the Plan draft routes Rust serves (list, workspace read, part
// edit, abandon) on the flat and /api/v2 mounts, plus the database tables each
// request changed. Node opens a copy of the required-units `unchanged.db`
// fixture: Plan 1 has consumed draft 1 and open draft 2, and Plan 2 belongs to
// another tenant. Run from the repo root after `npm --prefix web ci`:
//   node fixtures/parity/drafts-http/generate.mjs          # write
//   node fixtures/parity/drafts-http/generate.mjs --check  # verify, no writes
// No response carries a clock value, so every body stays literal.
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
  "web/apps/server/src/routes/api-v2.ts",
  "web/apps/server/src/routes/plan-drafts.ts",
];
const DIGEST = "ae11e670337e3e5eab736b29b4e294edbea8b564661cf15972625783f8930ee3";
const STALE = "0".repeat(64);
const EDIT = (digest) => ({
  expected_snapshot_digest: digest,
  decisions: [
    { kind: "set_included", draft_part_ids: [5], value: true },
    { kind: "set_quantity_override", draft_part_ids: [4], value: null },
  ],
});

// Each request runs in order on one database.
const REQUESTS = [
  ["list_flat", "GET", "/plans/1/drafts"],
  ["list_v2", "GET", "/api/v2/plans/1/drafts"],
  ["list_foreign_v2", "GET", "/api/v2/plans/2/drafts"],
  ["list_missing_flat", "GET", "/plans/999999/drafts"],
  ["list_invalid_flat", "GET", "/plans/abc/drafts"],
  ["list_zero_v2", "GET", "/api/v2/plans/0/drafts"],
  ["read_open_flat", "GET", "/plans/1/drafts/2"],
  ["read_open_v2", "GET", "/api/v2/plans/1/drafts/2"],
  ["read_consumed_flat", "GET", "/plans/1/drafts/1"],
  ["read_missing_v2", "GET", "/api/v2/plans/1/drafts/999999"],
  ["read_foreign_flat", "GET", "/plans/2/drafts/2"],
  ["read_invalid_v2", "GET", "/api/v2/plans/1/drafts/x"],
  ["edit_invalid_body_flat", "PATCH", "/plans/1/drafts/2/parts", {}],
  ["edit_invalid_id_v2", "PATCH", "/api/v2/plans/1/drafts/0/parts", EDIT(DIGEST)],
  ["edit_stale_digest_v2", "PATCH", "/api/v2/plans/1/drafts/2/parts", EDIT(STALE)],
  ["edit_missing_flat", "PATCH", "/plans/1/drafts/999999/parts", EDIT(DIGEST)],
  ["edit_foreign_v2", "PATCH", "/api/v2/plans/2/drafts/2/parts", EDIT(DIGEST)],
  ["edit_consumed_flat", "PATCH", "/plans/1/drafts/1/parts", EDIT(DIGEST)],
  ["edit_v2", "PATCH", "/api/v2/plans/1/drafts/2/parts", EDIT(DIGEST)],
  ["edit_replayed_flat", "PATCH", "/plans/1/drafts/2/parts", EDIT(DIGEST)],
  ["read_after_edit_flat", "GET", "/plans/1/drafts/2"],
  ["abandon_invalid_body_v2", "POST", "/api/v2/plans/1/drafts/2/abandon", {}],
  ["abandon_stale_flat", "POST", "/plans/1/drafts/2/abandon", { expected_lifecycle_version: 5 }],
  ["abandon_missing_v2", "POST", "/api/v2/plans/999999/drafts/2/abandon", { expected_lifecycle_version: 0 }],
  ["abandon_consumed_flat", "POST", "/plans/1/drafts/1/abandon", { expected_lifecycle_version: 1 }],
  ["abandon_v2", "POST", "/api/v2/plans/1/drafts/2/abandon", { expected_lifecycle_version: 0 }],
  ["abandon_again_flat", "POST", "/plans/1/drafts/2/abandon", { expected_lifecycle_version: 1 }],
  ["edit_abandoned_v2", "PATCH", "/api/v2/plans/1/drafts/2/parts", EDIT(DIGEST)],
  ["list_after_abandon_flat", "GET", "/plans/1/drafts"],
  ["read_abandoned_v2", "GET", "/api/v2/plans/1/drafts/2"],
];

if (process.argv.includes("--probe")) {
  const load = (source) => import(pathToFileURL(join(root, source)).href);
  const require = createRequire(join(root, "web/apps/server/package.json"));
  const Database = require("better-sqlite3");
  const dataDir = mkdtempSync(join(tmpdir(), "pp-parity-drafts-http-"));
  try {
    copyFileSync(join(root, database), join(dataDir, "print-partner.db"));
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
      const response = await app.inject({ method, url: path, ...(payload ? { payload } : {}) });
      const after = graph();
      cases.push({
        id,
        method,
        path,
        ...(payload ? { body: payload } : {}),
        node: { status: response.statusCode, body: response.body === "" ? null : response.json(), setCookie: [] },
        changed: tables.filter((table) => before.get(table) !== after.get(table)),
      });
    }
    reader.close();
    await app.close();
    await ports.db.close?.();

    const byId = Object.fromEntries(cases.map((item) => [item.id, item]));
    assert.deepEqual(byId.list_flat.node, byId.list_v2.node, "flat and v2 lists answer the same");
    assert.deepEqual(byId.read_open_flat.node, byId.read_open_v2.node, "flat and v2 reads answer the same");
    assert.equal(byId.edit_v2.node.status, 200);
    assert.equal(byId.abandon_v2.node.status, 200);
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
const scratch = mkdtempSync(join(tmpdir(), "pp-parity-drafts-http-probe-"));
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
  "generated": ${JSON.stringify("@generated by fixtures/parity/drafts-http/generate.mjs. Do not edit.")},
  "sources": ${JSON.stringify(sources)},
  "database": ${JSON.stringify(database)},
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
