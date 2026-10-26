// Generates the manifest-http parity golden: complete HTTP responses from
// Node's real app for the kit-manifest and plan-manifest-builder routes Rust's
// `build_router` serves, on the flat, /api/v1 and /api/v2 mounts, plus the
// database tables each request changed. Node opens a copy of the
// required-units `unchanged.db` fixture after `SEED` adds two Sources with no
// local checkout, Plan 3 (base Source 2, add-on Source 3, a stored kit) and
// Plan 4 (no layers, an unreadable stored kit). Plan 1's base Source names a
// local checkout, which Rust can only observe through a reads adapter that
// production does not wire yet, so no builder read or kit save here touches
// Plan 1. Plan 2 belongs to `foreign`. The Rust test applies the same `SEED`
// to its copy. Run from the repo root after `npm --prefix web ci`:
//   node fixtures/parity/manifest-http/generate.mjs          # write
//   node fixtures/parity/manifest-http/generate.mjs --check  # verify, no writes
// No response carries a clock value, so every path and body stays literal.
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
  "web/apps/server/src/routes/plans.ts",
  "web/apps/server/src/services/kit-manifest-store.ts",
  "web/apps/server/src/services/plan-manifest-builder.ts",
];
const STORED_KIT = JSON.stringify({
  name: "Stored kit",
  selections: { toolhead: "mini", extras: ["skirts"] },
  include: ["part.stl"],
  replacements: { "old.stl": "new.stl" },
});
const SEED = [
  "INSERT INTO projects (id, tenant_id, name, url) VALUES",
  "(2, 'default', 'Addon Source', 'https://example.test/addon'),",
  "(3, 'default', 'Second Source', 'https://example.test/second');",
  "INSERT INTO build_profiles (id, tenant_id, name) VALUES",
  "(3, 'default', 'Manifest Plan'), (4, 'default', 'Empty Plan');",
  "INSERT INTO profile_layers (tenant_id, profile_id, layer_order, layer_type, project_id) VALUES",
  "('default', 3, 0, 'base', 2), ('default', 3, 1, 'addon', 3);",
  "INSERT INTO app_settings (tenant_id, key, value) VALUES",
  `('default', 'kit_manifest_3', '${STORED_KIT}'),`,
  "('default', 'kit_manifest_4', 'not json');",
].join(" ");

const KIT = {
  name: "Saved kit",
  layers: ["base"],
  base_source_id: "2",
  addon_source_ids: ["3"],
  // Neither seeded Plan has option groups, so a selection here would name an
  // unknown group, which Rust refuses (see the last two cases).
  selections: {},
  include: ["a.stl"],
  exclude: ["b.stl"],
  replacements: { "a.stl": "c.stl" },
  choice_tree: [{ id: "toolhead" }],
  category_links: [{ category: "frame" }],
};

