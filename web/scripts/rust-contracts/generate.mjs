import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const generatorVersion = "rust-contracts-zod/1";
const keywords = new Set(["$schema", "$ref", "definitions", "title", "description", "type", "properties", "required", "additionalProperties", "enum", "const", "anyOf", "oneOf", "allOf", "items", "minItems", "maxItems", "minimum", "maximum", "minLength", "maxLength", "pattern", "format", "default", "x-unicode-scalar"]);
const tags = new Set(["basis-consistency", "request-consistency", "write-positive-default"]);
const quote = JSON.stringify;

export function generate(document) {
  assert.equal(document.generator, generatorVersion);
  assert.equal(document.schemars, "0.8.22");
  assert.equal(document.dialect, "http://json-schema.org/draft-07/schema#");
  for (const tag of Object.values(document.refinements)) assert(tags.has(tag), `Unsupported Rust refinement ${tag}`);
  assert.deepEqual(Object.keys(document.refinements).sort(), ["PlanDraftBasis", "SavePlanChoicesRequest", "SemanticFixture"], "Missing Rust refinement declaration");
  function emit(schema, definitions, name, visited = []) {
    assert(schema && typeof schema === "object" && !Array.isArray(schema), "Unsupported boolean/schema shape");
    for (const key of Object.keys(schema)) assert(keywords.has(key), `Unsupported Rust schema keyword ${key}`);
    if (schema.$schema) assert.equal(schema.$schema, document.dialect, "Unsupported Rust schema dialect");
    if (schema.oneOf) {
      const discriminants = schema.oneOf.map((branch) => branch.properties?.kind?.enum);
      assert(discriminants.every((values) => values?.length === 1), "Unsupported nondiscriminated oneOf");
      assert.equal(new Set(discriminants.map((values) => values[0])).size, discriminants.length, "Unsupported overlapping oneOf");
    }
    let result;
    if (schema.$ref) {
      assert(schema.$ref.startsWith("#/definitions/"), "External schema reference forbidden");
      const key = schema.$ref.slice(14);
      assert(!visited.includes(key), "Recursive schema requires an explicit supported adapter");
      assert(definitions[key], `Missing schema definition ${key}`);
      return emit(definitions[key], definitions, key, [...visited, key]);
    }
    const union = schema.anyOf ?? schema.oneOf;
    if (union) result = `z.union([${union.map((item) => emit(item, definitions)).join(", ")}])`;
    else if (schema.allOf) {
      assert.equal(schema.allOf.length, 1, "Multiple schema intersections unsupported");
      result = emit(schema.allOf[0], definitions);
    } else if (schema.enum) {
      assert(schema.enum.length > 0 && schema.enum.every((value) => value === null || ["string", "number", "boolean"].includes(typeof value)), "Unsupported enum literal");
      result = schema.enum.length === 1 ? `z.literal(${quote(schema.enum[0])})` : `z.union([${schema.enum.map((value) => `z.literal(${quote(value)})`).join(", ")}])`;
    } else if ("const" in schema) {
      assert(schema.const === null || ["string", "number", "boolean"].includes(typeof schema.const), "Unsupported const literal");
      result = `z.literal(${quote(schema.const)})`;
    }
    else if (Array.isArray(schema.type)) {
      result = `z.union([${schema.type.map((type) => emit({ ...schema, type }, definitions)).join(", ")}])`;
    } else switch (schema.type) {
      case "object": {
        assert(schema.additionalProperties === undefined || schema.additionalProperties === false, "Object passthrough/catchall unsupported");
        const required = new Set(schema.required ?? []);
        for (const key of required) assert(key in schema.properties, `Unsupported missing required property ${key}`);
        result = `z.object({${Object.entries(schema.properties ?? {}).map(([key, value]) => {
          let child = emit(value, definitions);
          if ("default" in value) {
            assert(value.default !== null, "Unsupported null default");
            child += `.default(${quote(value.default)})`;
          }
          else if (!required.has(key)) child += ".optional()";
          return `${quote(key)}: ${child}`;
        }).join(", ")}})`;
        if (schema.additionalProperties === false) result += ".strict()";
        break;
      }
      case "array":
        assert(schema.items && !Array.isArray(schema.items), "Tuple or untyped array unsupported");
        result = `z.array(${emit(schema.items, definitions)})`;
        if (schema.minItems !== undefined) result += `.min(${schema.minItems})`;
        if (schema.maxItems !== undefined) result += `.max(${schema.maxItems})`;
        break;
      case "integer": case "number":
        if (schema.type === "integer") {
          assert(Number.isSafeInteger(schema.minimum) && Number.isSafeInteger(schema.maximum), "Unsupported integer bounds outside the JavaScript safe range");
        }
        result = "z.number()" + (schema.type === "integer" ? ".int()" : "");
        if (schema.minimum !== undefined) result += `.min(${schema.minimum})`;
        if (schema.maximum !== undefined) result += `.max(${schema.maximum})`;
        break;
      case "string":
        assert(!schema.format || schema.format === "date", `Unsupported format ${schema.format}`);
        result = schema.format === "date" ? "z.iso.date()" : "z.string()";
        if (schema.minLength !== undefined) result += `.min(${schema.minLength})`;
        if (schema.maxLength !== undefined) result += `.max(${schema.maxLength})`;
        if (schema.pattern) result += `.regex(new RegExp(${quote(schema.pattern)}))`;
        if (schema["x-unicode-scalar"]) result += '.refine((value) => value.isWellFormed(), "invalid_unicode_scalar_text")';
        break;
      case "boolean": result = "z.boolean()"; break;
      case "null": result = "z.null()"; break;
      default: throw new Error(`Unsupported Rust schema type ${schema.type}`);
    }
    const tag = document.refinements[schema.title ?? name];
    if (tag === "basis-consistency") result += '.refine((value) => (value.revision_id === null) === (value.plan_version === 0), "basis_inconsistent")';
    if (tag === "write-positive-default") result += '.refine((value) => value.mode !== "write" || value.defaulted > 0, "write_requires_positive_default")';
    if (tag === "request-consistency") result += `.superRefine((value, context) => {
      const draft = value.expected_draft;
      if (draft !== null && (draft.state !== "open" || draft.base.revision_id !== value.expected_base.revision_id || draft.base.plan_version !== value.expected_base.plan_version)) context.addIssue({code: "custom", message: "observed_draft_mismatch"});
      const seen = new Set<string>();
      for (const decision of value.decisions) {
        const key = JSON.stringify([decision.kind, decision.target.source_layer, decision.target.relative_path, decision.target.part_key]);
        if (seen.has(key)) context.addIssue({code: "custom", message: "duplicate_target_field"});
        seen.add(key);
      }
    })`;
    return result;
  }
  const sourceHash = createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex");
  const schemaHash = createHash("sha256").update(JSON.stringify(document)).digest("hex");
  const exports = { basis: "planDraftBasisSchema", identity: "planDraftIdentitySchema", request: "savePlanChoicesRequestSchema", receipt: "applyPlanDraftReceiptSchema", probe: "semanticFixtureSchema" };
  assert.deepEqual(Object.keys(document.roots).sort(), Object.keys(exports).sort());
  return `// Generated by ${generatorVersion}; schemars 0.8.22; do not edit.\n// Generator SHA256: ${sourceHash}\n// Rust schema SHA256: ${schemaHash}\nimport { z } from "zod";\n\n${Object.entries(exports).map(([name, identifier]) => `export const ${identifier} = ${emit(document.roots[name], document.roots[name].definitions ?? {})};\nexport type ${identifier}Input = z.input<typeof ${identifier}>;\nexport type ${identifier}Output = z.output<typeof ${identifier}>;`).join("\n\n")}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, schemaPath, outputPath] = process.argv.slice(2);
  assert(["--write", "--check"].includes(mode) && schemaPath && outputPath, "Usage: generate.mjs --write|--check SCHEMAS OUTPUT");
  const generated = generate(JSON.parse(readFileSync(schemaPath, "utf8")));
  if (mode === "--write") writeFileSync(outputPath, generated);
  else assert.equal(readFileSync(outputPath, "utf8"), generated, "Generated Rust-to-Zod artifact drift");
}
