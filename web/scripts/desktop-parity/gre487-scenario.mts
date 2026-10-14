import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { mock } from "node:test";
import Database from "better-sqlite3";
import Fastify from "fastify";
import {
  parseApplyPlanDraftReceipt,
  parseEditPlanDraftPartsRequest,
  parsePlanDraftWorkspace,
  parseSavePlanChoicesRequest,
  type PlanDraftWorkspace,
} from "@print-partner/contracts";
import { getDb, SqliteDatabase } from "../../apps/server/src/db/client.js";
import { AppRepository } from "../../apps/server/src/db/repository.js";
import { registerPlanDraftRoutes } from "../../apps/server/src/routes/plan-drafts.js";
import { registerPlanRoutes } from "../../apps/server/src/routes/plans.js";
import { parsePlanReview, type PlanReview } from "../../apps/web/src/api/planReview.js";
import { digest, json, normalize, object, policy, type Json } from "./model.mjs";

export async function replayGre487(): Promise<Json> {
  const root = mkdtempSync(join(tmpdir(), "pp-gre487-"));
  mock.timers.enable({ apis: ["Date"], now: Date.parse(policy.clock) });
  let tokenSequence = 0;
  const options = {
    clock: () => new Date(policy.clock),
    tokenFactory: () => `ppu_${(++tokenSequence).toString(16).padStart(32, "0")}`,
  };
  let database = new SqliteDatabase(root);
  let raw: Database.Database | undefined;
  let app = Fastify({ logger: false });
  const evidence: Json[] = [];

  async function open() {
    database.connect();
    raw = new Database(database.dbPath, { readonly: true });
    const repo = new AppRepository(getDb(database), "default", database.reposDir, undefined, options);
    const deps = { repo, reposDir: database.reposDir, thumbsDir: join(root, "thumbs"), dataDir: root };
    await registerPlanDraftRoutes(app, deps);
    await registerPlanRoutes(app, deps);
    return repo;
  }

  async function close() {
    await app.close();
    raw?.close();
    raw = undefined;
    database.close();
  }

  async function reopen() {
    await close();
    database = new SqliteDatabase(root);
    app = Fastify({ logger: false });
    return open();
  }

  function fixtureFiles(directory: string): Json[] {
    return readdirSync(directory).sort().flatMap((name) => {
      const path = join(directory, name);
      return statSync(path).isDirectory() ? fixtureFiles(path) : [{
        path: relative(root, path), bytes: statSync(path).size, sha256: digest(readFileSync(path)),
      }];
    });
  }

  function snapshot(): Json {
    const reader = raw;
    assert(reader);
    const tables = json(reader.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all());
    assert(Array.isArray(tables));
    const rows = tables.map((entry) => {
      const name = object(entry).name;
      assert(typeof name === "string" && /^[a-z_][a-z0-9_]*$/.test(name));
      const metadata = json(reader.prepare(`PRAGMA table_info("${name}")`).all());
      assert(Array.isArray(metadata));
      const columns = metadata.map((value) => {
        const column = object(value);
        assert(typeof column.name === "string" && /^[a-z_][a-z0-9_]*$/.test(column.name));
        assert(typeof column.pk === "number");
        return { name: column.name, pk: column.pk };
      });
      const primary = columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk);
      const ordering = (primary.length > 0 ? primary : columns).map((column) => `"${column.name}"`).join(", ");
      return [name, reader.prepare(`SELECT * FROM "${name}" ORDER BY ${ordering}`).all()];
    });
    return json({ database: Object.fromEntries(rows), files: fixtureFiles(database.reposDir) });
  }

  try {
    let repo = await open();
    const source = repo.createSource({ name: "GRE-487 source", url: "https://example.test/gre487", source_kind: "github" });
    const observed = repo.getProjectRow(source.id);
    assert(observed);
    const locator = `${source.id}/revisions/a`;
    const sourceRoot = join(database.reposDir, locator);
    mkdirSync(sourceRoot, { recursive: true });
    for (const name of ["a", "b"]) {
      const path = join(sourceRoot, `${name}.stl`);
      writeFileSync(path, `solid ${name}\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid ${name}\n`);
      utimesSync(path, new Date(policy.clock), new Date(policy.clock));
    }
    const revision = repo.recordSourceRevision({
      sourceId: source.id,
      upstreamRevisionKey: "a",
      manifestDigest: "a".repeat(64),
      snapshotLocator: locator,
      syncedAt: policy.clock,
      completeness: "complete",
    });
    repo.activateSourceRevision({ sourceId: source.id, revisionId: revision.id, observed, sourceVersion: "a" });
    const profile = repo.createProfile("GRE-487 Build", source.id);
    const seed = repo.recomputePlanDraft({
      profileId: profile.id,
      actor: "gre487:seed",
      idempotencyKey: "seed-draft",
      applyManifest: false,
    });
    assert(seed.kind === "created");
    const reconciled = repo.savePlanDraftRequiredUnitReconciliation({
      profileId: profile.id,
      draftId: seed.draft.id,
      expectedSnapshotDigest: seed.draft.snapshotDigest,
      decisions: [],
      actorId: "gre487:seed",
      idempotencyKey: "seed-reconcile",
    });
    assert(reconciled.kind === "saved" && reconciled.reconciliation.resultKind === "ready");
    const accepted = repo.applyPlanChanges({
      profileId: profile.id,
      draftId: reconciled.draft.id,
      expectedSnapshotDigest: reconciled.draft.snapshotDigest,
      expectedLifecycleVersion: reconciled.draft.lifecycleVersion,
      expectedBase: { kind: "empty", planVersion: 0 },
      actorId: "gre487:seed",
      idempotencyKey: "seed-accept",
    });
    assert(accepted.kind === "applied");
    const initialAccepted = repo.getAcceptedPlanRevision(profile.id);
    assert(initialAccepted);
    const base = { revision_id: initialAccepted.id, plan_version: initialAccepted.planVersion };
    const created = await app.inject({
      method: "POST",
      url: `/plans/${profile.id}/drafts/recompute`,
      headers: { "idempotency-key": "working-draft" },
      payload: { apply_manifest: false },
    });
    assert.equal(created.statusCode, 200, created.body);
    const initial = parsePlanDraftWorkspace(created.json());
    const draftUrl = `/plans/${profile.id}/drafts/${initial.draft.draft_id}`;
    function part(filename: string) {
      const value = initial.parts.find((candidate) => candidate.filename === filename);
      assert(value, `Draft Part missing ${filename}`);
      return value;
    }
    const a = part("a.stl");
    const b = part("b.stl");

    function assertWorkspace(workspace: PlanDraftWorkspace, quantity: number, included: boolean) {
      assert.equal(workspace.profile_id, profile.id);
      assert.equal(workspace.draft.draft_id, initial.draft.draft_id);
      assert.equal(workspace.draft.state, "open");
      assert.equal(workspace.draft.lifecycle_version, initial.draft.lifecycle_version);
      assert.deepEqual(workspace.draft.base, base);
      assert.equal(workspace.diff.base_is_current, true);
      assert.equal(workspace.parts.length, 2);
      assert.deepEqual(workspace.parts.map((part) => ({ id: part.draft_part_id, filename: part.filename, quantity: part.quantity_effective, override: part.quantity_override, included: part.included })), [
        { id: a.draft_part_id, filename: "a.stl", quantity, override: quantity === 1 ? null : quantity, included: true },
        { id: b.draft_part_id, filename: "b.stl", quantity: 1, override: null, included },
      ]);
      assert.equal(workspace.reconciliation.kind, "ready");
      assert.equal(
        repo.getPlanDraft(profile.id, workspace.draft.draft_id)?.snapshotDigest,
        workspace.draft.snapshot_digest,
        "Response digest differs from the durable draft",
      );
      assert.deepEqual(repo.getAcceptedPlanRevision(profile.id), initialAccepted, "Draft edits changed the accepted Plan");
    }

    function editBody(workspace: PlanDraftWorkspace, quantity: number, included: boolean): string {
      return JSON.stringify(parseEditPlanDraftPartsRequest({ expected_snapshot_digest: workspace.draft.snapshot_digest, decisions: [
        { kind: "set_quantity_override", draft_part_ids: [a.draft_part_id], value: quantity },
        { kind: "set_included", draft_part_ids: [b.draft_part_id], value: included },
      ] }));
    }

    assertWorkspace(initial, 1, true);
    const heldBytes = editBody(initial, 1, true);
    evidence.push(json({ step: "D0-held", heldBytes, workspace: initial, state: snapshot() }));
    let current = initial;
    const freshChoices = [
      { quantity: 2, included: false },
      { quantity: 3, included: true },
      { quantity: 4, included: false },
    ];
    for (const choice of freshChoices) {
      const bytes = editBody(current, choice.quantity, choice.included);
      const response = await app.inject({
        method: "PATCH",
        url: `${draftUrl}/parts`,
        headers: { "content-type": "application/json" },
        payload: bytes,
      });
      assert.equal(response.statusCode, 200, response.body);
      const next = parsePlanDraftWorkspace(response.json());
      assertWorkspace(next, choice.quantity, choice.included);
      assert.notEqual(next.draft.snapshot_digest, current.draft.snapshot_digest, "Fresh edit did not advance the digest");
      evidence.push(json({ step: `fresh-${choice.quantity}`, bytes, workspace: next, state: snapshot() }));
      current = next;
    }
    assert.notEqual(current.draft.snapshot_digest, initial.draft.snapshot_digest);
    const beforeStale = snapshot();
    const stale = await app.inject({
      method: "PATCH",
      url: `${draftUrl}/parts`,
      headers: { "content-type": "application/json" },
      payload: heldBytes,
    });
    assert.equal(stale.statusCode, 409, `Held D0 PATCH must be refused. ${stale.body}`);
    const conflict = object(json(stale.json()));
    assert.equal(conflict.code, "draft_changed");
    const conflictWorkspace = parsePlanDraftWorkspace(conflict.workspace);
    assertWorkspace(conflictWorkspace, 4, false);
    assert.deepEqual(conflictWorkspace, current, "Conflict did not return the authoritative workspace");
    assert.deepEqual(snapshot(), beforeStale, "Stale PATCH wrote logical database rows or fixture files");
    evidence.push(json({ step: "held-D0-refused", status: stale.statusCode, response: conflict, state: beforeStale }));

    repo = await reopen();
    assert.deepEqual(snapshot(), beforeStale, "Closing and reopening changed logical state");
    const beforeRead = snapshot();
    const read = await app.inject({ method: "GET", url: draftUrl });
    assert.equal(read.statusCode, 200, read.body);
    const reopened = parsePlanDraftWorkspace(read.json());
    assertWorkspace(reopened, 4, false);
    assert.deepEqual(reopened, current, "Reopened draft lost surviving choices or identity");
    assert.deepEqual(snapshot(), beforeRead, "Draft GET wrote logical state");
    evidence.push(json({ step: "draft-reopened", workspace: reopened, state: beforeRead }));

    const target = (part: typeof a) => ({ part_key: part.part_key, relative_path: part.relative_path, source_layer: part.source_layer });
    const saveBody = parseSavePlanChoicesRequest({ expected_base: reopened.draft.base, expected_draft: reopened.draft, remap_checkoff_links: true, decisions: [
      { kind: "set_quantity_override", target: target(a), value: 4 },
      { kind: "set_included", target: target(b), value: false },
    ] });
    const save = await app.inject({
      method: "POST",
      url: `/plans/${profile.id}/save`,
      headers: { "idempotency-key": "final-save" },
      payload: saveBody,
    });
    assert.equal(save.statusCode, 200, save.body);
    const saved = object(json(save.json()));
    const receipt = parseApplyPlanDraftReceipt(saved.receipt);
    assert.equal(receipt.profile_id, profile.id);
    assert.equal(receipt.plan_version, base.plan_version + 1);
    assert.notEqual(receipt.revision_id, base.revision_id);
    assert.deepEqual(saved.closed_draft_ids, [initial.draft.draft_id]);
    assert.equal(repo.getPlanDraft(profile.id, initial.draft.draft_id)?.state, "abandoned");

    function assertReview(review: PlanReview) {
      assert(review.accepted_basis);
      assert.equal(review.accepted_basis.plan_revision_id, receipt.revision_id);
      assert.equal(review.accepted_basis.plan_version, receipt.plan_version);
      assert.equal(review.accepted_basis.plan_revision_digest, receipt.revision_digest);
      assert.equal(review.accepted_basis.required_unit_mapping_digest, receipt.required_unit_mapping_digest);
      assert.deepEqual(review.part_groups.flatMap((group) => group.parts).map((part) => ({ filename: part.filename, quantity: part.quantity_effective, override: part.quantity_override, included: part.included })), [
        { filename: "a.stl", quantity: 4, override: 4, included: true },
        { filename: "b.stl", quantity: 1, override: null, included: false },
      ]);
    }

    assertReview(parsePlanReview(saved.review, profile.id));
    assert(raw);
    const count = object(json(raw.prepare("SELECT COUNT(*) AS count FROM plan_revisions WHERE profile_id = ?").get(profile.id))).count;
    assert.equal(count, 2, "Final save must publish exactly one new accepted revision");
    const afterSave = snapshot();
    assert.deepEqual(object(afterSave).files, object(beforeStale).files, "Save changed fixture files");
    evidence.push(json({ step: "final-save", request: saveBody, response: saved, state: afterSave }));
    repo = await reopen();
    assert.deepEqual(snapshot(), afterSave, "Accepted state changed during reopen");
    const reviewRead = await app.inject({
      method: "GET",
      url: `/plans/${profile.id}/review?include_excluded=true`,
    });
    assert.equal(reviewRead.statusCode, 200, reviewRead.body);
    const finalReview = parsePlanReview(reviewRead.json(), profile.id);
    assertReview(finalReview);
    assert.deepEqual(snapshot(), afterSave, "Accepted Review GET wrote logical state");
    evidence.push(json({ step: "accepted-reopened", review: finalReview, state: afterSave }));
    return normalize(json(evidence), root);
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
    mock.timers.reset();
  }
}
