import assert from "node:assert/strict";
import { ZodError } from "zod";
import {
  parseApplyPlanDraftReceipt, parsePlanDraftIdentity, parseSavePlanChoicesRequest,
} from "@print-partner/contracts";
import { json, type Json } from "./model.mjs";

export function schemaCases(): Json[] {
  const target = { part_key: "part", relative_path: "part.stl", source_layer: null };
  const included = { kind: "set_included", target, value: false };
  const quantity = { kind: "set_quantity_override", target, value: null };
  const base = { revision_id: 1, plan_version: 1 };
  const identity = { draft_id: 2, state: "open", lifecycle_version: 1, snapshot_digest: "a".repeat(64), base };
  const request = { expected_base: base, expected_draft: null, remap_checkoff_links: true, decisions: [included] };
  const receipt = {
    profile_id: 1, draft_id: 2, revision_id: 3, plan_version: 2, draft_lifecycle_version: 2,
    revision_digest: "b".repeat(64), required_unit_mapping_digest: "c".repeat(64), applied_at: "2026-09-06T00:00:00.000Z",
  };
  const cases: Json[] = [];
  function capture(name: string, direction: "input" | "output", parser: string, parse: (value: unknown) => unknown, input: unknown, accepted: boolean) {
    let outcome: Json;
    try { outcome = { kind: "accepted", parsed: json(parse(input)) }; }
    catch (error) {
      assert(error instanceof ZodError, `${name}: unexpected parser failure`);
      outcome = { kind: "rejected", issues: json(error.issues) };
    }
    assert.equal(outcome.kind, accepted ? "accepted" : "rejected", name);
    cases.push({ name, direction, parser, input: json(input), outcome });
  }
  const input = (name: string, value: unknown, accepted: boolean) => capture(name, "input", "parseSavePlanChoicesRequest", parseSavePlanChoicesRequest, value, accepted);
  input("included-false", request, true);
  input("included-true", { ...request, decisions: [{ ...included, value: true }] }, true);
  input("quantity-null-reset", { ...request, decisions: [quantity] }, true);
  for (const value of [1, 10000, 0, -1, 10001, 1.5, "1", true]) {
    input(`quantity-${String(value)}-${typeof value}`, { ...request, decisions: [{ ...quantity, value }] }, typeof value === "number" && (value === 1 || value === 10000));
  }
  input("quantity-omitted", { ...request, decisions: [{ kind: quantity.kind, target }] }, false);
  input("source-layer-omitted", { ...request, decisions: [{ ...included, target: { part_key: "part", relative_path: "part.stl" } }] }, false);
  input("source-layer-empty", { ...request, decisions: [{ ...included, target: { ...target, source_layer: "" } }] }, true);
  input("expected-draft-omitted", { expected_base: base, remap_checkoff_links: true, decisions: [included] }, false);
  input("empty-base", { ...request, expected_base: { revision_id: null, plan_version: 0 } }, true);
  input("empty-base-version-mismatch", { ...request, expected_base: { revision_id: null, plan_version: 1 } }, false);
  input("revision-base-version-zero", { ...request, expected_base: { revision_id: 1, plan_version: 0 } }, false);
  input("revision-id-string-no-coercion", { ...request, expected_base: { revision_id: "1", plan_version: 1 } }, false);
  input("observed-open-draft", { ...request, expected_draft: identity }, true);
  input("observed-consumed-draft", { ...request, expected_draft: { ...identity, state: "consumed" } }, false);
  input("observed-draft-base-mismatch", { ...request, expected_draft: { ...identity, base: { revision_id: 3, plan_version: 1 } } }, false);
  input("duplicate-field", { ...request, decisions: [included, included] }, false);
  input("different-fields-same-target", { ...request, decisions: [included, quantity] }, true);
  input("unknown-discriminator", { ...request, decisions: [{ ...included, kind: "set_filament" }] }, false);
  input("unknown-root-key", { ...request, extra: true }, false);
  input("unknown-target-key", { ...request, decisions: [{ ...included, target: { ...target, extra: true } }] }, false);
  input("unknown-decision-key", { ...request, decisions: [{ ...included, extra: true }] }, false);
  input("empty-decisions", { ...request, decisions: [] }, false);
  input("null-remap", { ...request, remap_checkoff_links: null }, false);
  const output = (name: string, value: unknown, accepted: boolean) => capture(name, "output", "parseApplyPlanDraftReceipt", parseApplyPlanDraftReceipt, value, accepted);
  output("receipt-valid", receipt, true);
  output("receipt-id-string-no-coercion", { ...receipt, revision_id: "3" }, false);
  output("receipt-null-digest", { ...receipt, revision_digest: null }, false);
  const { revision_digest: omittedDigest, ...withoutDigest } = receipt;
  assert.equal(omittedDigest.length, 64);
  output("receipt-omitted-digest", withoutDigest, false);
  output("receipt-uppercase-digest", { ...receipt, revision_digest: "B".repeat(64) }, false);
  output("receipt-unknown-key", { ...receipt, extra: true }, false);
  output("receipt-zero-version", { ...receipt, plan_version: 0 }, false);
  for (const state of ["open", "abandoned", "consumed", "invalid"]) {
    capture(`identity-${state}`, "output", "parsePlanDraftIdentity", parsePlanDraftIdentity, { ...identity, state }, state !== "invalid");
  }
  return cases;
}
