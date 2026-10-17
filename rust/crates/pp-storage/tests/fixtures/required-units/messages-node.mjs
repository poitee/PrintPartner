import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const root = new URL("../../../../../../", import.meta.url);
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith(".js") && context.parentURL?.startsWith(root.href)) {
      const url = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
      if (existsSync(url)) return { url: url.href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});
const { parseRequiredUnitReconciliationResult, parseRequiredUnitSelectionBasis } = await import(
  new URL("web/apps/server/src/services/required-unit-reconciliation.ts", root).href
);
const token = (n) => `ppu_${n.toString(16).padStart(32, "0")}`;
const create = (unitIndex = 0) => ({ kind: "create", draftPartId: 1, unitIndex });
const reuse = (unitIndex = 0) => ({ kind: "reuse", draftPartId: 1, unitIndex, token: token(1) });
const ready = (assignments = [create()], surplus = []) => ({ kind: "ready", assignments, surplus });
const basis = (priorIndex = 0) => ({
  revisionPartId: 1, token: token(priorIndex + 1), priorIndex,
  createdAt: "2026-10-15T00:00:00.000Z", completed: false, assembled: false,
});
const conflict = (targetDraftPartId = 1) => ({
  kind: "unsafe_predecessor", targetDraftPartId, predecessorRevisionPartId: 1,
});
const unresolved = (conflicts = [conflict()]) => ({ kind: "unresolved", conflicts });
const cases = [];
function add(column, name, value, literal = false) {
  const input = literal ? value : JSON.stringify(value);
  let message;
  try {
    if (column === "result_json") {
      parseRequiredUnitReconciliationResult({ resultJson: input, selectionBasis: [] });
    } else {
      parseRequiredUnitSelectionBasis(input);
    }
  } catch (error) {
    message = error.message;
  }
  assert.equal(typeof message, "string", `${name} must fail in Node`);
  cases.push({ column, name, input, message });
}
const result = (name, value, literal = false) => add("result_json", name, value, literal);
const selection = (name, value, literal = false) => add("selection_basis_json", name, value, literal);

