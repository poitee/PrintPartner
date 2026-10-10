import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { mock } from "node:test";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { parseApplyPlanDraftReceipt, parseSavePlanChoicesRequest, type SavePlanChoicesRequest } from "@print-partner/contracts";
import { getDb, SqliteDatabase } from "../../apps/server/src/db/client.js";
import { acceptedPlanBasis } from "../../apps/server/src/db/accepted-plan-progress.js";
import { AppRepository } from "../../apps/server/src/db/repository.js";
import { registerPlanDraftRoutes } from "../../apps/server/src/routes/plan-drafts.js";
import { registerPlanRoutes } from "../../apps/server/src/routes/plans.js";
import { acceptPlanForTest } from "../../apps/server/src/test/accept-plan.js";
import { parsePlanReview } from "../../apps/web/src/api/planReview.js";
import { canonical, digest, json, normalize, object, policy, type Json } from "./model.mjs";
import { schemaCases } from "./schemas.mjs";

const output = process.argv[2];
if (!output) throw new Error("Usage: node --conditions=development --import tsx scripts/desktop-parity/capture.mts OUTPUT.json");
mock.timers.enable({ apis: ["Date"], now: Date.parse(policy.clock) });
const root = mkdtempSync(join(tmpdir(), "pp-desktop-parity-"));
let database = new SqliteDatabase(root);
database.connect();
const raw = new Database(join(root, "print-partner.db"));
let tokenSequence = 0;
const options = {
  clock: () => new Date(policy.clock),
  tokenFactory: () => `ppu_${(++tokenSequence).toString(16).padStart(32, "0")}`,
};
let repo = new AppRepository(getDb(database), "default", database.reposDir, undefined, options);
let app = Fastify({ logger: false });
const tables = [
  "projects", "source_revisions", "build_profiles", "profile_layers", "parts", "print_progress",
  "plan_revisions", "plan_revision_parts", "plan_revision_input_sets", "plan_revision_inputs",
  "plan_accepted_input_sets", "required_units", "plan_revision_required_unit_sets", "plan_revision_required_units",
  "plan_drafts", "plan_draft_inputs", "plan_draft_parts", "plan_apply_requests",
  "plan_draft_required_unit_reconciliations", "plan_draft_required_unit_decisions", "plan_draft_required_unit_assignments",
  "accepted_plate_revisions", "accepted_plate_heads", "accepted_plates", "accepted_plate_units", "app_settings",
];
const states: { [key: string]: Json } = {};
const cases: Json[] = [];
const setup: Json[] = [];
const tableOrdering = Object.fromEntries(tables.map((table) => {
  const metadata = json(raw.prepare(`PRAGMA table_info(${table})`).all());
  assert(Array.isArray(metadata));
  const columns = metadata.map((value) => {
    const row = object(value);
    assert(typeof row.name === "string" && typeof row.pk === "number");
    assert(/^[a-z_][a-z0-9_]*$/.test(row.name));
    return { name: row.name, ordinal: row.pk };
  });
  const primary = columns.filter((column) => column.ordinal > 0).sort((a, b) => a.ordinal - b.ordinal).map((column) => column.name);
  return [table, { kind: primary.length > 0 ? "primary_key" : "complete_row", columns: primary.length > 0 ? primary : columns.map((column) => column.name) }];
}));
function files(directory: string): Json[] {
  if (!statSync(directory, { throwIfNoEntry: false })) return [];
  return readdirSync(directory).sort().flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? files(path) : [{ path: relative(root, path), sha256: digest(readFileSync(path)), bytes: statSync(path).size }];
  });
}
function state() {
  const value = json({
    database: Object.fromEntries(tables.map((table) => [table, raw.prepare(`SELECT * FROM ${table} ORDER BY ${tableOrdering[table].columns.map((name) => `"${name}"`).join(", ")}`).all()])),
    files: files(database.reposDir),
  });
  const id = digest(canonical(normalize(value, root)));
  states[id] = value;
  return { id, value };
}
function immutable(before: Json, after: Json) {
  const a = object(object(before).database);
  const b = object(object(after).database);
  for (const table of ["source_revisions", "plan_revisions", "plan_revision_parts", "plan_revision_inputs", "accepted_plate_revisions", "accepted_plates", "accepted_plate_units"]) {
    const previous = a[table];
    const current = b[table];
    assert(Array.isArray(previous) && Array.isArray(current));
    for (const row of previous) assert(current.some((candidate) => JSON.stringify(candidate) === JSON.stringify(row)), `Immutable row changed: ${table}`);
  }
  for (const table of ["accepted_plate_revisions", "accepted_plates", "accepted_plate_units"]) assert.deepEqual(b[table], a[table], `Plate history changed: ${table}`);
  assert.deepEqual(b.accepted_plate_heads, [], "Successful Plan publication must invalidate the current Plate head");
  assert.deepEqual(object(before).files, object(after).files);
}
function plateLinkage(snapshot: Json) {
  const db = object(object(snapshot).database);
  const rows = (table: string) => {
    const values = db[table];
    assert(Array.isArray(values));
    return values.map(object);
  };
  const revisions = rows("accepted_plate_revisions");
  assert(revisions.length > 0);
  for (const revision of revisions) {
    const plan = rows("plan_revisions").find((row) => row.id === revision.plan_revision_id);
    const mapping = rows("plan_revision_required_unit_sets").find((row) => row.revision_id === revision.plan_revision_id);
    assert(plan && mapping);
    assert.equal(revision.plan_revision_digest, plan.snapshot_digest);
    assert.equal(revision.plan_version, plan.revision_number);
    assert.equal(revision.required_unit_mapping_digest, mapping.mapping_digest);
    const plates = rows("accepted_plates").filter((row) => row.revision_id === revision.id);
    const units = rows("accepted_plate_units").filter((row) => row.revision_id === revision.id);
    assert.equal(plates.length, revision.expected_plate_count);
    assert.equal(units.length, revision.expected_unit_count);
    for (const unit of units) {
      assert(plates.some((row) => row.plate_id === unit.plate_id && row.tenant_id === unit.tenant_id));
      assert(rows("plan_revision_required_units").some((row) => row.revision_id === revision.plan_revision_id && row.required_unit_token === unit.required_unit_token && row.tenant_id === unit.tenant_id));
      assert(rows("required_units").some((row) => row.token === unit.required_unit_token && row.profile_id === revision.profile_id && row.tenant_id === unit.tenant_id));
    }
  }
  for (const head of rows("accepted_plate_heads")) {
    const revision = revisions.find((row) => row.id === head.current_revision_id && row.tenant_id === head.tenant_id && row.profile_id === head.profile_id);
    const profile = rows("build_profiles").find((row) => row.id === head.profile_id && row.tenant_id === head.tenant_id);
    assert(revision && profile);
    assert.equal(revision.plan_revision_id, profile.accepted_plan_revision_id);
  }
}
function receiptLinkage(body: Json) {
  const response = object(body);
  const receipt = parseApplyPlanDraftReceipt(response.receipt);
  const review = parsePlanReview(response.review, receipt.profile_id);
  assert(review.accepted_basis);
  assert(review.accepted_basis.plan_version >= receipt.plan_version);
  if (review.accepted_basis.plan_version === receipt.plan_version) {
    assert.equal(review.accepted_basis.plan_revision_id, receipt.revision_id);
    assert.equal(review.accepted_basis.plan_revision_digest, receipt.revision_digest);
    assert.equal(review.accepted_basis.required_unit_mapping_digest, receipt.required_unit_mapping_digest);
  }
  const revision = json(raw.prepare("SELECT * FROM plan_revisions WHERE id = ?").get(receipt.revision_id));
  assert.equal(object(revision).snapshot_digest, receipt.revision_digest);
  const mapping = json(raw.prepare("SELECT * FROM plan_revision_required_unit_sets WHERE revision_id = ?").get(receipt.revision_id));
  assert.equal(object(mapping).mapping_digest, receipt.required_unit_mapping_digest);
  const request = json(raw.prepare("SELECT * FROM plan_apply_requests WHERE revision_id = ?").get(receipt.revision_id));
  const receiptFields = object(json(receipt));
  for (const key of ["profile_id", "draft_id", "revision_id", "plan_version", "revision_digest", "required_unit_mapping_digest", "draft_lifecycle_version", "applied_at"]) {
    assert.equal(object(request)[key], receiptFields[key], `Durable receipt field: ${key}`);
  }
  const draft = repo.getPlanDraft(receipt.profile_id, receipt.draft_id);
  assert.equal(draft?.state, "consumed");
  assert.equal(draft?.consumedRevisionId, receipt.revision_id);
  return json({ receipt, review });
}
async function register() {
  const deps = { repo, reposDir: database.reposDir, thumbsDir: join(root, "thumbs"), dataDir: root };
  await registerPlanDraftRoutes(app, deps);
  await registerPlanRoutes(app, deps);
}
try {
  const source = repo.createSource({ name: "Parity source", url: "https://example.test/parity", source_kind: "github" });
  const observed = repo.getProjectRow(source.id);
  assert(observed);
  const locator = `${source.id}/revisions/a`;
  const sourceRoot = join(database.reposDir, locator);
  mkdirSync(sourceRoot, { recursive: true });
  for (const name of ["done", "optional"]) {
    const path = join(sourceRoot, `${name}.stl`);
    writeFileSync(path, `solid ${name}\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid ${name}\n`);
    utimesSync(path, new Date(policy.clock), new Date(policy.clock));
  }
  const sourceRevision = repo.recordSourceRevision({ sourceId: source.id, upstreamRevisionKey: "a", manifestDigest: "a".repeat(64), snapshotLocator: locator, syncedAt: policy.clock, completeness: "complete" });
  repo.activateSourceRevision({ sourceId: source.id, revisionId: sourceRevision.id, observed, sourceVersion: "a" });
  const profile = repo.createProfile("Parity Build", source.id);
  assert.equal(acceptPlanForTest(repo, profile.id).merged, true);
  const initial = repo.getAcceptedPlanRevision(profile.id);
  assert(initial);
  const done = initial.parts.find((part) => part.filename === "done.stl");
  const optional = initial.parts.find((part) => part.filename === "optional.stl");
  assert(done?.projectionPartId && optional);
  function seedPlates(name: string) {
    const accepted = repo.readAcceptedPlanOperationalSnapshot(profile.id);
    assert(accepted.kind === "ready");
    const units = accepted.snapshot.parts.filter((part) => part.included).flatMap((part) => part.units);
    assert.equal(units.length, 2);
    const command = {
      profileId: profile.id, expected: acceptedPlanBasis(accepted.snapshot), expectedPlateRevisionId: null,
      plates: [{ plateId: "plate-main", printerId: "fixture-printer", printerName: "Fixture printer", printerModel: "Fixture", bedWidthUm: 250_000, bedDepthUm: 220_000, bedHeightUm: 220_000, marginUm: 5_000,
        units: units.map((unit, index) => ({ token: unit.token, xUm: 5_000 + index * 60_000, yUm: 5_000, widthUm: 50_000, depthUm: 40_000, heightUm: 30_000 })),
      }],
    };
    const published = repo.publishAcceptedPlates(command);
    assert.equal(published.kind, "published");
    const snapshot = state();
    plateLinkage(snapshot.value);
    const heads = object(object(snapshot.value).database).accepted_plate_heads;
    assert(Array.isArray(heads) && heads.length === 1);
    setup.push({ name, operation: "AppRepository.publishAcceptedPlates", input: json(command), result: json(published), state: snapshot.id });
  }
  seedPlates("initial-accepted-plate");
  raw.prepare("UPDATE print_progress SET completed = 1, assembled = 1 WHERE part_id = ? AND unit_index = 0").run(done.projectionPartId);
  const originalTokens = json(raw.prepare("SELECT required_unit_token FROM plan_revision_required_units WHERE revision_id = ? ORDER BY required_unit_token").all(initial.id));
  const target = (part: typeof done) => ({ part_key: part.partKey, relative_path: part.relativePath, source_layer: part.sourceLayer });
  const original: SavePlanChoicesRequest = { expected_base: { revision_id: initial.id, plan_version: initial.planVersion }, expected_draft: null, remap_checkoff_links: true, decisions: [
    { kind: "set_included", target: target(optional), value: false },
    { kind: "set_quantity_override", target: target(done), value: 3 },
  ] };
  await register();
  const initialState = state();
  async function save(name: string, payload: unknown, key: string | null, status: number, effect: "publish" | "unchanged", transport: "inject" | "http" = "inject") {
    const before = state();
    const headers = key === null ? { "content-type": "application/json" } : { "content-type": "application/json", "idempotency-key": key };
    let body: Json;
    let actualStatus: number;
    if (transport === "http") {
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      const result = await fetch(`${address}/plans/${profile.id}/save`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(payload) });
      actualStatus = result.status;
      body = json(await result.json());
    } else {
      const result = await app.inject({ method: "POST", url: `/plans/${profile.id}/save`, headers, payload: JSON.stringify(payload) });
      actualStatus = result.statusCode;
      body = json(result.json());
    }
    assert.equal(actualStatus, status, `${name}: ${JSON.stringify(body)}`);
    const after = state();
    plateLinkage(after.value);
    const parsed = status === 200 ? receiptLinkage(body) : null;
    if (effect === "unchanged") assert.deepEqual(after.value, before.value, `${name}: unexpected durable write`);
    else {
      immutable(before.value, after.value);
      const previous = object(object(before.value).database).plan_revisions;
      const current = object(object(after.value).database).plan_revisions;
      assert(Array.isArray(previous) && Array.isArray(current));
      assert.equal(current.length, previous.length + 1, `${name}: publication count`);
    }
    cases.push({ name, operation: "POST /plans/:id/save", transport, profile_id: profile.id, input: json(payload), headers: json(headers), expected_status: status, response: body, parsed, before: before.id, after: after.id, invariants: effect === "unchanged" ? ["exact-database-and-file-no-write", "prior-plate-head-and-history-preserved", "historical-plate-plan-required-unit-linkage"] : ["one-publication", "prior-source-plan-plate-rows-immutable", "current-plate-head-invalidated", "historical-plate-plan-required-unit-linkage", "fixture-file-hashes-unchanged", "receipt-draft-revision-digest-linkage"] });
    return object(body);
  }
  const first = await save("bound-http-final-inclusion-and-quantity", original, "save-first", 200, "publish", "http");
  const firstReceipt = parseApplyPlanDraftReceipt(first.receipt);
  const firstAccepted = repo.getAcceptedPlanRevision(profile.id);
  assert.equal(firstAccepted?.parts.find((part) => part.filename === "done.stl")?.quantityEffective, 3);
  assert.equal(firstAccepted?.parts.find((part) => part.filename === "optional.stl")?.included, false);
  const priorTokens = originalTokens;
  assert(Array.isArray(priorTokens));
  const afterTokens = json(raw.prepare("SELECT required_unit_token FROM plan_revision_required_units WHERE revision_id = ? ORDER BY required_unit_token").all(firstReceipt.revision_id));
  assert(Array.isArray(afterTokens));
  assert(afterTokens.some((row) => JSON.stringify(row) === JSON.stringify(priorTokens[0])));
  const publishedDone = firstAccepted?.parts.find((part) => part.filename === "done.stl");
  assert(publishedDone?.projectionPartId);
  assert.deepEqual(json(raw.prepare("SELECT completed, assembled FROM print_progress WHERE part_id = ? AND unit_index = 0").get(publishedDone.projectionPartId)), { completed: 1, assembled: 1 });
  const reset: SavePlanChoicesRequest = { ...original, expected_base: { revision_id: firstReceipt.revision_id, plan_version: firstReceipt.plan_version }, decisions: [
    { kind: "set_included", target: target(optional), value: true },
    { kind: "set_quantity_override", target: target(done), value: null },
  ] };
  const second = await save("null-reset-next-publication", reset, "save-reset", 200, "publish");
  const secondReceipt = parseApplyPlanDraftReceipt(second.receipt);
  assert.equal(repo.getAcceptedPlanRevision(profile.id)?.parts.find((part) => part.filename === "done.stl")?.quantityOverride, null);
  assert.equal(repo.getAcceptedPlanRevision(profile.id)?.parts.find((part) => part.filename === "done.stl")?.quantityEffective, 1);
  seedPlates("current-accepted-plate-before-replay-conflict-rollback");
  const replay = await save("same-key-replay-after-state-advances", original, "save-first", 200, "unchanged");
  assert.deepEqual(replay.receipt, first.receipt);
  assert.equal(parsePlanReview(replay.review, profile.id).accepted_basis?.plan_version, secondReceipt.plan_version);
  assert.equal((await save("changed-payload-same-key", { ...original, remap_checkoff_links: false }, "save-first", 409, "unchanged")).code, "idempotency_conflict");
  assert.equal((await save("stale-accepted-base", original, "save-stale", 409, "unchanged")).code, "base_changed");
  await save("quantity-zero-route-rejection", { ...reset, decisions: [{ kind: "set_quantity_override", target: target(done), value: 0 }] }, "invalid-quantity", 400, "unchanged");
  await save("duplicate-field-route-rejection", { ...reset, decisions: [reset.decisions[0], reset.decisions[0]] }, "invalid-duplicate", 400, "unchanged");
  await save("missing-idempotency-header", reset, null, 400, "unchanged");
  await save("unknown-request-key", { ...reset, extra: true }, "invalid-extra", 400, "unchanged");
  const created = repo.recomputePlanDraft({ profileId: profile.id, actor: "parity:draft", idempotencyKey: "observed-draft", applyManifest: false });
  assert.equal(created.kind, "created");
  assert(created.kind === "created");
  const draftDone = created.draft.parts.find((part) => part.filename === "done.stl");
  assert(draftDone);
  const edited = repo.editPlanDraftParts({ profileId: profile.id, draftId: created.draft.id, expectedSnapshotDigest: created.draft.snapshotDigest, decision: { kind: "set_quantity_override", partIds: [draftDone.id], value: 4 } });
  assert(edited.kind === "updated");
  const reconciled = repo.savePlanDraftRequiredUnitReconciliation({ profileId: profile.id, draftId: edited.draft.id, expectedSnapshotDigest: edited.draft.snapshotDigest, actorId: "parity:draft", idempotencyKey: "observed-reconciliation", decisions: [] });
  assert(reconciled.kind === "saved");
  const observedDraft = reconciled.draft;
  const observedRequest: SavePlanChoicesRequest = { ...reset, expected_base: { revision_id: secondReceipt.revision_id, plan_version: secondReceipt.plan_version }, expected_draft: { draft_id: observedDraft.id, state: "open", lifecycle_version: observedDraft.lifecycleVersion, snapshot_digest: observedDraft.snapshotDigest, base: { revision_id: observedDraft.baseRevisionId, plan_version: observedDraft.basePlanVersion } }, decisions: [{ kind: "set_quantity_override", target: target(done), value: 2 }] };
  parseSavePlanChoicesRequest(observedRequest);
  assert(observedRequest.expected_draft);
  assert.equal((await save("stale-observed-draft", { ...observedRequest, expected_draft: { ...observedRequest.expected_draft, snapshot_digest: "f".repeat(64) } }, "stale-draft", 409, "unchanged")).code, "draft_changed");
  assert.equal((await save("open-draft-requires-observation", { ...observedRequest, expected_draft: null }, "unobserved-draft", 409, "unchanged")).code, "draft_changed");
  const apply = repo.applyPlanChanges.bind(repo);
  let reachedPublication = false;
  repo.applyPlanChanges = (command) => {
    const result = apply(command);
    assert.equal(result.kind, "applied");
    reachedPublication = true;
    throw new Error("Parity fixture injected failure after native publication");
  };
  try { await save("rollback-after-native-publication-preserves-open-draft", observedRequest, "rollback-save", 500, "unchanged"); }
  finally { repo.applyPlanChanges = apply; }
  assert(reachedPublication);
  assert.equal(repo.getPlanDraft(profile.id, observedDraft.id)?.state, "open");
  const rollbackHeads = object(object(state().value).database).accepted_plate_heads;
  assert(Array.isArray(rollbackHeads) && rollbackHeads.length === 1);
  const observedSave = await save("observed-draft-final-quantity", observedRequest, "observed-save", 200, "publish");
  assert.deepEqual(observedSave.closed_draft_ids, [observedDraft.id]);
  assert.equal(repo.getPlanDraft(profile.id, observedDraft.id)?.state, "abandoned");
  const finalReceipt = parseApplyPlanDraftReceipt(observedSave.receipt);
  assert.equal(repo.getAcceptedPlanRevision(profile.id)?.parts.find((part) => part.filename === "done.stl")?.quantityEffective, 2);
  const finalDone = repo.getAcceptedPlanRevision(profile.id)?.parts.find((part) => part.filename === "done.stl");
  assert(finalDone?.projectionPartId);
  repo.setSetting("printer.checkoff_links", JSON.stringify([{ id: "unsafe-link", profile_id: profile.id, filename: "done.bgcode", state: "awaiting_verify", units: [{ part_id: finalDone.projectionPartId, unit_index: 2 }] }]));
  const current: SavePlanChoicesRequest = { ...observedRequest, expected_base: { revision_id: finalReceipt.revision_id, plan_version: finalReceipt.plan_version }, expected_draft: null };
  const blocked = await save("actual-active-work-protection", { ...current, remap_checkoff_links: false }, "active-save", 423, "unchanged");
  assert.equal(blocked.code, "production_active");
  assert.equal(blocked.checkoff_link_count, 1);
  const unsafe = await save("unsafe-checkoff-remap-rolls-back", current, "unsafe-remap", 422, "unchanged");
  assert.equal(unsafe.code, "checkoff_remap_unsafe");
  const unknownTarget = await save("unknown-target-atomic-rejection", { ...current, decisions: [{ kind: "set_included", target: { part_key: "missing", relative_path: "missing.stl", source_layer: "missing" }, value: false }] }, "unknown-target", 422, "unchanged");
  assert.equal(unknownTarget.code, "part_not_found");
  await app.close();
  database.close();
  database = new SqliteDatabase(root);
  database.connect();
  repo = new AppRepository(getDb(database), "default", database.reposDir, undefined, options);
  app = Fastify({ logger: false });
  await register();
  const persistedBefore = state();
  const read = await app.inject({ method: "GET", url: `/plans/${profile.id}/review?include_excluded=true` });
  assert.equal(read.statusCode, 200);
  const persistedReview = parsePlanReview(read.json(), profile.id);
  assert.equal(persistedReview.accepted_basis?.plan_revision_id, finalReceipt.revision_id);
  assert.deepEqual(state().value, persistedBefore.value);
  plateLinkage(state().value);
  cases.push({ name: "persisted-review-after-connection-reopen", operation: "GET /plans/:id/review?include_excluded=true", transport: "inject", profile_id: profile.id, input: null, headers: {}, expected_status: 200, response: json(read.json()), parsed: json(persistedReview), before: persistedBefore.id, after: persistedBefore.id, invariants: ["persisted-accepted-basis", "exact-database-and-file-no-write", "historical-plate-plan-required-unit-linkage"] });
  const persistedReplay = await save("persisted-replay-after-connection-reopen", original, "save-first", 200, "unchanged");
  assert.deepEqual(persistedReplay.receipt, first.receipt);
  const finalState = state();
  const capture = json({ operation: "Plan autosave", table_ordering: tableOrdering, setup_operations: setup, schema_cases: schemaCases(), route_cases: cases, initial_state: initialState.id, final_state: finalState.id, states });
  const manifest = { format: policy.version, policy, raw: { data_directory: root, capture }, normalized: normalize(capture, root) };
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`PASS: ${schemaCases().length} parser cases, ${cases.length} route cases, ${Object.keys(states).length} database/file states; real bound HTTP and persisted replay\n`);
} finally {
  await app.close();
  raw.close();
  database.close();
  rmSync(root, { recursive: true, force: true });
  mock.timers.reset();
}
