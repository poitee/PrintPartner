import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acceptPlanForTest } from "../test/accept-plan.js";
import { getDb, SqliteDatabase } from "./client.js";
import { AppRepository, type SavePlanChoicesCommand } from "./repository.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pp-plan-save-"));
  const database = new SqliteDatabase(root);
  database.connect();
  const raw = new Database(join(root, "print-partner.db"));
  cleanups.push(() => { raw.close(); database.close(); rmSync(root, { recursive: true, force: true }); });
  const repo = new AppRepository(getDb(database), "default", database.reposDir);
  const source = repo.createSource({ name: "Save source", url: "https://example.test/save", source_kind: "github" });
  const observed = repo.getProjectRow(source.id);
  if (!observed) throw new Error("Fixture source missing");
  const locator = `${source.id}/revisions/a`;
  const sourceRoot = join(database.reposDir, locator);
  mkdirSync(sourceRoot, { recursive: true });
  writeFileSync(join(sourceRoot, "done.stl"), "solid done");
  writeFileSync(join(sourceRoot, "optional.stl"), "solid optional");
  const revision = repo.recordSourceRevision({
    sourceId: source.id, upstreamRevisionKey: "a", manifestDigest: "a".repeat(64),
    snapshotLocator: locator, syncedAt: "2026-09-06T00:00:00.000Z", completeness: "complete",
  });
  repo.activateSourceRevision({ sourceId: source.id, revisionId: revision.id, observed, sourceVersion: "a" });
  const profile = repo.createProfile("Save Build", source.id);
  expect(acceptPlanForTest(repo, profile.id).merged).toBe(true);
  const accepted = repo.getAcceptedPlanRevision(profile.id);
  const optional = accepted?.parts.find((part) => part.filename === "optional.stl");
  const done = accepted?.parts.find((part) => part.filename === "done.stl");
  if (!accepted || !optional || !done?.projectionPartId) throw new Error("Fixture accepted parts missing");
  const command: SavePlanChoicesCommand = {
    profileId: profile.id, actorId: "test:save", idempotencyKey: "save-1",
    expectedBase: { kind: "revision", revisionId: accepted.id, planVersion: accepted.planVersion },
    expectedDraft: null, remapCheckoffLinks: true,
    changes: [{ kind: "set_included", value: false, target: {
      partKey: optional.partKey, relativePath: optional.relativePath, sourceLayer: optional.sourceLayer,
    } }],
  };
  const state = () => new Map([
    "build_profiles", "parts", "print_progress", "plan_revisions", "plan_revision_parts",
    "plan_revision_input_sets", "plan_revision_inputs", "plan_accepted_input_sets",
    "required_units", "plan_revision_required_unit_sets", "plan_revision_required_units",
    "plan_drafts", "plan_draft_inputs", "plan_draft_parts", "plan_apply_requests",
    "plan_draft_required_unit_reconciliations", "plan_draft_required_unit_decisions",
    "plan_draft_required_unit_assignments", "app_settings",
  ].map((table) => [table, raw.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]));
  return { root, database, raw, repo, profile, source, accepted, optional, done, command, state };
}

