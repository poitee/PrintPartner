import process from "node:process";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { URL, fileURLToPath, pathToFileURL } from "node:url";

const web = fileURLToPath(new URL("../../", import.meta.url));
const committed = fileURLToPath(new URL("./schemas/", import.meta.url));
const mode = process.argv[2];
const output = process.argv[3];
assert(["--write", "--check"].includes(mode) && output, "Usage: generate.mjs --write|--check RECEIPT-DIRECTORY");
mkdirSync(output, { recursive: true });
const require = createRequire(join(web, "package.json"));
const { z } = await import(pathToFileURL(join(web, "node_modules/zod/index.js")).href);
const parsers = await import(pathToFileURL(join(web, "packages/contracts/src/plan-drafts.ts")).href);
const Ajv = require("ajv");
const goldenPath = join(web, "packages/contracts/test-fixtures/desktop/autosave-v1.json");
const goldenBytes = readFileSync(goldenPath);
const golden = JSON.parse(goldenBytes);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const save = (name, value) => writeFileSync(join(output, name), `${JSON.stringify(value, null, 2)}\n`);
function schemaArtifact(name, value) {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  const path = join(committed, name);
  if (mode === "--write") { mkdirSync(committed, { recursive: true }); writeFileSync(path, bytes); }
  else assert.equal(readFileSync(path, "utf8"), bytes, `Schema drift: ${name}; regenerate deliberately with --write`);
}
const sources = {
  parseSavePlanChoicesRequest: "save-request",
  parseApplyPlanDraftReceipt: "apply-receipt",
  parsePlanDraftIdentity: "draft-identity",
};

