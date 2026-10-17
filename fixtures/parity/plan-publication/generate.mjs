// Requires Node >= 22.18 and npm --prefix web ci --ignore-scripts.
// node fixtures/parity/plan-publication/generate.mjs [--check]
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const check = process.argv.includes("--check");
const service = "web/apps/server/src/services/plan-publication.ts";
const repository = "web/apps/server/src/db/repository.ts";
const operational = "web/apps/server/src/db/accepted-plan-operational.ts";
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith(".js") && context.parentURL?.startsWith(pathToFileURL(root).href)) {
      const url = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
      if (existsSync(url)) return { url: url.href, shortCircuit: true };
    }
    return next(specifier, { ...context, conditions: [...context.conditions, "development"] });
  },
  load(url, context, next) {
    if (url.startsWith(pathToFileURL(root).href) && url.endsWith(".ts")) {
      return { format: "module", source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { mode: "transform", sourceUrl: url }), shortCircuit: true };
    }
    return next(url, context);
  },
});
const publication = await import(pathToFileURL(join(root, service)).href);
const { assessCheckoffRemap } = await import(pathToFileURL(join(root, "web/apps/server/src/db/plan-apply-model.ts")).href);
const { requiredUnitObjectName } = await import(pathToFileURL(join(root, "web/apps/server/src/services/required-units.ts")).href);