function editedDraft(context: ReturnType<typeof fixture>, explicitDecisions = false) {
  if (explicitDecisions) {
    const observed = context.repo.getProjectRow(context.source.id);
    if (!observed) throw new Error("Fixture source missing");
    const locator = `${context.source.id}/revisions/b`;
    const sourceRoot = join(context.database.reposDir, locator);
    mkdirSync(sourceRoot, { recursive: true });
    writeFileSync(join(sourceRoot, "done.stl"), "solid changed done");
    writeFileSync(join(sourceRoot, "optional.stl"), "solid changed optional");
    const revision = context.repo.recordSourceRevision({
      sourceId: context.source.id, upstreamRevisionKey: "b", manifestDigest: "b".repeat(64),
      snapshotLocator: locator, syncedAt: "2026-09-06T00:01:00.000Z", completeness: "complete",
    });
    context.repo.activateSourceRevision({ sourceId: context.source.id, revisionId: revision.id, observed, sourceVersion: "b" });
  }
  const created = context.repo.recomputePlanDraft({
    profileId: context.profile.id, actor: "test:draft", idempotencyKey: "user-draft", applyManifest: false,
  });
  if (created.kind !== "created") throw new Error("Fixture draft missing");
  const done = created.draft.parts.find((part) => part.filename === "done.stl");
  if (!done) throw new Error("Fixture draft part missing");
  const edited = context.repo.editPlanDraftParts({
    profileId: context.profile.id, draftId: created.draft.id,
    expectedSnapshotDigest: created.draft.snapshotDigest,
    decision: { kind: "set_quantity_override", partIds: [done.id], value: 4 },
  });
  if (edited.kind !== "updated") throw new Error("Fixture draft edit failed");
  const reconciled = context.repo.savePlanDraftRequiredUnitReconciliation({
    profileId: context.profile.id, draftId: edited.draft.id,
    expectedSnapshotDigest: edited.draft.snapshotDigest, actorId: "test:draft", idempotencyKey: "user-reconciliation",
    decisions: explicitDecisions ? edited.draft.parts.map((part) => {
      if (part.baseRevisionPartId == null) throw new Error("Fixture predecessor missing");
      return { kind: "accept_prior_completion", targetDraftPartId: part.id, predecessorRevisionPartId: part.baseRevisionPartId };
    }) : [],
  });
  if (reconciled.kind !== "saved") throw new Error("Fixture reconciliation failed");
  return reconciled.draft;
}

