// Generates the accepted-http parity golden: complete HTTP responses from
// Node's real app for the Accepted Plan read routes Rust's `accepted_router`
// serves: Plan Checkoff on the flat, /api/v1 and /api/v2 mounts, and Part
// assembled units on the flat and /api/v1 mounts (Node registers Part routes
// only there). Node opens a copy of `accepted-plan-node.db`, where Plan 1 has
// an accepted revision and Parts 1 (excluded) and 2 (included). Each phase
// starts from a fresh copy; a phase with a seed drops every trigger, turns
// foreign keys off and runs its SQL first, as the Rust test does. Run from the
// repo root after `npm --prefix web ci`:
//   node fixtures/parity/accepted-http/generate.mjs          # write
//   node fixtures/parity/accepted-http/generate.mjs --check  # verify, no writes
// No response carries a clock value, so every body stays literal.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const output = join(here, "node.json");
const database = "rust/crates/pp-storage/tests/fixtures/accepted-plan-node.db";
const sources = [
  "web/apps/server/src/app.ts",
  "web/apps/server/src/routes/plans.ts",
  "web/apps/server/src/routes/parts.ts",
];

const checkoff = (alias, id) => `${alias}/plans/${id}/checkoff`;
const assembled = (alias, id) => `${alias}/parts/${id}/assembled`;

// Each phase's requests run in order on one database.
const PHASES = [
  {
    name: "ready",
    requests: [
      ["checkoff_flat", "GET", checkoff("", 1)],
      ["checkoff_v1", "GET", checkoff("/api/v1", 1)],
      ["checkoff_v2", "GET", checkoff("/api/v2", 1)],
      // Node reads the id with Number(): these all name Plan 1.
      ["checkoff_decimal_flat", "GET", checkoff("", "1.0")],
      ["checkoff_exponent_v1", "GET", checkoff("/api/v1", "1e0")],
      ["checkoff_plus_v2", "GET", checkoff("/api/v2", "+1")],
      ["checkoff_hex_flat", "GET", checkoff("", "0x1")],
      ["checkoff_spaces_v1", "GET", checkoff("/api/v1", "%201%20")],
      ["checkoff_missing_flat", "GET", checkoff("", 999999)],
      ["checkoff_zero_v1", "GET", checkoff("/api/v1", 0)],
      ["checkoff_text_v2", "GET", checkoff("/api/v2", "abc")],
      ["checkoff_negative_flat", "GET", checkoff("", -1)],
      ["checkoff_fraction_v1", "GET", checkoff("/api/v1", "1.5")],
      ["checkoff_unsafe_v2", "GET", checkoff("/api/v2", "9007199254740993")],
      ["checkoff_infinity_flat", "GET", checkoff("", "Infinity")],
      ["assembled_excluded_flat", "GET", assembled("", 1)],
      ["assembled_excluded_v1", "GET", assembled("/api/v1", 1)],
      ["assembled_included_flat", "GET", assembled("", 2)],
      ["assembled_included_v1", "GET", assembled("/api/v1", 2)],
      ["assembled_decimal_v1", "GET", assembled("/api/v1", "2.0")],
      ["assembled_missing_flat", "GET", assembled("", 999999)],
      ["assembled_zero_v1", "GET", assembled("/api/v1", 0)],
      ["assembled_text_flat", "GET", assembled("", "abc")],
      ["assembled_fraction_v1", "GET", assembled("/api/v1", "1.5")],
    ],
  },
  {
    name: "foreign_plan",
    seed: "UPDATE build_profiles SET tenant_id='foreign' WHERE id=1;",
    requests: [
      ["foreign_checkoff_flat", "GET", checkoff("", 1)],
      ["foreign_checkoff_v2", "GET", checkoff("/api/v2", 1)],
      ["foreign_assembled_v1", "GET", assembled("/api/v1", 2)],
    ],
  },
  {
    name: "foreign_parts",
    seed: "UPDATE parts SET tenant_id='foreign';",
    requests: [["foreign_parts_assembled_flat", "GET", assembled("", 2)]],
  },
  {
    name: "dirty",
    seed: "UPDATE build_profiles SET accepted_plan_revision_id=NULL WHERE id=1;",
    requests: [
      ["dirty_checkoff_v1", "GET", checkoff("/api/v1", 1)],
      ["dirty_assembled_flat", "GET", assembled("", 2)],
    ],
  },
  {
    name: "corrupt",
    seed: "UPDATE plan_revisions SET snapshot_digest=replace(snapshot_digest,'a','b');",
    requests: [
      ["corrupt_checkoff_v2", "GET", checkoff("/api/v2", 1)],
      ["corrupt_assembled_v1", "GET", assembled("/api/v1", 2)],
    ],
  },
];