const exportedSchemas = new Map();
for (const parser of Object.keys(sources)) {
  const name = { parseSavePlanChoicesRequest: "savePlanChoicesRequestSchema", parseApplyPlanDraftReceipt: "applyPlanDraftReceiptSchema", parsePlanDraftIdentity: "planDraftIdentitySchema" }[parser];
  exportedSchemas.set(parser, parsers[name]);
}
const inputCases = golden.normalized.schema_cases;
for (const item of inputCases) {
  const result = exportedSchemas.get(item.parser).safeParse(item.input);
  assert.equal(result.success, item.outcome.kind === "accepted", item.name);
  if (result.success) assert.deepEqual(result.data, item.outcome.parsed, item.name);
}
const generated = new Map();
for (const [parser, schema] of [...exportedSchemas, ["planDraftBasisSchema", parsers.planDraftBasisSchema]]) {
  const name = sources[parser] ?? "accepted-base";
  for (const io of ["input", "output"]) {
    const schemaJson = z.toJSONSchema(schema, { io, target: "draft-7", unrepresentable: "throw" });
    schemaArtifact(`${name}.${io}.schema.json`, schemaJson);
    generated.set(`${parser}:${io}`, schemaJson);
  }
}
const baseline = globalThis.structuredClone(inputCases.find((item) => item.name === "quantity-null-reset").input);
const supplemental = [];
function capture(name, parser, input, rawInput) {
  let outcome;
  try { outcome = { kind: "accepted", parsed: parsers[parser](input) }; }
  catch (error) {
    assert(error instanceof z.ZodError);
    outcome = { kind: "rejected", issues: error.issues };
  }
  supplemental.push({ name, direction: parser === "parseSavePlanChoicesRequest" ? "input" : "output", parser, ...(rawInput ? { raw_input: rawInput } : { input }), outcome });
}
for (const count of [1000, 1001]) {
  const input = globalThis.structuredClone(baseline);
  input.decisions[0].target.source_layer = "🙂".repeat(count);
  capture(`source-layer-codepoints-${count}-emoji`, "parseSavePlanChoicesRequest", input);
}
const integral = globalThis.structuredClone(baseline);
integral.decisions[0].value = 1;
const integralText = JSON.stringify(integral).replace('"value":1', '"value":1.0');
capture("integral-float-lexeme", "parseSavePlanChoicesRequest", JSON.parse(integralText), integralText);
const receipt = globalThis.structuredClone(inputCases.find((item) => item.name === "receipt-valid").input);
capture("receipt-time-is-bounded-text", "parseApplyPlanDraftReceipt", { ...receipt, applied_at: "not a timestamp" });
capture("receipt-safe-integer-limit", "parseApplyPlanDraftReceipt", { ...receipt, profile_id: Number.MAX_SAFE_INTEGER });
capture("receipt-unsafe-integer-rejected", "parseApplyPlanDraftReceipt", { ...receipt, profile_id: Number.MAX_SAFE_INTEGER + 1 });
for (const [field, parser] of [["part_key", "parseSavePlanChoicesRequest"], ["relative_path", "parseSavePlanChoicesRequest"], ["source_layer", "parseSavePlanChoicesRequest"], ["applied_at", "parseApplyPlanDraftReceipt"]]) {
  for (const [label, rawText, accepted] of [["lone-high", "\\ud800", false], ["lone-low", "\\udfff", false], ["reversed-pair", "\\udfff\\ud800", false], ["valid-pair", "\\ud83d\\ude42", true], ["mixed-scalars", "a\\ud83d\\ude42é", true]]) {
    const input = globalThis.structuredClone(parser === "parseSavePlanChoicesRequest" ? baseline : receipt);
    if (parser === "parseSavePlanChoicesRequest") input.decisions[0].target[field] = "TEXT_SLOT";
    else input[field] = "TEXT_SLOT";
    const raw = JSON.stringify(input).replace("TEXT_SLOT", rawText);
    const value = JSON.parse(raw);
    const text = parser === "parseSavePlanChoicesRequest" ? value.decisions[0].target[field] : value[field];
    assert.equal(text.isWellFormed(), accepted, `${field}-${label} ECMAScript well-formed Unicode`);
    capture(`${field}-${label}`, parser, value, raw);
    const outcome = supplemental.at(-1).outcome;
    assert.equal(outcome.kind === "accepted", accepted, `${field}-${label}`);
    if (!accepted) assert(outcome.issues.some((issue) => issue.message === "invalid_unicode_scalar_text"));
  }
}
const schemaResults = [];
const ajv = new Ajv({ allErrors: true, jsonPointers: true });
for (const item of [...inputCases, ...supplemental]) {
  const validate = ajv.compile(generated.get(`${item.parser}:${item.direction}`));
  const accepted = validate(item.raw_input ? JSON.parse(item.raw_input) : item.input);
  schemaResults.push({ name: item.name, parser: item.parser, direction: item.direction, node_accepted: item.outcome.kind === "accepted", schema_accepted: accepted, matches: accepted === (item.outcome.kind === "accepted"), errors: validate.errors });
}
const expectedSchemaGaps = ["empty-base-version-mismatch", "revision-base-version-zero", "observed-consumed-draft", "observed-draft-base-mismatch", "duplicate-field"];
for (const field of ["part_key", "relative_path", "source_layer", "applied_at"]) {
  for (const suffix of ["lone-high", "lone-low", "reversed-pair"]) expectedSchemaGaps.push(`${field}-${suffix}`);
}
assert.deepEqual(schemaResults.filter((item) => !item.matches).map((item) => item.name), expectedSchemaGaps, "Unreviewed JSON Schema semantic coverage drift");
const source = {
  fixture: goldenPath, fixture_sha256: sha256(goldenBytes), parser_source: join(web, "packages/contracts/src/plan-drafts.ts"),
  parser_source_sha256: sha256(readFileSync(join(web, "packages/contracts/src/plan-drafts.ts"))),
  versions: { node: process.version, zod: require("zod/package.json").version, ajv: require("ajv/package.json").version, tsx: require("tsx/package.json").version },
  schema_source: "Intentional exported Zod schemas; 41 original cases rechecked before native schema conversion",
};
save("node-cases.json", { source, cases: inputCases, supplemental, route_receipts: golden.normalized.route_cases.filter((item) => item.response?.receipt).map((item) => ({ name: item.name, receipt: item.response.receipt })) });
save("schema-acceptance.json", { source, generated_schema_count: generated.size, exported_schema_checks: inputCases.length, cases: schemaResults, mismatches: schemaResults.filter((item) => !item.matches) });
const keywords = new Set(["type", "required", "additionalProperties", "enum", "const", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "minItems", "maxItems", "pattern"]);
function constraints(value, path = "$") {
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) => [
    ...(keywords.has(key) ? [{ path: `${path}.${key}`, keyword: key, value: item }] : []),
    ...constraints(item, `${path}.${key}`),
  ]);
}
const semanticRules = {
  schema_derived: Object.fromEntries([...generated].map(([name, schema]) => [name, constraints(schema)])),
  domain_refinements: [
    { category: "basis_inconsistent", rule: "revision_id is null exactly when plan_version is zero", scopes: ["expected_base", "expected_draft.base", "identity.base"], witnesses: ["empty-base-version-mismatch", "revision-base-version-zero"], rust: "PlanDraftBasis TryFrom validator" },
    { category: "observed_draft_mismatch", rule: "non-null observed draft must be open and its revision_id/plan_version must equal expected_base", scope: "expected_draft", witnesses: ["observed-consumed-draft", "observed-draft-base-mismatch"], rust: "SavePlanChoicesRequest TryFrom validator" },
    { category: "duplicate_target_field", rule: "unique tuple of decision kind, nullable source_layer, relative_path and part_key; different fields on same file are allowed", scope: "decisions", witnesses: ["duplicate-field", "different-fields-same-target"], rust: "HashSet of decision kind and exact FileTarget" },
  ],
  wire_semantics: {
    nullable_presence: "revision_id, expected_draft, source_layer and quantity value are required fields whose values may be null; no serde default",
    numeric: "JSON numbers must be mathematically integral and bounded; integral float lexemes accepted, strings and booleans rejected; IDs and versions limited to JavaScript MAX_SAFE_INTEGER",
    strings: "Installed Zod4.5.4 uses Unicode code-point lengths; Rust chars().count() matches the measured 1000/1001 emoji bounds",
    receipt: "applied_at is bounded nonempty text, not an ISO timestamp refinement; all IDs/digests are serialized from provided values unchanged",
  },
  diagnostic_projection: {
    equal: ["accepted versus rejected", "accepted parsed JSON values", "serialized receipt fields"],
    separate: ["Zod issue array and message wording", "Rust category, field/path and detailed serde error"],
    rejection_categories: ["missing_field", "unknown_field", "invalid_variant", "invalid_shape", "integer_type", "integer_bounds", "text_codepoint_bounds", "digest_pattern", "decision_count", "basis_inconsistent", "observed_draft_mismatch", "duplicate_target_field", "invalid_json", "invalid_unicode_scalar_text"],
    note: "Serde tagged-enum buffering can report a containing decision index while detail identifies its nested missing/unknown field. This is retained honestly and is not claimed equal to Zod's path presentation.",
  },
  scalar_text: { fields: ["decisions[].target.part_key", "decisions[].target.relative_path", "decisions[].target.source_layer", "applied_at"], category: "invalid_unicode_scalar_text", rule: "Reject unpaired UTF-16 surrogates; preserve valid pairs and scalar values; length counts code points", structural_schema_encodes_this_refinement: false },
};
schemaArtifact("semantic-constraints.json", semanticRules);
save("semantic-constraints.json", semanticRules);
process.stdout.write(`PASS: 41 original cases; ${generated.size} exported Zod input/output schemas; ${supplemental.length} separate measured supplemental cases; deterministic ${mode}\n`);
