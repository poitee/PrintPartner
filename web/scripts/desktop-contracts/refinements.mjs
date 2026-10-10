import assert from "node:assert/strict";
const boundaryAdapter = Symbol.for("print-partner.wire-boundary-adapter");

// Zod's JSON Schema exporter silently omits custom refinements. Audit every
// custom check: an unannotated check needs a reviewed boundary adapter.
export function refinementAdapters(schema) {
  const names = new Set();
  const seen = new WeakSet();
  function visit(value) {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const def = value._zod?.def;
    if (def?.type === "lazy") visit(def.getter());
    if (def?.check === "custom") {
      assert(value[boundaryAdapter], "Unsupported refinement: use a documented boundary adapter before generation");
      names.add(value[boundaryAdapter]);
    }
    for (const child of Object.values(def ?? value)) {
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  }
  visit(schema);
  return [...names].sort();
}

export function auditRefinements(schema, adapters) {
  for (const name of refinementAdapters(schema)) {
    assert(adapters[name], `Unsupported refinement adapter ${name}`);
  }
}