// Each request runs in order on one database. A string body is sent verbatim
// as JSON text and recorded as `rawBody`.
const REQUESTS = [
  ["kit_stored_flat", "GET", "/plans/3/kit-manifest"],
  ["kit_unreadable_v1", "GET", "/api/v1/plans/4/kit-manifest"],
  ["kit_unsaved_v2", "GET", "/api/v2/plans/1/kit-manifest"],
  ["kit_head_v2", "HEAD", "/api/v2/plans/3/kit-manifest"],
  ["kit_missing_flat", "GET", "/plans/999999/kit-manifest"],
  ["kit_foreign_v1", "GET", "/api/v1/plans/2/kit-manifest"],
  ["kit_zero_id_v2", "GET", "/api/v2/plans/0/kit-manifest"],
  // Node reads the id with Number(), so a non-numeric id finds no Plan.
  ["kit_text_id_flat", "GET", "/plans/abc/kit-manifest"],
  ["builder_text_id_v1", "GET", "/api/v1/plans/abc/plan-manifest-builder"],
  ["save_text_id_v2", "PUT", "/api/v2/plans/abc/kit-manifest", { kit: {} }],
  ["builder_flat", "GET", "/plans/3/plan-manifest-builder"],
  ["builder_no_layers_v1", "GET", "/api/v1/plans/4/plan-manifest-builder"],
  ["builder_missing_v2", "GET", "/api/v2/plans/999999/plan-manifest-builder"],
  ["builder_foreign_flat", "GET", "/plans/2/plan-manifest-builder"],
  ["save_v2", "PUT", "/api/v2/plans/4/kit-manifest", { kit: KIT }],
  ["kit_after_save_flat", "GET", "/plans/4/kit-manifest"],
  ["builder_after_save_v2", "GET", "/api/v2/plans/4/plan-manifest-builder"],
  // Node merges a save over the empty kit, not over the stored one.
  ["save_partial_v1", "PUT", "/api/v1/plans/4/kit-manifest", { kit: { exclude: ["d.stl"] } }],
  ["kit_after_partial_v1", "GET", "/api/v1/plans/4/kit-manifest"],
  ["save_unknown_key_flat", "PUT", "/plans/3/kit-manifest", { kit: { name: null, extra: 1 } }],
  ["save_missing_plan_flat", "PUT", "/plans/999999/kit-manifest", { kit: {} }],
  ["save_foreign_plan_v2", "PUT", "/api/v2/plans/2/kit-manifest", { kit: {} }],
  ["save_no_body_v2", "PUT", "/api/v2/plans/3/kit-manifest"],
  ["save_malformed_json_flat", "PUT", "/plans/3/kit-manifest", '{"kit":'],
  ["save_no_kit_flat", "PUT", "/plans/3/kit-manifest", {}],
  ["save_array_body_v1", "PUT", "/api/v1/plans/3/kit-manifest", []],
  ["save_null_kit_v2", "PUT", "/api/v2/plans/3/kit-manifest", { kit: null }],
  ["save_array_kit_flat", "PUT", "/plans/3/kit-manifest", { kit: [] }],
  ["save_bad_name_flat", "PUT", "/plans/3/kit-manifest", { kit: { name: 5 } }],
  ["save_bad_layers_v1", "PUT", "/api/v1/plans/3/kit-manifest", { kit: { layers: "base" } }],
  ["save_bad_base_v2", "PUT", "/api/v2/plans/3/kit-manifest", { kit: { base_source_id: 2 } }],
  ["save_bad_addons_flat", "PUT", "/plans/3/kit-manifest", { kit: { addon_source_ids: [3] } }],
  ["save_null_selections_v1", "PUT", "/api/v1/plans/3/kit-manifest", { kit: { selections: null } }],
  ["save_duplicate_selection_v2", "PUT", "/api/v2/plans/3/kit-manifest", { kit: { selections: { extras: ["s", "s"] } } }],
  // Node checks every entry before duplicates, so this names entry 1.
  ["save_bad_selection_entry_v1", "PUT", "/api/v1/plans/3/kit-manifest", { kit: { selections: { extras: ["a", 1, "a"] } } }],
  ["save_blank_group_v2", "PUT", "/api/v2/plans/3/kit-manifest", { kit: { selections: { " ": "a" } } }],
  ["save_bad_selection_flat", "PUT", "/plans/3/kit-manifest", { kit: { selections: { toolhead: 1 } } }],
  ["save_bad_include_v1", "PUT", "/api/v1/plans/3/kit-manifest", { kit: { include: [1] } }],
  ["save_bad_exclude_v2", "PUT", "/api/v2/plans/3/kit-manifest", { kit: { exclude: null } }],
  ["save_bad_replacements_flat", "PUT", "/plans/3/kit-manifest", { kit: { replacements: { a: 1 } } }],
  ["save_array_replacements_v1", "PUT", "/api/v1/plans/3/kit-manifest", { kit: { replacements: [] } }],
  ["save_bad_choice_tree_v2", "PUT", "/api/v2/plans/3/kit-manifest", { kit: { choice_tree: {} } }],
  ["save_bad_category_links_flat", "PUT", "/plans/3/kit-manifest", { kit: { category_links: "x" } }],
  ["kit_after_refusals_v2", "GET", "/api/v2/plans/3/kit-manifest"],
  // Node skips a selection for a group no attached Source defines and saves
  // it; Rust refuses it. These run last so that no later read sees Node's write.
  ["save_unknown_group_v1", "PUT", "/api/v1/plans/3/kit-manifest", { kit: { selections: { toolhead: "mini" } } }],
  ["save_unknown_group_list_flat", "PUT", "/plans/4/kit-manifest", { kit: { selections: { extras: ["skirts", "panels"] } } }],
];
if (process.argv.includes("--probe")) {
  const load = (source) => import(pathToFileURL(join(root, source)).href);
  const require = createRequire(join(root, "web/apps/server/package.json"));
  const Database = require("better-sqlite3");
  const dataDir = mkdtempSync(join(tmpdir(), "pp-parity-manifest-http-"));
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
    assert.equal(byId.save_v2.node.status, 200);
    assert.equal(byId.builder_flat.node.status, 200);
    assert.equal(byId.kit_missing_flat.node.status, 404);
    for (const item of cases) {
      if (item.method !== "PUT" || item.node.status !== 200) {
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
const scratch = mkdtempSync(join(tmpdir(), "pp-parity-manifest-http-probe-"));
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
  "generated": ${JSON.stringify("@generated by fixtures/parity/manifest-http/generate.mjs. Do not edit.")},
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
