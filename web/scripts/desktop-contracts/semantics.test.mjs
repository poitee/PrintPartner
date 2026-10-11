import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { URL } from "node:url";
import { z } from "zod";
import { semanticFixtureSchema } from "../../packages/contracts/test-fixtures/t9/schema.ts";
import { auditRefinements } from "./refinements.mjs";

const corpus = JSON.parse(readFileSync(new URL("../../packages/contracts/test-fixtures/t9/semantics.json", import.meta.url), "utf8"));
for (const item of corpus.cases) {
  test(`ticket_t_9_semantics: ${item.name}`, () => {
    const result = semanticFixtureSchema.safeParse(item.input);
    assert.equal(result.success, item.accepted);
    if (result.success) assert.deepEqual(result.data, item.output);
  });
}
test("ticket_t_9: input/output required fields differ for defaults", () => {
  const input = z.toJSONSchema(semanticFixtureSchema, { io: "input", target: "draft-7" });
  const output = z.toJSONSchema(semanticFixtureSchema, { io: "output", target: "draft-7" });
  assert(!input.required.includes("defaulted"));
  assert(output.required.includes("defaulted"));
  assert(!input.required.includes("optional"));
  assert(output.required.includes("nullable"));
  assert.equal(output.additionalProperties, false);
});
test("ticket_t_9: unsupported types and unadapted refinements fail explicitly", () => {
  for (const schema of [z.date(), z.string().transform((value) => value.length)]) {
    assert.throws(() => z.toJSONSchema(schema, { unrepresentable: "throw" }));
  }
  assert.throws(() => auditRefinements(z.string().refine((value) => value !== "bad"), {}), /Unsupported refinement/);
  assert.throws(() => auditRefinements(z.object({ nested: z.string().superRefine(() => {}) }), {}), /Unsupported refinement/);
  assert.throws(() => auditRefinements(z.lazy(() => z.string().refine(() => false)), {}), /Unsupported refinement/);
});