describe("savePlanChoices", () => {
  it("publishes a choice and quantity in one native apply and one final reconciliation", () => {
    const context = fixture();
    const apply = vi.spyOn(context.repo, "applyPlanChanges");
    const reconcile = vi.spyOn(context.repo, "savePlanDraftRequiredUnitReconciliation");
    const edit = vi.spyOn(context.repo, "editPlanDraftPartsBatch");
    const result = context.repo.savePlanChoices({ ...context.command, changes: [
      ...context.command.changes,
      { kind: "set_quantity_override", value: 3, target: {
        partKey: context.done.partKey, relativePath: context.done.relativePath, sourceLayer: context.done.sourceLayer,
      } },
    ] });
    expect(result).toMatchObject({ kind: "saved", receipt: { planVersion: 2 }, closedDraftIds: [] });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(edit).not.toHaveBeenCalled();
    const parts = context.repo.getAcceptedPlanRevision(context.profile.id)?.parts;
    expect(parts?.find((part) => part.filename === "optional.stl")?.included).toBe(false);
    expect(parts?.find((part) => part.filename === "done.stl")?.quantityEffective).toBe(3);
  });

  it("replays a committed receipt before stale-base checks and after later saves", () => {
    const { repo, profile, command, state } = fixture();
    const first = repo.savePlanChoices(command);
    if (first.kind !== "saved") throw new Error(`First save failed: ${first.kind}`);
    const afterFirst = state();
    expect(repo.savePlanChoices(command)).toEqual(first);
    expect(state()).toEqual(afterFirst);
    expect(repo.savePlanChoices({ ...command, idempotencyKey: "save-2",
      expectedBase: { kind: "revision", revisionId: first.receipt.revisionId, planVersion: first.receipt.planVersion },
    }).kind).toBe("saved");
    const afterSecond = state();
    expect(repo.savePlanChoices(command)).toEqual(first);
    expect(state()).toEqual(afterSecond);
    expect(repo.getAcceptedPlanRevision(profile.id)?.planVersion).toBe(3);
  });

  it("rejects the same key with a changed payload even when effective choices are identical", () => {
    const { repo, command, state } = fixture();
    expect(repo.savePlanChoices(command).kind).toBe("saved");
    const before = state();
    expect(repo.savePlanChoices({ ...command, remapCheckoffLinks: false })).toEqual({ kind: "idempotency_conflict" });
    expect(state()).toEqual(before);
  });

  it("rejects a new stale-base command without writes", () => {
    const { repo, command, state } = fixture();
    expect(repo.savePlanChoices(command).kind).toBe("saved");
    const before = state();
    expect(repo.savePlanChoices({ ...command, idempotencyKey: "stale-save" })).toEqual({ kind: "base_changed" });
    expect(state()).toEqual(before);
  });

  it("clones the expected user draft and remaps its explicit reconciliation decisions", () => {
    const context = fixture();
    const draft = editedDraft(context, true);
    const command = { ...context.command, expectedDraft: draft };
    const result = context.repo.savePlanChoices(command);
    expect(result).toMatchObject({ kind: "saved", closedDraftIds: [draft.id] });
    if (result.kind !== "saved") throw new Error(`Save failed: ${result.kind}`);
    expect(context.repo.getAcceptedPlanRevision(context.profile.id)?.parts.find((part) => part.filename === "done.stl")?.quantityEffective).toBe(4);
    const historical = context.repo.getPlanDraft(context.profile.id, draft.id);
    expect(historical).toMatchObject({ state: "abandoned", snapshotDigest: draft.snapshotDigest, parts: draft.parts });
    const published = context.repo.getPlanDraft(context.profile.id, result.receipt.draftId);
    if (!published?.requiredUnitReconciliation) throw new Error("Saved reconciliation missing");
    const selected = context.repo.getPlanDraftRequiredUnitReconciliation(context.profile.id, published.id, published.requiredUnitReconciliation.id);
    expect(selected?.decisions).toHaveLength(draft.parts.length);
    expect(selected?.decisions.every((decision) => published.parts.some((part) => part.id === decision.targetDraftPartId))).toBe(true);
    expect(context.repo.savePlanChoices(command)).toEqual(result);
  });

  it("preserves an unknown or changed user draft", () => {
    const context = fixture();
    const draft = editedDraft(context);
    const before = context.state();
    expect(context.repo.savePlanChoices(context.command)).toEqual({ kind: "draft_changed" });
    expect(context.repo.savePlanChoices({ ...context.command, expectedDraft: { ...draft, snapshotDigest: "f".repeat(64) } })).toEqual({ kind: "draft_changed" });
    expect(context.state()).toEqual(before);
  });

  it("rolls back a typed native failure after draft creation and reconciliation", () => {
    const context = fixture();
    const draft = editedDraft(context);
    const before = context.state();
    vi.spyOn(context.repo, "applyPlanChanges").mockReturnValue({ kind: "production_active", checkoffLinkCount: 1, sendQueueItemCount: 0 });
    expect(context.repo.savePlanChoices({ ...context.command, expectedDraft: draft })).toEqual({ kind: "production_active", checkoffLinkCount: 1, sendQueueItemCount: 0 });
    expect(context.state()).toEqual(before);
  });

  it("rolls back nested native publication if later work throws", () => {
    const context = fixture();
    const draft = editedDraft(context);
    const before = context.state();
    const nativeApply = context.repo.applyPlanChanges.bind(context.repo);
    vi.spyOn(context.repo, "applyPlanChanges").mockImplementation((command) => {
      expect(nativeApply(command).kind).toBe("applied");
      throw new Error("Injected outer save failure");
    });
    expect(() => context.repo.savePlanChoices({ ...context.command, expectedDraft: draft })).toThrow("Injected outer save failure");
    expect(context.state()).toEqual(before);
  });

  it("rolls back publication when the original draft cannot be closed", () => {
    const context = fixture();
    const draft = editedDraft(context);
    const before = context.state();
    vi.spyOn(context.repo, "transitionPlanDraft").mockReturnValue({ kind: "conflict", draft });
    expect(context.repo.savePlanChoices({ ...context.command, expectedDraft: draft })).toEqual({ kind: "draft_changed" });
    expect(context.state()).toEqual(before);
  });

  it("preserves completed and assembled units while selecting another part", () => {
    const context = fixture();
    context.raw.prepare(`INSERT INTO print_progress (tenant_id, part_id, unit_index, completed, assembled)
      VALUES ('default', ?, 0, 1, 1) ON CONFLICT DO UPDATE SET completed = 1, assembled = 1`).run(context.done.projectionPartId);
    const before = context.repo.readCurrentRequiredUnitSet(context.profile.id);
    expect(context.repo.savePlanChoices(context.command).kind).toBe("saved");
    const after = context.repo.readCurrentRequiredUnitSet(context.profile.id);
    if (before.kind !== "ready" || after.kind !== "ready") throw new Error("Required units missing");
    expect(after.units.filter((unit) => unit.completed)).toEqual(before.units.filter((unit) => unit.completed).map((unit) => expect.objectContaining({
      token: unit.token, completed: true, assembled: true,
    })));
  });

  it("rejects changed attachments without losing the expected draft", () => {
    const context = fixture();
    const draft = editedDraft(context);
    const added = context.repo.createSource({ name: "New attachment", url: "https://example.test/extra" });
    context.repo.addAddonLayer(context.profile.id, added.id);
    const before = context.state();
    expect(context.repo.savePlanChoices({ ...context.command, expectedDraft: draft })).toEqual({ kind: "inputs_changed" });
    expect(context.state()).toEqual(before);
  });

  it("scopes replay to the tenant and actor", () => {
    const context = fixture();
    expect(context.repo.savePlanChoices(context.command).kind).toBe("saved");
    const before = context.state();
    const other = new AppRepository(getDb(context.database), "other", context.database.reposDir);
    expect(other.savePlanChoices(context.command)).toEqual({ kind: "not_found" });
    expect(context.repo.savePlanChoices({ ...context.command, actorId: "other:user" })).toEqual({ kind: "base_changed" });
    expect(context.state()).toEqual(before);
  });

  it("uses the committed receipt across database connections and rejects a competing stale save", () => {
    const context = fixture();
    const database = new SqliteDatabase(context.root);
    database.connect();
    cleanups.push(() => database.close());
    const other = new AppRepository(getDb(database), "default", database.reposDir);
    const first = context.repo.savePlanChoices(context.command);
    expect(first.kind).toBe("saved");
    const before = context.state();
    expect(other.savePlanChoices(context.command)).toEqual(first);
    expect(other.savePlanChoices({ ...context.command, idempotencyKey: "competing-save" })).toEqual({ kind: "base_changed" });
    expect(context.state()).toEqual(before);
  });

  it("uses native active-work policy and rolls back an unsafe Checkoff remap", () => {
    const context = fixture();
    context.repo.setSetting("printer.checkoff_links", JSON.stringify([{
      id: "unsafe-link", profile_id: context.profile.id, filename: "done.bgcode", state: "awaiting_verify",
      units: [{ part_id: context.done.projectionPartId, unit_index: 2 }],
    }]));
    const before = context.state();
    expect(context.repo.savePlanChoices({ ...context.command, remapCheckoffLinks: false })).toMatchObject({ kind: "production_active", checkoffLinkCount: 1 });
    expect(context.state()).toEqual(before);
    expect(context.repo.savePlanChoices(context.command)).toMatchObject({ kind: "checkoff_remap_unsafe" });
    expect(context.state()).toEqual(before);
  });

  it("rejects an unknown target atomically", () => {
    const context = fixture();
    const before = context.state();
    expect(context.repo.savePlanChoices({ ...context.command, changes: [{
      kind: "set_included", value: false, target: { partKey: "missing", relativePath: "missing.stl", sourceLayer: "missing" },
    }] })).toEqual({ kind: "part_not_found" });
    expect(context.state()).toEqual(before);
  });
});