if (process.argv.includes("--probe")) {
  const load = (source) => import(pathToFileURL(join(root, source)).href);
  const require = createRequire(join(root, "web/apps/server/package.json"));
  const Database = require("better-sqlite3");
  delete process.env.PRINT_PARTNER_API_KEY;
  const { createSelfHostPorts } = await load("web/apps/server/src/adapters/self-host/index.ts");
  const { buildApp } = await load("web/apps/server/src/app.ts");
  const { loadConfig } = await load("web/apps/server/src/config.ts");

  const phases = [];
  for (const phase of PHASES) {
    const dataDir = mkdtempSync(join(tmpdir(), "pp-parity-accepted-http-"));
    try {
      const file = join(dataDir, "print-partner.db");
      copyFileSync(join(root, database), file);
      mkdirSync(join(dataDir, "repos/1/revisions/accepted"), { recursive: true, mode: 0o700 });
      if (phase.seed) {
        const db = new Database(file);
        db.pragma("foreign_keys = OFF");
        for (const { name } of db.prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger'").all()) {
          db.exec(`DROP TRIGGER "${name}"`);
        }
        db.exec(phase.seed);
        db.close();
      }
      process.env.PRINT_PARTNER_DATA_DIR = dataDir;
      const ports = createSelfHostPorts(dataDir);
      await ports.db.connect();
      const app = await buildApp(loadConfig(), ports);
      await app.ready();

      // Every row of every table, so a case records which tables it changed.
      const reader = new Database(file, { readonly: true });
      const tables = reader
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all()
        .map((row) => row.name);
      const graph = () =>
        new Map(tables.map((table) => [table, JSON.stringify(reader.prepare(`SELECT * FROM "${table}"`).raw().all())]));

      const cases = [];
      for (const [id, method, path] of phase.requests) {
        const before = graph();
        const response = await app.inject({ method, url: path });
        const after = graph();
        cases.push({
          id,
          method,
          path,
          node: { status: response.statusCode, body: response.body === "" ? null : response.json(), setCookie: [] },
          changed: tables.filter((table) => before.get(table) !== after.get(table)),
        });
      }
      reader.close();
      await app.close();
      await ports.db.close?.();
      phases.push({ name: phase.name, ...(phase.seed ? { seed: phase.seed } : {}), cases });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }

  const byId = Object.fromEntries(phases.flatMap((phase) => phase.cases).map((item) => [item.id, item]));
  assert.equal(byId.checkoff_flat.node.status, 200);
  assert.deepEqual(byId.checkoff_flat.node, byId.checkoff_v1.node, "flat and v1 Checkoff answer the same");
  assert.deepEqual(byId.checkoff_flat.node, byId.checkoff_v2.node, "flat and v2 Checkoff answer the same");
  assert.equal(byId.assembled_included_flat.node.status, 200);
  assert.deepEqual(byId.assembled_included_flat.node, byId.assembled_included_v1.node);
  for (const item of Object.values(byId)) assert.deepEqual(item.changed, [], `${item.id} wrote state`);
  // The app logs to stdout, so the probe hands its result over in a file.
  writeFileSync(process.argv.at(-1), JSON.stringify(phases));
  process.exit(0);
}

const tsx = join(root, "web/node_modules/tsx/dist/esm/index.mjs");
const scratch = mkdtempSync(join(tmpdir(), "pp-parity-accepted-http-probe-"));
let phases;
try {
  const result = join(scratch, "probe.json");
  execFileSync(
    process.execPath,
    ["--conditions=development", "--import", pathToFileURL(tsx).href, fileURLToPath(import.meta.url), "--probe", result],
    { cwd: join(root, "web/apps/server"), stdio: ["ignore", "ignore", "inherit"] },
  );
  phases = JSON.parse(readFileSync(result, "utf8"));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
const text = `{
  "generated": ${JSON.stringify("@generated by fixtures/parity/accepted-http/generate.mjs. Do not edit.")},
  "sources": ${JSON.stringify(sources)},
  "database": ${JSON.stringify(database)},
  "phases": [
${phases
  .map(
    ({ cases, ...phase }) =>
      `    {${JSON.stringify(phase).slice(1, -1)}, "cases": [\n${cases.map((item) => `      ${JSON.stringify(item)}`).join(",\n")}\n    ]}`,
  )
  .join(",\n")}
  ]
}
`;
const check = process.argv.includes("--check");
if (check) {
  assert.equal(readFileSync(output, "utf8"), text, "node.json is out of date");
} else {
  writeFileSync(output, text);
}
console.log(JSON.stringify({ phases: phases.length, cases: phases.reduce((n, phase) => n + phase.cases.length, 0), check }));
