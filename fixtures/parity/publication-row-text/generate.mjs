// Node >= 22.18; npm --prefix web ci --ignore-scripts.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const rootUrl = pathToFileURL(root).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith(".js") && context.parentURL?.startsWith(rootUrl)) {
      const url = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
      if (existsSync(url)) return { url: url.href, shortCircuit: true };
    }
    return next(specifier, { ...context, conditions: [...context.conditions, "development"] });
  },
  load(url, context, next) {
    if (url.startsWith(rootUrl) && url.endsWith(".ts")) {
      return { format: "module", source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { mode: "transform", sourceUrl: url }), shortCircuit: true };
    }
    return next(url, context);
  },
});
const load = (path) => import(pathToFileURL(join(root, path)).href);
const { AppRepository } = await load("web/apps/server/src/db/repository.ts");
const schema = await load("web/apps/server/src/db/schema.ts");
const { digestPlanInputs } = await load("web/apps/server/src/services/plan-freshness.ts");
const { AcceptedOperationalRowTextLimitError } = await load("web/apps/server/src/services/plan-publication.ts");
const expand = (value) => typeof value === "object" && value !== null
  ? value.repeat.repeat(value.count) + (value.suffix ?? "") : value;
const snake = (key) => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
const extra = { repeat: "😀", count: 16385 };

// Only storage and unrelated profile/source lookups are fake. Both publication
// methods and their text validation run unchanged from the real repository.
function publish(row, table) {
  const inputs = table === "plan_revision_inputs" ? [{
    source_id: row.source_id, source_layer: row.source_layer,
    layer_order: row.layer_order, tracking_kind: row.tracking_kind,
    source_revision_id: row.source_revision_id, manifest_digest: row.manifest_digest,
    effective_naming_digest: row.effective_naming_digest,
  }] : [];
  const stored = new Map();
  const db = {
    insert(table) {
      let values;
      const query = {
        values(value) { values = { ...value }; return query; },
        onConflictDoNothing() { return query; },
        run() {
          values.id = 1;
          values.fixtureExtraText = expand(extra);
          stored.set(table, [values]);
        },
      };
      return query;
    },
    select() {
      let table;
      const query = {
        from(value) { table = value; return query; },
        where() { return query; }, orderBy() { return query; },
        get() { return stored.get(table)?.[0]; },
        all() { return stored.get(table) ?? []; },
      };
      return query;
    },
    update(table) {
      const query = {
        set(value) { Object.assign(stored.get(table)[0], value); return query; },
        where() { return query; }, run() {},
      };
      return query;
    },
  };
  const repo = Object.assign(Object.create(AppRepository.prototype), {
    defaultTenantId: "fixtures", schema, db,
    requireProfile() {}, getSource() { return { id: 1 }; },
  });
  try {
    const result = repo.publishPlanRevisionInputs(1, inputs, table === "plan_revision_input_sets" ? row.recordedAt : "2026-10-19T00:00:00.000Z");
    assert.equal(result.format_version, 2);
    assert.equal(result.inputs.length, inputs.length);
    const saved = { ...stored.get(table === "plan_revision_inputs" ? schema.planRevisionInputs : schema.planRevisionInputSets)[0] };
    delete saved.id;
    const actual = table === "plan_revision_inputs"
      ? Object.fromEntries(Object.entries(saved).map(([key, value]) => [snake(key), value])) : saved;
    assert.deepEqual(actual, row);
    return "accepted";
  } catch (error) {
    if (!(error instanceof AcceptedOperationalRowTextLimitError)) throw error;
    return error.code;
  }
}

const cases = [];
for (const [encoding, timestamp, layer] of [
  ["ascii", { repeat: "a", count: 32732 }, { repeat: "a", count: 65455 }],
  ["utf8", { repeat: "é", count: 16366 }, { repeat: "😀", count: 16363, suffix: "éx" }],
]) {
  for (const over of [false, true]) {
    for (const table of ["plan_revision_input_sets", "plan_revision_inputs"]) {
      const text = structuredClone(table === "plan_revision_input_sets" ? timestamp : layer);
      if (over) text.suffix = (text.suffix ?? "") + "x";
      const row = table === "plan_revision_input_sets" ? {
        tenantId: "fixtures", profileId: 1, inputSetDigest: digestPlanInputs([]),
        expectedInputCount: 0, formatVersion: 2, recordedAt: text, publishedAt: text,
        fixtureExtraText: extra,
      } : {
        tenant_id: "fixtures", input_set_id: 1, source_id: 1, source_layer: text,
        layer_order: 0, tracking_kind: "untracked", source_revision_id: null,
        manifest_digest: null, effective_naming_digest: "a".repeat(64),
        fixture_extra_text: extra,
      };
      const expected = publish(Object.fromEntries(Object.entries(row).map(([key, value]) => [key, expand(value)])), table);
      assert.equal(expected, over ? "accepted_operational_row_text_limit" : "accepted");
      cases.push({ id: `${table}-${encoding}-${over ? "over" : "at"}`, table, row, expected });
    }
  }
}
const output = JSON.stringify({ generatedBy: "node fixtures/parity/publication-row-text/generate.mjs", cases }, null, 2) + "\n";
const path = join(here, "node.json");
if (process.argv.includes("--check")) assert.equal(readFileSync(path, "utf8"), output, "Node row-text fixture is stale");
else writeFileSync(path, output);
console.log(`${cases.length} Node publication row-text cases passed`);
