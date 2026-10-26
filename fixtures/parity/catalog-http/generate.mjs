// Generates the catalog-http parity golden: complete HTTP responses from
// Node's real app for the catalog routes Rust's `admit_catalog_routes` serves,
// on the flat and /api/v1 mounts (Sources list, detail, create, patch and
// delete, import rules, Source activity, Source naming, Source categories and
// global STL naming with its preview), plus the database tables each request
// changed. Node opens a copy of the required-units `unchanged.db` fixture
// after `SEED` adds Source 2 (tenant `default`, with import rules and a
// category), Source 3 (tenant `foreign`) and Source activity events. Source 1
// has an immutable revision, so it cannot be deleted. The Rust test applies
// the same `SEED` to its copy. Run from the repo root after `npm --prefix web ci`:
//   node fixtures/parity/catalog-http/generate.mjs          # write
//   node fixtures/parity/catalog-http/generate.mjs --check  # verify, no writes
// Creating a GitHub Source makes Node start a `sync` job, which would clone
// over the network. The probe replaces the job runner's `start` with a stub
// that records the call, and the golden lists those calls as `effects`.
// No response carries a clock value. A created Source's `local_path` is under
// the scratch data directory, which the golden writes as `{data}`.
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
  "web/apps/server/src/routes/sources.ts",
  "web/apps/server/src/routes/settings.ts",
  "web/apps/server/src/db/repository.ts",
];
const SEED = [
  "INSERT INTO projects (id, tenant_id, name, url, source_kind, branch, imported_paths, metadata_json) VALUES",
  "(2, 'default', 'Second Source', 'https://github.com/example/second', 'github', 'main',",
  `'["parts/"]', '{"category":"Frame/Panels"}'),`,
  "(3, 'foreign', 'Foreign Source', 'https://github.com/example/foreign', 'github', 'main', NULL, NULL);",
  "INSERT INTO app_events (tenant_id, at, kind, payload_json) VALUES",
  `('default', '2026-09-01T10:00:00.000Z', 'source.updated', '{"source_id":2,"source_name":"Second Source"}'),`,
  `('default', '2026-09-01T11:00:00.000Z', 'source.sync_failed', '{"source_id":1,"source_name":"Fixture Source","error":"clone failed"}'),`,
  "('default', '2026-09-01T12:00:00.000Z', 'source.update_available', 'not json'),",
  `('default', '2026-09-01T13:00:00.000Z', 'plan.created', '{"source_id":2}'),`,
  `('foreign', '2026-09-01T14:00:00.000Z', 'source.updated', '{"source_id":3,"source_name":"Foreign Source"}');`,
].join(" ");

// A full naming profile that differs from the default in every section, so
// a Source override and a global save need no default from either app.
const PROFILE = {
  roles: [
    { id: "primary", label: "Main", markers: ["[main]"] },
    { id: "accent", label: "Accent", markers: ["[a]"] },
    { id: "clear", label: "Clear", markers: ["[c]"] },
    { id: "opaque", label: "Opaque", markers: ["[o]"] },
  ],
  quantity: { regex: "_x(\\d+)", default: 2 },
  slug: { strip_markers: false, strip_quantity: true },
  folder_rules: [{ path_contains: "panels", role_id: "accent", functional_class: "cosmetic" }],
  export_role_order: ["accent", "primary", "clear", "opaque"],
};

