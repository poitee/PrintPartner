import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { test } from "node:test";
import { parseSavePlanChoicesRequest, parseApplyPlanDraftReceipt } from "../../packages/contracts/src/plan-drafts.ts";

const golden = JSON.parse(readFileSync(new URL("../../packages/contracts/test-fixtures/desktop/autosave-v1.json", import.meta.url), "utf8"));
const fixture = (name) => globalThis.structuredClone(golden.normalized.schema_cases.find((row) => row.name === name).input);
for (const field of ["part_key", "relative_path", "source_layer", "applied_at"]) {
  for (const [name, text, accepted] of [["lone high", "\ud800", false], ["lone low", "\udfff", false], ["reversed pair", "\udfff\ud800", false], ["valid pair", "🙂", true], ["mixed scalar text", "a🙂é", true]]) {
    test(`${field}: ${name}`, () => {
      const input = fixture(field === "applied_at" ? "receipt-valid" : "quantity-null-reset");
      const parser = field === "applied_at" ? parseApplyPlanDraftReceipt : parseSavePlanChoicesRequest;
      if (field === "applied_at") input[field] = text;
      else input.decisions[0].target[field] = text;
      assert.equal(text.isWellFormed(), accepted);
      if (accepted) assert.deepEqual(parser(input), input);
      else assert.throws(() => parser(input), /invalid_unicode_scalar_text/);
    });
  }
}
for (const [label, glyph] of [["emoji", "🙂"], ["CJK", "漢"], ["combining mark", "\u0301"]]) {
  test(`scalar source-layer bounds preserve codepoint counting (${label})`, () => {
    const input = fixture("quantity-null-reset");
    input.decisions[0].target.source_layer = glyph.repeat(1000);
    assert.deepEqual(parseSavePlanChoicesRequest(input), input);
    input.decisions[0].target.source_layer += glyph;
    assert.throws(() => parseSavePlanChoicesRequest(input));
  });
}
