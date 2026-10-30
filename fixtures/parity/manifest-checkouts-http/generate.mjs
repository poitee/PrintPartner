// Generates the manifest-checkouts-http parity golden: complete HTTP responses
// from Node's real app for plan-manifest-builder reads and kit-manifest saves
// over real Source checkouts, on the flat, /api/v1 and /api/v2 mounts, plus the
// database tables each request changed. Node opens a copy of the
// required-units `unchanged.db` fixture after `SEED` adds Sources 2-6 and
// Plans 3 and 4. `FILES` lays out the checkouts (manifests declaring option
// groups, STLs, an invalid manifest) and a custom `path-hints.yaml` under the
// scratch data directory, and `CHECKOUTS` points each Source's `local_path` at
// `repos/<id>` there; Source 5's checkout does not exist. The Rust test writes
// the same files, sets the same paths and reads them through the production
// `SourceReads` adapter. Run from the repo root after `npm --prefix web ci`:
//   node fixtures/parity/manifest-checkouts-http/generate.mjs          # write
//   node fixtures/parity/manifest-checkouts-http/generate.mjs --check  # verify, no writes
// No response carries a clock value or an absolute path, so every body stays
// literal. Names are ASCII so Node's localeCompare sort agrees across ICU builds.
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
const database = "rust/crates/pp-storage/tests/fixtures/required-units/unchanged.db";
const sources = [
  "web/apps/server/src/routes/plans.ts",
  "web/apps/server/src/services/plan-manifest-builder.ts",
  "web/apps/server/src/services/manifest-apply.ts",
];
const SEED = [
  "INSERT INTO projects (id, tenant_id, name, url, imported_paths) VALUES",
  "(2, 'default', 'Frame Kit', 'https://example.test/frame', NULL),",
  `(3, 'default', 'Addon Kit', 'https://example.test/addon', '["toolhead", "lighting"]'),`,
  "(4, 'default', 'Inferred Source', 'https://example.test/inferred', NULL),",
  "(5, 'default', 'Missing Checkout', 'https://example.test/missing', NULL),",
  "(6, 'default', 'Broken Manifest', 'https://example.test/broken', NULL);",
  "INSERT INTO build_profiles (id, tenant_id, name) VALUES",
  "(3, 'default', 'Checkout Plan'), (4, 'default', 'Inferred Plan');",
  "INSERT INTO profile_layers (tenant_id, profile_id, layer_order, layer_type, project_id) VALUES",
  "('default', 3, 0, 'base', 2), ('default', 3, 1, 'addon', 3),",
  "('default', 4, 0, 'base', 4), ('default', 4, 1, 'addon', 5), ('default', 4, 2, 'addon', 6);",
].join(" ");
// Each Source's `local_path`, relative to the data directory.
const CHECKOUTS = { 2: "repos/2", 3: "repos/3", 4: "repos/4", 5: "repos/5", 6: "repos/6" };
// Files relative to the data directory.
const FILES = {
  "repos/2/print-partner.manifest.yaml": `format: print-partner-manifest-v2
version: 2
project: Frame Kit
option_groups:
  toolhead:
    label: Toolhead
    variants:
      - id: stock
        label: Stock
        parts: ["toolhead/stock/**"]
      - id: mini
        parts: ["toolhead/mini/**"]
        excludes: ["frame/cover.stl"]
  extras:
    rule: pick_any
    label: Extras
    max: 2
    variants:
      - id: skirts
        parts: ["extras/skirt*.stl"]
      - id: panels
        label: Panels
        parts: ["extras/panel.stl"]
      - id: feet
        parts: ["feet/**"]
selections:
  toolhead: stock
`,
  "repos/2/toolhead/stock/hotend.stl": "solid stock",
  "repos/2/toolhead/mini/hotend.stl": "solid mini",
  "repos/2/extras/skirt_a.stl": "solid skirt",
  "repos/2/extras/panel.stl": "solid panel",
  "repos/2/frame/cover.stl": "solid cover",
  "repos/2/frame/rail.STL": "solid rail",
  "repos/2/docs/readme.txt": "not a part",
  "repos/3/print-partner.manifest.yaml": `option_groups:
  toolhead:
    label: Addon toolhead
    variants:
      - id: stock
        parts: ["toolhead/stock/**"]
      - id: stealth
        label: Stealth
        parts: ["toolhead/stealth/**"]
  lighting:
    rule: pick_any
    variants:
      - id: led
        parts: ["lighting/led.stl"]
      - id: bar
        parts: ["lighting/bar/**"]
selections:
  lighting: [led]
  toolhead: stealth
`,
  "repos/3/toolhead/stealth/hood.stl": "solid hood",
  "repos/3/toolhead/stock/fan.stl": "solid fan",
  "repos/3/lighting/led.stl": "solid led",
  "repos/3/unrelated/skip.stl": "solid skip",
  "repos/4/options/stock/a.stl": "solid a",
  "repos/4/options/custom/b.stl": "solid b",
  "repos/4/frame/rail_mount.stl": "solid mount",
  "repos/6/print-partner.manifest.yaml": "not: [valid",
  "repos/6/plates/base.stl": "solid base",
  "path-hints.yaml":
    'version: 1\nrules:\n  - path: "**/rail_mount.stl"\n    option_group: rail_mounts\n    variant_id: printed_mount\n',
};