// Execute the repository's actual inline acceptance check and private writer
// without importing its database drivers. Only the row/setting adapters are local.
function excerpt(path, start, end) {
  const source = readFileSync(join(root, path), "utf8");
  assert.equal(source.split(start).length, 2, `ambiguous start: ${start}`);
  const begin = source.indexOf(start);
  const finish = source.indexOf(end, begin);
  assert.ok(finish > begin, `missing end: ${end}`);
  return source.slice(begin, finish);
}
const match = excerpt(operational, "export function projectionPlanningFieldsMatch(", "export type AcceptedPlanPointerValidation");
const validate = excerpt(repository, "        const accepted = this.getAcceptedPlanRevision(profileId);", "      if (draftHeader.currentRequiredUnitReconciliationId == null)");
const write = excerpt(repository, "  private applyCheckoffRemap(", "  private strictProductionState(");
const strictProduction = excerpt(repository, "  private strictProductionState(", "  applyPlanChanges(");
const probeSource = `
import { applyJsonRecord, applySettingArray } from ${JSON.stringify(pathToFileURL(join(root, "web/apps/server/src/db/plan-apply-model.ts")).href)};
${match}
export class RepositoryProbe {
  constructor(accepted, projectionParts, settings) {
    this.accepted = accepted;
    this.settings = structuredClone(settings);
    const query = { select: () => query, from: () => query, where: () => query, all: () => projectionParts };
    this.db = query;
    this.schema = { parts: {} };
  }
  getAcceptedPlanRevision() { return this.accepted; }
  getSetting(key) { return this.settings[key] == null ? null : JSON.stringify(this.settings[key]); }
  setSetting(key, value) { this.settings[key] = JSON.parse(value); }
  validate(profileId, digestPlanRevisionParts, PLAN_REVISION_DIGEST_FORMAT) {
    const expectedBaseRevisionId = 1;
    const liveFilamentByProjectionId = new Map();
    const predecessorProjectionByRevisionPartId = new Map();
    const and = () => null, eq = () => null;
    if (true) {
${validate}
  }
${write}
${strictProduction}
}
`;
const probeUrl = `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(probeSource)).toString("base64")}`;
const { RepositoryProbe } = await import(probeUrl);
const token = (n) => `ppu_${n.toString(16).padStart(32, "0")}`;
const part = (overrides = {}) => ({
  id: 21, draftId: 1, baseRevisionPartId: null,
  partKey: "bracket", relativePath: "parts/bracket.stl", filename: "bracket.stl",
  sourceLayer: "base", status: "ready", roleInferred: "primary", roleOverride: null,
  filamentColorId: null, filamentCustomHex: null, spoolmanSpoolId: null,
  quantityInferred: 2, quantityOverride: null, quantityEffective: 2,
  included: true, notes: "", githubBlobUrl: null, geometrySame: null,
  requirement: null, optionGroupId: null, manifestSource: null, artifactDigest: null,
  ...overrides,
});
const create = (index = 0, id = 21) => ({ kind: "create", draftPartId: id, unitIndex: index });
const reuse = (index = 0, n = 1) => ({ kind: "reuse", draftPartId: 21, unitIndex: index, token: token(n) });
const base = [1, 2].map((n) => ({ token: token(n), objectName: requiredUnitObjectName("bracket.stl", token(n)), completed: true, assembled: n === 2 }));
function capture(run) {
  try { return { value: run() }; } catch (error) { return { error: error.message }; }
}
const prepareCases = [
  ["empty", [], [], []],
  ["create", [part()], [create(), create(1)], []],
  ["reuse", [part()], [reuse(), reuse(1, 2)], base],
  ["mixed", [part({ roleOverride: "accent" })], [reuse(), create(1)], base],
  ["unicode", [part({ partKey: "\ue000", requirement: "支架😀" }), part({ id: 22, partKey: "𐀀" })], [create(), create(1), create(0, 22), create(1, 22)], []],
  ["duplicate-part", [part(), part()], [], []],
  ["missing-part", [part()], [create(0, 99)], []],
  ["noncontiguous", [part()], [create(1)], []],
  ["duplicate-reuse", [part()], [reuse(), reuse(1)], base],
  ["unknown-reuse", [part()], [reuse(), create(1)], []],
  ["invalid-progress", [part()], [reuse(), create(1)], [{ ...base[0], completed: false, assembled: true }]],
  ["incomplete", [part()], [create()], []],
  ["invalid-quantity", [part({ quantityEffective: 0 })], [], []],
].map(([id, parts, assignments, baseUnits]) => {
  const input = { draft: { parts }, assignments, baseUnits };
  return { id, input, expected: capture(() => {
    const prepared = publication.preparePlanPublication(input);
    return { digest: prepared.revisionDigest, progress: prepared.progress.map((p) => [p.completed, p.assembled]), slots: prepared.mappings.map((a) => [a.draftPartId, a.unitIndex]) };
  }) };
});
const acceptedPart = { ...part(), id: 11, projectionPartId: 31, effectiveRole: "primary" };
const projected = {
  id: 31, matchKey: acceptedPart.partKey, quantityAuto: 2, role: "primary",
  ...Object.fromEntries(Object.entries(acceptedPart).filter(([key]) => !["id", "partKey", "quantityInferred", "roleInferred", "roleOverride", "artifactDigest", "draftId", "baseRevisionPartId", "projectionPartId", "effectiveRole"].includes(key))),
};
const accepted = { id: 1, digestFormat: publication.PLAN_REVISION_DIGEST_FORMAT, snapshotDigest: publication.digestPlanRevisionParts([acceptedPart]), parts: [acceptedPart] };
const projectionCases = [
  ["accepted", accepted, [projected]],
  ["live-filament", accepted, [{ ...projected, filamentColorId: "red", filamentCustomHex: "#ff0000", spoolmanSpoolId: "42" }]],
  ["missing-revision", null, [projected]],
  ["digest", { ...accepted, snapshotDigest: "0".repeat(64) }, [projected]],
  ["format", { ...accepted, digestFormat: "unknown" }, [projected]],
  ["count", accepted, []],
  ["missing-projection", accepted, [{ ...projected, id: 99 }]],
  ["filename", accepted, [{ ...projected, filename: "changed.stl" }]],
  ["manifest", accepted, [{ ...projected, requirement: "changed" }]],
].map(([id, revision, projections]) => ({ id, input: { revision, projections }, expected: capture(() => {
  new RepositoryProbe(revision, projections, {}).validate(1, publication.digestPlanRevisionParts, publication.PLAN_REVISION_DIGEST_FORMAT);
  return true;
}) }));
const unit = (index) => ({ part_id: 11, unit_index: index });
const remapCases = [
  ["links-queue-resolved", [{ id: "link", profile_id: 1, state: "watching", filename: "bracket.stl", units: [unit(0), unit(1)], resolved_units: [{ ...unit(0), result: "printed" }] }], [{ id: "queue", profile_id: null, state: "error", checkoff_units: [unit(1)] }]],
  ["other-profile", [{ id: "other", profile_id: 2, state: "applied", units: [{ part_id: 99, unit_index: 0 }] }], [{ profile_id: 2, state: "done", checkoff_units: [{ part_id: 99, unit_index: 0 }] }]],
  ["empty", [], []],
  ["ownerless-queue-deleted-part", [], [{ id: "q", profile_id: null, state: "done", checkoff_units: [{ part_id: 500, unit_index: 0 }] }]],
].map(([id, links, queue]) => {
  const input = { links, queue };
  const plan = assessCheckoffRemap({ profileId: 1, checkoffLinksRaw: JSON.stringify(links), sendQueueRaw: JSON.stringify(queue), oldPartMatchKeyById: new Map([[11, "bracket"]]), partProfileIdById: new Map([[11, 1], [99, 2]]), newPartByMatchKey: new Map([["bracket", { draftPartId: 21, quantityEffective: 2 }]]), oldTokenByCoordinate: new Map([["11:0", token(1)], ["11:1", token(2)]]), newCoordinateByToken: new Map([[token(1), { draftPartId: 21, unitIndex: 0 }], [token(2), { draftPartId: 21, unitIndex: 1 }]]) });
  if (plan.kind === "unsafe") return { id, input, expected: plan };
  assert.equal(plan.kind, "safe");
  const settings = { "printer.checkoff_links": links, "printer.send_queue": queue };
  const probe = new RepositoryProbe(null, [], settings);
  probe.applyCheckoffRemap(plan, new Map([...plan.remapByCoordinate].map(([key, target]) => [key, { part_id: 31, unit_index: target.unitIndex }])));
  return { id, input, expected: { mapping: [...plan.remapByCoordinate].map(([key, target]) => [key.split(":").map(Number), [target.draftPartId, target.unitIndex]]), settings: probe.settings } };
});
const productionCases = [
  ["checkoff-other-profile-coordinate", [{ id: 99, profileId: 2 }], [{ profile_id: 1, state: "watching", units: [{ part_id: 99, unit_index: 0 }] }], []],
].map(([id, parts, links, queue]) => ({ id, input: { parts, links, queue }, expected: capture(() => {
  const probe = new RepositoryProbe(null, parts, { "printer.checkoff_links": links, "printer.send_queue": queue });
  return probe.strictProductionState(1);
}) }));
const objects = ["dir/支架😀.STL", ".stl", "a".repeat(250) + ".stl"].map((filename) => ({ filename, token: token(1), expected: requiredUnitObjectName(filename, token(1)) }));
const { transactions } = await import("./transactions.mjs");
const transactionCases = await transactions(root);
const output = {
  _generated: `@generated by fixtures/parity/plan-publication/generate.mjs from Node ${process.version}`,
  sources: [service, repository, operational, "web/apps/server/src/db/plan-apply-model.ts", "web/apps/server/src/routes/plan-drafts.ts", "web/apps/server/src/services/plan-draft-workspace.ts", "web/apps/server/src/middleware/tenant-context.ts"],
  transactionSchema: transactionCases.definitions, transactionAt: transactionCases.at, clients: transactionCases.clients, transactions: transactionCases.cases,
  prepare: prepareCases, projection: projectionCases, remap: remapCases, production: productionCases, objects,
};
// One case per line keeps later publication/receipt cases in the same file readable.
const text = "{\n" + Object.entries(output).map(([key, value]) => `  ${JSON.stringify(key)}: ${Array.isArray(value) && key !== "transactionSchema" ? "[\n" + value.map((row) => "    " + JSON.stringify(row)).join(",\n") + "\n  ]" : JSON.stringify(value)}`).join(",\n") + "\n}\n";
const path = join(here, "node.json");
if (check) assert.equal(readFileSync(path, "utf8"), text, "Node publication fixtures are stale");
else writeFileSync(path, text);
console.log(JSON.stringify({ prepare: prepareCases.length, projection: projectionCases.length, remap: remapCases.length, production: productionCases.length, objects: objects.length, transactions: transactionCases.cases.length, clients: transactionCases.clients.length, check }));
