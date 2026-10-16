import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function transactions(root) {
  const load = (path) => import(pathToFileURL(join(root, path)).href);
  const { default: Database } = await load("web/node_modules/better-sqlite3/lib/index.js");
  const { SqliteDatabase, getDb } = await load("web/apps/server/src/db/client.ts");
  const { AppRepository } = await load("web/apps/server/src/db/repository.ts");
  const schema = await load("web/apps/server/src/db/schema.ts");
  const at = "2026-09-06T00:00:00.000Z";
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [at])); }
    static now() { return new RealDate(at).getTime(); }
  };
  const cases = [];
  let definitions;
  try {
    for (const id of ["first", "idempotent", "changed", "running-export", "uploaded-only", "mapped-remap", "mapped-remap-index-change", "unsafe-remap", "inputs", "missing-reconciliation", "unresolved-reconciliation", "stale-reconciliation"]) {
      const dir = mkdtempSync(join(tmpdir(), "pp-publication-"));
      const database = new SqliteDatabase(dir);
      let raw;
      try {
        database.connect();
        raw = new Database(join(dir, "print-partner.db"));
        raw.exec(readFileSync(join(root, "rust/crates/pp-storage/src/jobs/schema.sql"), "utf8"));
        let counter = 0;
        const repo = new AppRepository(getDb(database), "default", database.reposDir, schema, {
          clock: () => new Date(at), tokenFactory: () => `ppu_${(++counter).toString(16).padStart(32, "0")}`,
        });
        const source = repo.createSource({ name: "Publication source", url: "https://example.test/publication", source_kind: "github" });
        const locator = `${source.id}/revisions/a`;
        mkdirSync(join(database.reposDir, locator), { recursive: true });
        writeFileSync(join(database.reposDir, locator, "bracket.stl"), "solid bracket");
        const revision = repo.recordSourceRevision({ sourceId: source.id, upstreamRevisionKey: "a", manifestDigest: "a".repeat(64), snapshotLocator: locator, syncedAt: at, completeness: "complete" });
        repo.activateSourceRevision({ sourceId: source.id, revisionId: revision.id, observed: repo.getProjectRow(source.id), sourceVersion: "a" });
        const profile = repo.createProfile("Publication Build", source.id);
        if (id === "inputs") {
          const addon = repo.createSource({ name: "Addon source", url: "https://example.test/addon", source_kind: "github" });
          const addonLocator = `${addon.id}/revisions/b`;
          mkdirSync(join(database.reposDir, addonLocator), { recursive: true });
          writeFileSync(join(database.reposDir, addonLocator, "addon.stl"), "solid addon");
          const pinned = repo.recordSourceRevision({ sourceId: addon.id, upstreamRevisionKey: "b", manifestDigest: "b".repeat(64), snapshotLocator: addonLocator, syncedAt: at, completeness: "complete" });
          repo.activateSourceRevision({ sourceId: addon.id, revisionId: pinned.id, observed: repo.getProjectRow(addon.id), sourceVersion: "b" });
          repo.addAddonLayer(profile.id, addon.id);
        }
        let sequence = 0;
        const draft = (edit, reconcile = true) => {
          const created = repo.recomputePlanDraft({ profileId: profile.id, actor: "test:publication", idempotencyKey: `draft-${++sequence}`, applyManifest: false });
          assert.equal(created.kind, "created");
          let current = created.draft;
          if (edit) {
            const edited = repo.editPlanDraftParts({ profileId: profile.id, draftId: current.id, expectedSnapshotDigest: current.snapshotDigest, decision: edit(current.parts[0].id) });
            assert.equal(edited.kind, "updated");
            current = edited.draft;
          }
          if (!reconcile) return current;
          const reconciled = repo.savePlanDraftRequiredUnitReconciliation({ profileId: profile.id, draftId: current.id, expectedSnapshotDigest: current.snapshotDigest, actorId: "test:publication", idempotencyKey: `reconcile-${sequence}`, decisions: [] });
          assert.equal(reconciled.kind, "saved");
          return reconciled.draft;
        };
        const command = (d) => ({ profileId: profile.id, draftId: d.id, expectedSnapshotDigest: d.snapshotDigest, expectedLifecycleVersion: d.lifecycleVersion, expectedBase: d.baseRevisionId == null ? { kind: "empty", planVersion: 0 } : { kind: "revision", revisionId: d.baseRevisionId, planVersion: d.basePlanVersion }, actorId: "test:publication", idempotencyKey: `apply-${sequence}`, remapCheckoffLinks: true });
        let d = draft(["stale-reconciliation", "mapped-remap-index-change"].includes(id) ? (partId) => ({ kind: "set_quantity_override", partIds: [partId], value: id === "mapped-remap-index-change" ? 3 : 2 }) : null, id !== "missing-reconciliation");
        let input = command(d);
        if (["idempotent", "changed", "mapped-remap", "mapped-remap-index-change", "unsafe-remap", "unresolved-reconciliation", "stale-reconciliation"].includes(id)) {
          assert.equal(repo.applyPlanChanges(input).kind, "applied");
          if (id !== "idempotent") {
            if (id === "mapped-remap-index-change") raw.prepare("UPDATE print_progress SET completed=1 WHERE unit_index IN (1,2)").run();
            if (["unresolved-reconciliation", "stale-reconciliation"].includes(id)) raw.prepare("UPDATE print_progress SET completed=1").run();
            if (id === "unresolved-reconciliation") writeFileSync(join(database.reposDir, locator, "bracket.stl"), "solid changed bracket");
            d = draft((partId) => ({ kind: "set_quantity_override", partIds: [partId], value: id === "stale-reconciliation" ? 1 : 2 }));
            input = command(d);
          }
        }
        if (["mapped-remap", "mapped-remap-index-change"].includes(id)) {
          const p = raw.prepare("SELECT id FROM parts WHERE profile_id=?").get(profile.id);
          const unit = { part_id: p.id, unit_index: id === "mapped-remap-index-change" ? 1 : 0 };
          repo.setSetting("printer.checkoff_links", JSON.stringify([{ id: "kept-slot", filename: "bracket.stl", profile_id: profile.id, state: "watching", units: [unit], resolved_units: [{ ...unit, result: "printed" }] }]));
          repo.setSetting("printer.send_queue", JSON.stringify([{ id: "kept-queue", profile_id: null, state: "error", checkoff_units: [unit] }]));
        }
        if (id === "unsafe-remap") {
          const p = raw.prepare("SELECT id FROM parts WHERE profile_id=?").get(profile.id);
          repo.setSetting("printer.checkoff_links", JSON.stringify([{ id: "missing-slot", filename: "bracket.stl", profile_id: profile.id, state: "watching", units: [{ part_id: p.id, unit_index: 9 }] }]));
        }
        if (id === "stale-reconciliation") raw.prepare("UPDATE print_progress SET completed=0").run();
        if (["running-export", "uploaded-only"].includes(id)) {
          const uploaded = id === "uploaded-only";
          const kind = uploaded ? "printer-upload" : "export-stl-pack";
          const state = uploaded ? "uploaded_only" : "running";
          const receipt = { receipt_id: "upload-receipt", content_hash: "c".repeat(64), target: "printer" };
          const job = {
            job_id: id, tenant: "default", kind, payload_version: 1,
            payload: { kind, payload: uploaded ? { printer_id: "printer", artifact_path: "exports/part.gcode", filename: "part.gcode", start: true, profile_id: profile.id, host_name: null, checkoff_units: [], unlabeled_names: [] } : { profile_id: profile.id, missing_only: false, group_by: "color_dir", unit_tokens: [], filename_grouping: null } },
            state, state_version: 1, attempt: 1, generation: 1, lease_until: null,
            created_at: 1, updated_at: 1, finished_at: uploaded ? 1 : null,
            cancel_requested: false, progress: null, result: uploaded ? receipt : null, recovery: null,
            effects: uploaded ? [{ intent: { operation: "printer_upload", basis_hash: "b".repeat(64), content_hash: "c".repeat(64), target: "printer" }, attempt: 1, generation: 1, confirmed: true, receipt }] : [],
          };
          raw.prepare("INSERT INTO durable_jobs VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(id, "default", kind, state, "fixture", 1, 1, null, 1, 1, JSON.stringify(job));
        }
        const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
        const snapshot = () => Object.fromEntries(tables.map((table) => [table, raw.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()]).filter(([, rows]) => rows.length));
        definitions ??= raw.prepare("SELECT type,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all();
        const before = snapshot();
        const allocationStart = counter;
        const outcome = repo.applyPlanChanges(input);
        cases.push(JSON.parse(JSON.stringify({ id, input, allocationStart, before, outcome, after: snapshot() }).replaceAll(dir, "<data>")));
      } finally {
        raw?.close(); database.close(); rmSync(dir, { recursive: true, force: true });
      }
    }
  } finally { globalThis.Date = RealDate; }
  // File locators are machine-dependent, but publication never reads source files.
  const stable = JSON.stringify({ at, definitions, cases }).replaceAll(resolve(root), "<repo>");
  return JSON.parse(stable);
}