result("empty-object", {});
result("extra-assignment-field", ready([{ ...create(), extra: true }]));
result("assignment-index-limit", ready([create(10000)]));
result("reversed-assignments", ready([create(1), create()]));
for (const [name, value] of [["syntax", "{"], ["null", "null"], ["array", "[]"]]) {
  result(name, value, true);
  if (name !== "array") selection(name, value, true);
}
for (const value of ["unknown", null, 1]) result(`kind-${value}`, { kind: value });
result("extra-result-field", { ...ready(), extra: true });
result("missing-assignments", { kind: "ready", surplus: [] });
result("assignments-not-array", { ...ready(), assignments: {} });
result("surplus-not-array", { ...ready(), surplus: null });
result("assignment-not-object", ready([null]));
result("assignment-kind", ready([{ ...create(), kind: "unknown" }]));
result("missing-assignment-index", ready([{ kind: "create", draftPartId: 1 }]));
result("reuse-extra-field-before-token", ready([{ ...reuse(), extra: true, token: 1 }]));
result("reuse-token-type-before-id", ready([{ ...reuse(), token: 1, draftPartId: 0 }]));
for (const value of [0, -1, 1.5, "1", null, 9007199254740992]) {
  result(`assignment-id-${value}`, ready([{ ...create(), draftPartId: value }]));
  selection(`basis-id-${value}`, [{ ...basis(), revisionPartId: value }]);
}
for (const value of [-1, 1.5, "0", null, 65536]) {
  result(`assignment-index-${value}`, ready([create(value)]));
  selection(`basis-index-${value}`, [{ ...basis(), priorIndex: value }]);
}
result("duplicate-assignment-slot", ready([create(), create()]));
result("duplicate-reuse-token", ready([reuse(), reuse(1)]));
result("invalid-reuse-token", ready([{ ...reuse(), token: "bad" }]));
result("later-assignment-id-before-earlier-token", ready([{ ...reuse(), token: "bad" }, { ...create(1), draftPartId: 0 }]));
result("later-assignment-shape-before-duplicate", ready([create(), create(), null]));
result("surplus-type-before-assignment-duplicate", ready([create(), create()], [1]));
result("surplus-token-type", ready([], [1]));
result("surplus-token-invalid", ready([], ["bad"]));
result("duplicate-surplus", ready([], [token(1), token(1)]));
result("reused-surplus", ready([reuse()], [token(1)]));
result("reversed-surplus", ready([], [token(2), token(1)]));
result("result-whitespace", ` ${JSON.stringify(ready())}`, true);
result("result-key-order", { assignments: [create()], kind: "ready", surplus: [] });
result("assignment-key-order", ready([{ draftPartId: 1, kind: "create", unitIndex: 0 }]));
result("integer-spelling", JSON.stringify(ready()).replace('"unitIndex":0', '"unitIndex":0.0'), true);
result("unresolved-extra-field", { ...unresolved(), extra: true });
result("conflicts-not-array", { kind: "unresolved", conflicts: null });
result("conflict-not-object", unresolved([null]));
result("conflict-kind", unresolved([{ ...conflict(), kind: "unknown" }]));
result("conflict-extra-field", unresolved([{ ...conflict(), extra: true }]));
result("conflict-target", unresolved([{ ...conflict(), targetDraftPartId: 0 }]));
result("conflict-predecessor", unresolved([{ ...conflict(), predecessorRevisionPartId: 0 }]));
result("duplicate-conflict-target", unresolved([conflict(), conflict()]));
result("reversed-conflicts", unresolved([conflict(2), conflict()]));
const ambiguous = { kind: "ambiguous_exact_match", targetDraftPartId: 1, candidateRevisionPartIds: [1, 2] };
result("ambiguous-extra-field", unresolved([{ ...ambiguous, extra: true }]));
result("candidates-shape-before-target", unresolved([{ ...ambiguous, targetDraftPartId: 0, candidateRevisionPartIds: null }]));
result("candidate-id", unresolved([{ ...ambiguous, candidateRevisionPartIds: [0] }]));
result("empty-candidates", unresolved([{ ...ambiguous, candidateRevisionPartIds: [] }]));
result("duplicate-candidates", unresolved([{ ...ambiguous, candidateRevisionPartIds: [1, 1] }]));
result("reversed-candidates", unresolved([{ ...ambiguous, candidateRevisionPartIds: [2, 1] }]));
result("later-conflict-id-before-duplicate", unresolved([conflict(), conflict(), conflict(0)]));
result("claimed-predecessor", unresolved([{ ...conflict(), kind: "predecessor_claimed", predecessorRevisionPartId: null }]));
selection("not-array", {});
selection("row-not-object", [null]);
selection("extra-row-field", [{ ...basis(), extra: true }]);
selection("missing-row-field", [{ revisionPartId: 1 }]);
selection("invalid-token", [{ ...basis(), token: "bad" }]);
selection("token-type", [{ ...basis(), token: 1 }]);
selection("empty-creation-time", [{ ...basis(), createdAt: "" }]);
selection("creation-time-type", [{ ...basis(), createdAt: 1 }]);
selection("progress-type", [{ ...basis(), completed: 0 }]);
selection("assembled-type", [{ ...basis(), assembled: null }]);
selection("progress-corrupt", [{ ...basis(), assembled: true }]);
selection("duplicate-slot", [basis(), { ...basis(), token: token(2) }]);
selection("duplicate-token", [basis(), { ...basis(1), token: token(1) }]);
selection("reversed-rows", [basis(1), basis()]);
selection("later-id-before-earlier-token", [{ ...basis(), token: "bad" }, { ...basis(1), revisionPartId: 0 }]);
selection("index-before-token", [{ ...basis(), token: "bad", priorIndex: 10000 }]);
selection("token-before-creation-time", [{ ...basis(), token: "bad", createdAt: "" }]);
selection("creation-time-before-progress", [{ ...basis(), createdAt: "", completed: 0 }]);
selection("duplicate-before-later-progress", [basis(), basis(), { ...basis(1), completed: 0 }]);
selection("progress-before-duplicate", [basis(), { ...basis(), completed: 0 }]);
selection("whitespace", ` ${JSON.stringify([basis()])}`, true);
selection("key-order", [{ token: token(1), revisionPartId: 1, priorIndex: 0, createdAt: "now", completed: false, assembled: false }]);
selection("index-limit", [{ ...basis(), priorIndex: 10000 }]);
const output = cases.map((item) => JSON.stringify(item)).join("\n") + "\n";
const fixture = new URL("messages-node.jsonl", import.meta.url);
if (process.argv.includes("--check")) assert.equal(readFileSync(fixture, "utf8"), output);
else writeFileSync(fixture, output);
console.log(`${cases.length} Node required-unit message cases ${process.argv.includes("--check") ? "verified" : "written"}: ${fileURLToPath(fixture)}`);