// Each request runs in order on one database. Saves replace the whole kit, as
// Node merges each save over the empty kit.
const REQUESTS = [
  ["builder_flat", "GET", "/plans/3/plan-manifest-builder"],
  ["builder_inferred_v2", "GET", "/api/v2/plans/4/plan-manifest-builder"],
  ["save_v1", "PUT", "/api/v1/plans/3/kit-manifest", { kit: { selections: { toolhead: "mini", extras: ["skirts", "panels"] } } }],
  ["kit_after_save_flat", "GET", "/plans/3/kit-manifest"],
  ["builder_after_save_v2", "GET", "/api/v2/plans/3/plan-manifest-builder"],
  // A pick_one group also accepts a one-entry list.
  ["save_list_pick_one_flat", "PUT", "/plans/3/kit-manifest", { kit: { selections: { toolhead: ["stealth"], lighting: [] } } }],
  ["builder_after_list_v1", "GET", "/api/v1/plans/3/plan-manifest-builder"],
  ["save_empty_pick_one_v2", "PUT", "/api/v2/plans/3/kit-manifest", { kit: { selections: { toolhead: [] } } }],
  ["save_two_pick_one_v1", "PUT", "/api/v1/plans/3/kit-manifest", { kit: { selections: { toolhead: ["stock", "mini"] } } }],
  ["save_over_max_flat", "PUT", "/plans/3/kit-manifest", { kit: { selections: { extras: ["skirts", "panels", "feet"] } } }],
  // The first group over its limit names the refusal.
  ["save_first_error_v2", "PUT", "/api/v2/plans/3/kit-manifest", { kit: { selections: { lighting: ["led", "bar"], extras: ["skirts", "panels", "feet"], toolhead: ["stock", "mini"] } } }],
  ["kit_after_refusals_v1", "GET", "/api/v1/plans/3/kit-manifest"],
  // A save without selections still observes the checkouts in Rust.
  ["save_no_selections_flat", "PUT", "/plans/3/kit-manifest", { kit: { name: "Named kit", include: ["frame/rail.STL"] } }],
  ["builder_after_named_v2", "GET", "/api/v2/plans/3/plan-manifest-builder"],
  ["save_inferred_v2", "PUT", "/api/v2/plans/4/kit-manifest", { kit: { selections: { rail_mounts: "printed_mount", options: "custom" } } }],
  ["builder_inferred_after_save_flat", "GET", "/plans/4/plan-manifest-builder"],
  ["save_inferred_two_v1", "PUT", "/api/v1/plans/4/kit-manifest", { kit: { selections: { rail_mounts: ["printed_mount", "printed_mount2"] } } }],
  // Node checks only how many variants a known group gets and saves unknown
  // groups and variant ids; Rust refuses both. These run last so that no later
  // read sees Node's writes.
  ["save_unknown_variant_v1", "PUT", "/api/v1/plans/3/kit-manifest", { kit: { selections: { toolhead: "turbo" } } }],
  ["save_unknown_group_flat", "PUT", "/plans/3/kit-manifest", { kit: { selections: { toolhead: "stock", wheels: ["big"] } } }],
  ["save_unknown_inferred_group_v2", "PUT", "/api/v2/plans/4/kit-manifest", { kit: { selections: { toolhead: "stock" } } }],
];
if (process.argv.includes("--probe")) {
  const load = (source) => import(pathToFileURL(join(root, source)).href);
  const require = createRequire(join(root, "web/apps/server/package.json"));
  const Database = require("better-sqlite3");
  const dataDir = mkdtempSync(join(tmpdir(), "pp-parity-manifest-checkouts-http-"));
  try {
    copyFileSync(join(root, database), join(dataDir, "print-partner.db"));
    for (const [path, body] of Object.entries(FILES)) {
      mkdirSync(dirname(join(dataDir, path)), { recursive: true });
      writeFileSync(join(dataDir, path), body);
    }
    const seeder = new Database(join(dataDir, "print-partner.db"));
    seeder.exec(SEED);
    const setPath = seeder.prepare("UPDATE projects SET local_path = ? WHERE id = ?");
    for (const [id, path] of Object.entries(CHECKOUTS)) setPath.run(join(dataDir, path), Number(id));
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
    // The corpus is only useful if Node really read the checkouts.
    const groups = (item) => Object.keys(item.node.body.merged_option_groups);
    assert.deepEqual(groups(byId.builder_flat), ["toolhead", "extras", "lighting"]);
    assert.ok(groups(byId.builder_inferred_v2).includes("rail_mounts"));
    assert.equal(byId.builder_inferred_v2.node.body.sources.length, 3);
    for (const id of ["save_v1", "save_inferred_v2", "save_unknown_variant_v1", "save_unknown_group_flat"]) {
      assert.equal(byId[id].node.status, 200, id);
    }
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
const scratch = mkdtempSync(join(tmpdir(), "pp-parity-manifest-checkouts-http-probe-"));
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
  "generated": ${JSON.stringify("@generated by fixtures/parity/manifest-checkouts-http/generate.mjs. Do not edit.")},
  "sources": ${JSON.stringify(sources)},
  "database": ${JSON.stringify(database)},
  "seed": ${JSON.stringify(SEED)},
  "checkouts": ${JSON.stringify(CHECKOUTS)},
  "files": ${JSON.stringify(FILES)},
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
