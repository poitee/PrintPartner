import process from "node:process";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL, pathToFileURL, fileURLToPath } from "node:url";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { generate } from "./generate.mjs";
import * as generated from "../../packages/contracts/src/rust-wire.generated.ts";
import {
  parseApplyPlanDraftReceipt,
  parsePlanDraftIdentity,
  parseSavePlanChoicesRequest,
  rustOwnedWireParsers,
} from "../../packages/contracts/src/plan-drafts.ts";

const load = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const probe = load("../../packages/contracts/test-fixtures/t9/semantics.json").cases;
const autosave = load("../../packages/contracts/test-fixtures/desktop/autosave-v1.json").normalized.schema_cases;
const supplemental = load("./supplemental.json").cases;
const zeroCases = load("./negative-zero-cases.json").cases;
const wireCases = load("./wire-cases.json").cases;
assert.equal(probe.length, 34);
assert.equal(autosave.length, 41);
assert.equal(supplemental.length, 50);
const parsers = (module) => ({
  parseSavePlanChoicesRequest: module.savePlanChoicesRequestSchema,
  parseApplyPlanDraftReceipt: module.applyPlanDraftReceiptSchema,
  parsePlanDraftIdentity: module.planDraftIdentitySchema,
  semanticFixtureSchema: module.semanticFixtureSchema,
});
const rows = [
  ...probe.map((item) => ({...item, parser: "semanticFixtureSchema", expected: item.accepted, output: item.output})),
  ...[...autosave, ...supplemental, ...wireCases, ...zeroCases].map((item) => ({...item, expected: item.outcome.kind === "accepted", output: item.outcome.parsed})),
];
assert.equal(wireCases.length, 4);
for (const row of wireCases) test(`ticket_t_63_contracts_node_wire_boundary: ${row.name}`, () => {
  const input = JSON.parse(row.raw_input);
  if (row.outcome.kind === "accepted") assert.deepEqual(parseSavePlanChoicesRequest(input), row.outcome.parsed);
  else assert.throws(() => parseSavePlanChoicesRequest(input));
});
const productionParsers = {
  parseSavePlanChoicesRequest,
  parseApplyPlanDraftReceipt,
  parsePlanDraftIdentity,
};
test("ticket_t_63_contracts_production_parsers_are_rust_owned", () => {
  assert.equal(rustOwnedWireParsers.parseSavePlanChoicesRequest, generated.savePlanChoicesRequestSchema);
  assert.equal(rustOwnedWireParsers.parseApplyPlanDraftReceipt, generated.applyPlanDraftReceiptSchema);
  assert.equal(rustOwnedWireParsers.parsePlanDraftIdentity, generated.planDraftIdentitySchema);
  for (const row of zeroCases) {
    const input = JSON.parse(row.raw_input);
    if (row.outcome.kind === "accepted") assert.deepEqual(productionParsers[row.parser](input), row.outcome.parsed);
    else assert.throws(() => productionParsers[row.parser](input));
  }
});
function mismatchCount(module) {
  const schemas = parsers(module);
  return rows.filter((row) => {
    const input = row.raw_input ? JSON.parse(row.raw_input) : row.input;
    const result = schemas[row.parser].safeParse(input);
    if (result.success !== row.expected) return true;
    if (!result.success) return false;
    try { assert.deepEqual(result.data, row.output); return false; } catch { return true; }
  }).length;
}
for (const row of rows) test(`ticket_t_63_contracts_generated: ${row.name}`, () => {
  const result = parsers(generated)[row.parser].safeParse(row.raw_input ? JSON.parse(row.raw_input) : row.input);
  assert.equal(result.success, row.expected, JSON.stringify(result));
  if (result.success) assert.deepEqual(result.data, row.output);
});
test("ticket_t_63_contracts_generated_integral_float_safe_max_receipt", () => {
  const original = autosave.find((row) => row.name === "receipt-valid").input;
  const expected = {...original, profile_id: Number.MAX_SAFE_INTEGER};
  const text = JSON.stringify(expected).replace('"profile_id":9007199254740991', '"profile_id":9007199254740991.0');
  assert(text.includes("9007199254740991.0"));
  assert.deepEqual(generated.applyPlanDraftReceiptSchema.parse(JSON.parse(text)), expected);
});
const schemas = load("./schemas.json");
test("ticket_t_63_contracts_generated_artifact_rejects_drift", () => {
  const actual = readFileSync(new URL("../../packages/contracts/src/rust-wire.generated.ts", import.meta.url), "utf8");
  assert.equal(actual, generate(schemas));
  assert.doesNotMatch(actual, /isWellFormed/);
  assert.match(actual, /z\.discriminatedUnion\("kind"/);
  assert.match(actual, /\[\\uD800-\\uDFFF\]/u);
  const dir = mkdtempSync(join(tmpdir(), "pp-rust-contract-drift-"));
  try {
    const path = join(dir, "drift.ts");
    writeFileSync(path, actual + "// planted drift\n");
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./generate.mjs", import.meta.url)), "--check", fileURLToPath(new URL("./schemas.json", import.meta.url)), path], {encoding: "utf8"});
    assert.equal(result.status, 1);
    assert.match(result.stderr, /artifact drift/);
  } finally { rmSync(dir, {recursive: true}); }
});
test("ticket_t_63_contracts_generator_fails_closed", () => {
  for (const change of [
    (doc) => {doc.roots.probe.not = {};},
    (doc) => {doc.refinements.SemanticFixture = "unreviewed-rule";},
    (doc) => {delete doc.refinements.SemanticFixture;},
    (doc) => {doc.roots.probe.properties.date = {type: "string", format: "unreviewed-format"};},
  ]) {
    const doc = globalThis.structuredClone(schemas); change(doc);
    assert.throws(() => generate(doc), /Unsupported|Missing Rust refinement/);
  }
});
async function mutatedModule(change, changeOutput = (source) => source) {
  const doc = globalThis.structuredClone(schemas); change(doc);
  const dir = mkdtempSync(join(tmpdir(), "pp-rust-contract-mutation-"));
  writeFileSync(join(dir, "package.json"), '{"type":"module"}\n');
  symlinkSync(fileURLToPath(new URL("../../node_modules", import.meta.url)), join(dir, "node_modules"), "dir");
  const output = join(dir, "generated.ts");
  writeFileSync(output, changeOutput(generate(doc)));
  try { return await import(pathToFileURL(output).href); } finally { rmSync(dir, {recursive: true}); }
}
for (const [name, change] of [
  ["nullable presence", (doc) => {doc.roots.probe.required = doc.roots.probe.required.filter((key) => key !== "nullable");}],
  ["default", (doc) => {doc.roots.probe.properties.defaulted.default = 4;}],
  ["integer bounds", (doc) => {doc.roots.probe.definitions.WireInteger_0_9007199254740991.maximum = 10;}],
  ["unknown stripping", (doc) => {doc.roots.probe.additionalProperties = false;}],
  ["refinement", (doc) => {doc.refinements.SemanticFixture = "basis-consistency";}],
]) test(`ticket_t_63_contracts_planted_wrong_${name}`, async () => {
  const module = await mutatedModule(change);
  assert(mismatchCount(module) > 0, `${name} mutation escaped full corpus`);
});

test("ticket_t_63_contracts_planted_wrong_negative_zero_output", async () => {
  const module = await mutatedModule(() => {}, (source) => {
    const changed = source.replaceAll(".transform((value) => value === 0 ? 0 : value)", "");
    assert.notEqual(changed, source);
    return changed;
  });
  assert(mismatchCount(module) >= 3, "Removed scalar normalization escaped raw-input DTO corpus");
});