// Each request runs in order on one database. A string body is sent verbatim
// as JSON text and recorded as `rawBody`.
const REQUESTS = [
  ["list_flat", "GET", "/sources"],
  ["list_v1", "GET", "/api/v1/sources"],
  ["detail_flat", "GET", "/sources/1"],
  ["detail_v1", "GET", "/api/v1/sources/2"],
  ["detail_missing_flat", "GET", "/sources/999"],
  ["detail_foreign_v1", "GET", "/api/v1/sources/3"],
  ["detail_text_id_flat", "GET", "/sources/abc"],
  ["activity_flat", "GET", "/sources/activity"],
  ["activity_limit_v1", "GET", "/api/v1/sources/activity?limit=1"],
  ["activity_text_limit_flat", "GET", "/sources/activity?limit=abc"],
  ["import_rules_flat", "GET", "/sources/2/import-rules"],
  ["import_rules_legacy_v1", "GET", "/api/v1/sources/1/import-rules"],
  ["import_rules_missing_flat", "GET", "/sources/999/import-rules"],
  ["import_rules_foreign_v1", "GET", "/api/v1/sources/3/import-rules"],
  ["import_rules_save_flat", "PUT", "/sources/2/import-rules", { rules: ["parts/", "parts/", " extras/ ", ""] }],
  ["import_rules_after_save_v1", "GET", "/api/v1/sources/2/import-rules"],
  ["import_rules_save_missing_v1", "PUT", "/api/v1/sources/999/import-rules", { rules: [] }],
  ["import_rules_save_foreign_flat", "PUT", "/sources/3/import-rules", { rules: ["x/"] }],
  ["naming_flat", "GET", "/sources/2/naming"],
  ["naming_missing_v1", "GET", "/api/v1/sources/999/naming"],
  ["naming_foreign_flat", "GET", "/sources/3/naming"],
  ["naming_override_v1", "PUT", "/api/v1/sources/2/naming", { use_defaults: false, override: PROFILE }],
  ["naming_after_override_flat", "GET", "/sources/2/naming"],
  ["naming_text_id_v1", "GET", "/api/v1/sources/abc/naming"],
  ["naming_bad_body_flat", "PUT", "/sources/2/naming", { use_defaults: "yes" }],
  ["naming_defaults_flat", "PUT", "/sources/2/naming", { use_defaults: true }],
  ["naming_save_missing_v1", "PUT", "/api/v1/sources/999/naming", { use_defaults: true }],
  ["categories_flat", "GET", "/settings/source-categories"],
  ["categories_save_v1", "PUT", "/api/v1/settings/source-categories", { categories: ["Frame", "Frame/Panels", "Electronics"] }],
  ["categories_rename_flat", "PUT", "/settings/source-categories", { categories: ["Frame", "Electronics"], replacements: { "Frame/Panels": "Frame" } }],
  ["categories_after_v1", "GET", "/api/v1/settings/source-categories"],
  ["detail_after_rename_flat", "GET", "/sources/2"],
  ["global_naming_flat", "GET", "/settings/stl-naming"],
  ["global_naming_save_v1", "PUT", "/api/v1/settings/stl-naming", { profile: PROFILE }],
  ["global_naming_after_flat", "GET", "/settings/stl-naming"],
  ["global_naming_bad_v1", "PUT", "/api/v1/settings/stl-naming", { profile: { ...PROFILE, export_role_order: ["accent"] } }],
  ["preview_flat", "POST", "/settings/stl-naming/preview", { relative_path: "panels/[a]_door_x2.stl" }],
  ["preview_override_v1", "POST", "/api/v1/settings/stl-naming/preview", { relative_path: "[main]_frame_x3.stl", profile: { slug: { strip_markers: false } } }],
  ["create_local_flat", "POST", "/sources", { name: "Local Source", source_kind: "local" }],
  ["create_github_v1", "POST", "/api/v1/sources", { name: "GitHub Source", url: "https://github.com/Example/Repo/tree/dev" }],
  ["create_duplicate_flat", "POST", "/sources", { name: "Second Source", source_kind: "local" }],
  ["create_tagged_v1", "POST", "/api/v1/sources", { name: "Tagged Source", source_kind: "local", tag: "v1.0", role: "addon", metadata: { category: "Electronics" } }],
  ["list_after_create_flat", "GET", "/sources"],
  ["patch_name_flat", "PATCH", "/sources/2", { name: "Renamed Source" }],
  ["patch_metadata_v1", "PATCH", "/api/v1/sources/2", { metadata: { category: "Electronics" } }],
  ["patch_tag_null_flat", "PATCH", "/sources/6", { tag: null }],
  ["patch_missing_v1", "PATCH", "/api/v1/sources/999", { name: "Nobody" }],
  ["patch_foreign_flat", "PATCH", "/sources/3", { name: "Taken" }],
  ["patch_duplicate_v1", "PATCH", "/api/v1/sources/4", { name: "Renamed Source" }],
  ["delete_retained_flat", "DELETE", "/sources/1"],
  ["delete_missing_v1", "DELETE", "/api/v1/sources/999"],
  ["delete_foreign_flat", "DELETE", "/sources/3"],
  ["delete_v1", "DELETE", "/api/v1/sources/4"],
  ["detail_deleted_flat", "GET", "/sources/4"],
  ["list_final_v1", "GET", "/api/v1/sources"],
  ["create_malformed_json_flat", "POST", "/sources", '{"name":'],
];
if (process.argv.includes("--probe")) {
  const load = (source) => import(pathToFileURL(join(root, source)).href);
  const require = createRequire(join(root, "web/apps/server/package.json"));
  const Database = require("better-sqlite3");
  const dataDir = mkdtempSync(join(tmpdir(), "pp-parity-catalog-http-"));
  try {
    copyFileSync(join(root, database), join(dataDir, "print-partner.db"));
    const seeder = new Database(join(dataDir, "print-partner.db"));
    seeder.exec(SEED);
    seeder.close();
    process.env.PRINT_PARTNER_DATA_DIR = dataDir;
    delete process.env.PRINT_PARTNER_API_KEY;
    // External effect: no sync job runs; the call is recorded instead.
    const effects = [];
    const { InProcessJobRunner } = await load("web/apps/server/src/services/job-runner.ts");
    InProcessJobRunner.prototype.start = async function (kind, params) {
      effects.push({ kind, params });
      return { job_id: `stub-${effects.length}`, status: "queued" };
    };
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
      const started = effects.length;
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
        node: {
          status: response.statusCode,
          body: response.body === "" ? null : JSON.parse(response.body.replaceAll(dataDir, "{data}")),
          setCookie: [],
        },
        changed: tables.filter((table) => before.get(table) !== after.get(table)),
        ...(effects.length > started ? { effects: effects.slice(started) } : {}),
      });
    }
    reader.close();
    await app.close();
    await ports.db.close?.();

    const byId = Object.fromEntries(cases.map((item) => [item.id, item]));
    assert.equal(byId.create_local_flat.node.body.id, 4);
    assert.equal(byId.create_github_v1.node.body.id, 5);
    assert.equal(byId.create_tagged_v1.node.body.id, 6);
    assert.equal(byId.delete_retained_flat.node.status, 409);
    assert.equal(byId.naming_override_v1.node.status, 200);
    assert.equal(byId.global_naming_save_v1.node.status, 200);
    assert.equal(byId.delete_v1.node.status, 204);
    assert.deepEqual(byId.create_github_v1.effects, [{ kind: "sync", params: { project_ids: [5] } }]);
    assert.equal(cases.filter((item) => item.effects).length, 1, "only the GitHub create starts a job");
    for (const item of cases) {
      if (item.method === "GET" || item.node.status >= 400) {
        assert.deepEqual(item.changed, [], `${item.id} wrote state`);
      }
    }
    // The app logs to stdout, so the probe hands its result over in a file.
    writeFileSync(process.argv.at(-1), JSON.stringify(cases));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
  process.exit(0);
}

const tsx = join(root, "web/node_modules/tsx/dist/esm/index.mjs");
const scratch = mkdtempSync(join(tmpdir(), "pp-parity-catalog-http-probe-"));
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
  "generated": ${JSON.stringify("@generated by fixtures/parity/catalog-http/generate.mjs. Do not edit.")},
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
