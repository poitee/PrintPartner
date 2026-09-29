import type Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acceptPlanForTest, editAcceptedPartsForTest } from "../test/accept-plan.js";
import { captureAcceptedOperationalExport } from "../services/accepted-operational-export.js";
import { getDb, SqliteDatabase } from "./client.js";
import { acceptedPlanBasis } from "./accepted-plan-progress.js";
import { AppRepository, type PlanDraftPartChoice } from "./repository.js";
import { buildKitBundleData } from "../services/export-kit.js";
import { loadKitManifest, saveKitManifest } from "../services/kit-manifest-store.js";
import { loadRoleFilamentDefaults } from "../services/role-filament-store.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function acceptedPlanFixture(
  name: string,
  filenames = ["widget.stl"],
  partChoices?: ReadonlyMap<string, PlanDraftPartChoice>,
) {
  const root = mkdtempSync(join(tmpdir(), "pp-accepted-copy-"));
  roots.push(root);
  const database = new SqliteDatabase(root);
  database.connect();
  const repo = new AppRepository(getDb(database), undefined, database.reposDir);
  const source = repo.createSource({
    name: `${name}Repo`,
    url: "https://github.com/a/b",
  });
  const repoPath = join(root, "repos", String(source.id));
  mkdirSync(join(repoPath, "parts"), { recursive: true });
  for (const filename of filenames) {
    writeFileSync(join(repoPath, "parts", filename), `solid ${filename}`);
  }
  repo.updateSource(source.id, { local_path: repoPath });
  repo.updateImportRules(source.id, ["parts/"]);
  const plan = repo.createProfile(name, source.id);
  expect(acceptPlanForTest(repo, plan.id, {
    partChoicesBySourceId: partChoices
      ? new Map([[source.id, partChoices]])
      : undefined,
  }).merged).toBe(true);
  return {
    database,
    repo,
    plan,
    repoPath,
    source,
    raw: (database as unknown as { sqlite: Database.Database }).sqlite,
  };
}

describe("duplicateProfile accepted publish", () => {
  it("preserves an accepted per-Part role override", () => {
    const { database, repo, plan } = acceptedPlanFixture(
      "RoleOverride",
      ["widget.stl"],
      new Map([
        ["parts/widget.stl", { quantity: 1, role: "accent", color: null }],
      ]),
    );
    const source = repo.readAcceptedPlanOperationalSnapshot(plan.id);
    if (source.kind !== "ready") throw new Error("source Plan is not ready");
    expect(source.snapshot.parts[0]).toMatchObject({
      roleOverride: "accent",
      effectiveRole: "accent",
    });

    const copy = repo.duplicateProfile(plan.id, "RoleOverrideCopy");

    const accepted = repo.readAcceptedPlanOperationalSnapshot(copy.id);
    if (accepted.kind !== "ready") throw new Error("copied Plan is not ready");
    expect(accepted.snapshot.parts[0]).toMatchObject({
      roleOverride: "accent",
      effectiveRole: "accent",
    });
    expect(repo.readAcceptedPlanOperationalSnapshot(plan.id)).toEqual(source);
    expect(accepted.snapshot.parts[0]?.projectionPartId).not.toBe(
      source.snapshot.parts[0]?.projectionPartId,
    );
    database.close();
  });

  it.each([
    { clearCheckoff: false, copyName: "Copied with progress", completedBaseUnits: 5, completedCapUnits: 1 },
    { clearCheckoff: true, copyName: "Copied without progress", completedBaseUnits: 0, completedCapUnits: 0 },
  ])(
    "preserves accepted selections and saved quantities when clearCheckoff is $clearCheckoff",
    ({ clearCheckoff, copyName, completedBaseUnits, completedCapUnits }) => {
      const { database, repo, plan } = acceptedPlanFixture("ConfiguredPlan", [
        "base_x2.stl",
        "cap.stl",
        "brace.stl",
        "optional.stl",
      ]);
      const initial = repo.readAcceptedPlanOperationalSnapshot(plan.id);
      if (initial.kind !== "ready") throw new Error("source Plan is not ready");
      const base = initial.snapshot.parts.find((part) => part.filename === "base_x2.stl");
      const optional = initial.snapshot.parts.find((part) => part.filename === "optional.stl");
      if (!base || !optional) throw new Error("source Parts are missing");
      expect(base.quantityInferred).toBe(2);

      editAcceptedPartsForTest(repo, plan.id, [
        { projectionPartId: base.projectionPartId, quantityOverride: 5 },
        { projectionPartId: optional.projectionPartId, included: false },
      ]);
      const edited = repo.readAcceptedPlanOperationalSnapshot(plan.id);
      if (edited.kind !== "ready") throw new Error("edited source Plan is not ready");
      const editedBase = edited.snapshot.parts.find((part) => part.filename === "base_x2.stl");
      const editedCap = edited.snapshot.parts.find((part) => part.filename === "cap.stl");
      if (!editedBase || !editedCap) throw new Error("edited source Parts are missing");
      expect(
        repo.assignAcceptedFilament({
          expected: acceptedPlanBasis(edited.snapshot),
          target: { kind: "role", role: editedBase.effectiveRole },
          assignment: {
            color: { kind: "catalog", colorId: "pla-black" },
            spoolmanSpoolId: "spool-9",
          },
        }).kind,
      ).toBe("updated");
      expect(
        repo.setAcceptedPrintedCounts({
          expected: acceptedPlanBasis(edited.snapshot),
          rows: [
            { partId: editedBase.projectionPartId, printedCount: 5 },
            { partId: editedCap.projectionPartId, printedCount: 1 },
          ],
        }).kind,
      ).toBe("updated");
      saveKitManifest(repo, plan.id, { selections: { head: "sb" } });
      const sourceBeforeCopy = repo.readAcceptedPlanOperationalSnapshot(plan.id);
      if (sourceBeforeCopy.kind !== "ready") throw new Error("source Plan changed before duplication");
      const sourceRoleDefaults = loadRoleFilamentDefaults(repo, plan.id);
      expect(sourceRoleDefaults[editedBase.effectiveRole]).toEqual({
        filament_color_id: "pla-black",
        filament_custom_hex: null,
        spoolman_spool_id: "spool-9",
      });
      const savePlanChoices = repo.savePlanChoices.bind(repo);
      const publish = vi.spyOn(repo, "savePlanChoices").mockImplementation((command) => {
        expect(loadKitManifest(repo, command.profileId).selections).toEqual({ head: "sb" });
        expect(loadRoleFilamentDefaults(repo, command.profileId)).toEqual(sourceRoleDefaults);
        expect(command.changes).toEqual(expect.arrayContaining([
          {
            target: {
              partKey: editedBase.partKey,
              relativePath: editedBase.relativePath,
              sourceLayer: editedBase.sourceLayer,
            },
            kind: "set_quantity_override",
            value: 5,
          },
          {
            target: {
              partKey: optional.partKey,
              relativePath: optional.relativePath,
              sourceLayer: optional.sourceLayer,
            },
            kind: "set_included",
            value: false,
          },
        ]));
        return savePlanChoices(command);
      });

      const copy = repo.duplicateProfile(plan.id, copyName, { clearCheckoff });

      expect(publish).toHaveBeenCalledTimes(1);
      expect(repo.readAcceptedPlanOperationalSnapshot(plan.id)).toEqual(sourceBeforeCopy);
      const accepted = repo.readAcceptedPlanOperationalSnapshot(copy.id);
      if (accepted.kind !== "ready") throw new Error("copied Plan is not ready");
      const copiedBase = accepted.snapshot.parts.find((part) => part.filename === "base_x2.stl");
      const copiedCap = accepted.snapshot.parts.find((part) => part.filename === "cap.stl");
      const copiedOptional = accepted.snapshot.parts.find((part) => part.filename === "optional.stl");
      if (!copiedBase || !copiedCap || !copiedOptional) throw new Error("copied Parts are missing");
      expect(copiedBase).toMatchObject({
        quantityInferred: 2,
        quantityOverride: 5,
        quantityEffective: 5,
        filamentColorId: "pla-black",
        spoolmanSpoolId: "spool-9",
      });
      expect(copiedBase.units).toHaveLength(5);
      expect(copiedBase.units.filter((unit) => unit.completed)).toHaveLength(completedBaseUnits);
      expect(copiedCap.units.filter((unit) => unit.completed)).toHaveLength(completedCapUnits);
      expect(copiedOptional.included).toBe(false);
      const sourceBase = sourceBeforeCopy.snapshot.parts.find((part) => part.filename === "base_x2.stl");
      if (!sourceBase) throw new Error("source base Part is missing");
      expect(copiedBase.projectionPartId).not.toBe(sourceBase.projectionPartId);
      expect(copiedBase.units.map((unit) => unit.token)).not.toEqual(
        sourceBase.units.map((unit) => unit.token),
      );
      expect(
        accepted.snapshot.parts
          .filter((part) => part.included)
          .reduce((total, part) => total + part.units.length, 0),
      ).toBe(7);
      expect(loadKitManifest(repo, copy.id).selections.head).toBe("sb");
      database.close();
    },
  );

  it("publishes a ready accepted copy through Apply instead of inserting working Parts", () => {
    const { database, repo, plan } = acceptedPlanFixture("SourcePlan");
    const source = repo.readAcceptedPlanOperationalSnapshot(plan.id);
    expect(source.kind).toBe("ready");
    if (source.kind !== "ready") throw new Error("source Plan is not ready");
    const part = source.snapshot.parts[0];
    if (!part) throw new Error("source Part is missing");
    expect(
      repo.assignAcceptedFilament({
        expected: acceptedPlanBasis(source.snapshot),
        target: { kind: "part", projectionPartId: part.projectionPartId },
        assignment: {
          color: { kind: "catalog", colorId: "pla-black" },
          spoolmanSpoolId: "spool-9",
        },
      }).kind,
    ).toBe("updated");
    expect(
      repo.setAcceptedPrintedCounts({
        expected: acceptedPlanBasis(source.snapshot),
        rows: [{ partId: part.projectionPartId, printedCount: 1 }],
      }).kind,
    ).toBe("updated");
    saveKitManifest(repo, plan.id, { selections: { head: "sb" } });

    const copy = repo.duplicateProfile(plan.id, "CopiedPlan");
    const accepted = repo.readAcceptedPlanOperationalSnapshot(copy.id);
    expect(accepted.kind).toBe("ready");
    if (accepted.kind !== "ready") throw new Error("copied Plan is not ready");
    expect(accepted.snapshot.revisionId).toBeGreaterThan(0);
    expect(accepted.snapshot.parts[0]?.filename).toBe("widget.stl");
    expect(accepted.snapshot.parts[0]?.projectionPartId).not.toBe(part.projectionPartId);
    expect(accepted.snapshot.parts[0]?.filamentColorId).toBe("pla-black");
    expect(accepted.snapshot.parts[0]?.spoolmanSpoolId).toBe("spool-9");
    expect(accepted.snapshot.parts[0]?.units[0]?.completed).toBe(true);
    expect(loadKitManifest(repo, copy.id).selections.head).toBe("sb");
    database.close();
  });

  it("reports a publication failure instead of returning an empty duplicate", () => {
    const { database, repo, plan, repoPath, raw } = acceptedPlanFixture("MissingDuplicateSource");
    rmSync(join(repoPath, "parts", "widget.stl"));

    expect(() => repo.duplicateProfile(plan.id, "FailedCopy")).toThrow("Failed to publish duplicated Plan");
    expect(raw.prepare("SELECT id FROM build_profiles WHERE name = ?").get("FailedCopy")).toBeUndefined();
    database.close();
  });

  it("preserves distinct assignments on Parts that share a role", () => {
    const { database, repo, plan } = acceptedPlanFixture("DistinctAssignments", ["widget-a.stl", "widget-b.stl"]);
    const source = repo.readAcceptedPlanOperationalSnapshot(plan.id);
    if (source.kind !== "ready") throw new Error("source Plan is not ready");
    const [first, second] = source.snapshot.parts;
    if (!first || !second) throw new Error("source Parts are missing");
    expect(first.effectiveRole).toBe(second.effectiveRole);
    expect(
      repo.assignAcceptedFilament({
        expected: acceptedPlanBasis(source.snapshot),
        target: { kind: "part", projectionPartId: first.projectionPartId },
        assignment: {
          color: { kind: "catalog", colorId: "pla-black" },
          spoolmanSpoolId: null,
        },
      }).kind,
    ).toBe("updated");
    expect(
      repo.assignAcceptedFilament({
        expected: acceptedPlanBasis(source.snapshot),
        target: { kind: "part", projectionPartId: second.projectionPartId },
        assignment: {
          color: { kind: "catalog", colorId: "pla-red" },
          spoolmanSpoolId: null,
        },
      }).kind,
    ).toBe("updated");

    const copy = repo.duplicateProfile(plan.id, "DistinctAssignmentsCopy");
    const accepted = repo.readAcceptedPlanOperationalSnapshot(copy.id);
    if (accepted.kind !== "ready") throw new Error("copied Plan is not ready");
    expect(accepted.snapshot.parts.map((part) => [part.filename, part.filamentColorId])).toEqual([
      ["widget-a.stl", "pla-black"],
      ["widget-b.stl", "pla-red"],
    ]);
    database.close();
  });

  it("rolls back every assignment when an overlay write fails", () => {
    const { database, repo, plan, raw } = acceptedPlanFixture("RollbackAssignments", ["widget-a.stl", "widget-b.stl"]);
    const source = repo.readAcceptedPlanOperationalSnapshot(plan.id);
    if (source.kind !== "ready") throw new Error("source Plan is not ready");
    const [first, second] = source.snapshot.parts;
    if (!first || !second) throw new Error("source Parts are missing");
    expect(
      repo.assignAcceptedFilament({
        expected: acceptedPlanBasis(source.snapshot),
        target: { kind: "part", projectionPartId: first.projectionPartId },
        assignment: {
          color: { kind: "catalog", colorId: "pla-black" },
          spoolmanSpoolId: null,
        },
      }).kind,
    ).toBe("updated");
    expect(
      repo.assignAcceptedFilament({
        expected: acceptedPlanBasis(source.snapshot),
        target: { kind: "part", projectionPartId: second.projectionPartId },
        assignment: {
          color: { kind: "catalog", colorId: "pla-red" },
          spoolmanSpoolId: null,
        },
      }).kind,
    ).toBe("updated");
    expect(
      repo.setAcceptedPrintedCounts({
        expected: acceptedPlanBasis(source.snapshot),
        rows: [{ partId: first.projectionPartId, printedCount: 1 }],
      }).kind,
    ).toBe("updated");
    raw.exec(`
      CREATE TRIGGER reject_red_overlay
      BEFORE UPDATE OF filament_color_id ON parts
      WHEN NEW.filament_color_id = 'pla-red'
      BEGIN
        SELECT RAISE(ABORT, 'rejected overlay');
      END
    `);

    expect(() => repo.duplicateProfile(plan.id, "RollbackAssignmentsCopy")).toThrow("rejected overlay");
    expect(raw.prepare("SELECT id FROM build_profiles WHERE name = ?").get("RollbackAssignmentsCopy")).toBeUndefined();
    database.close();
  });
});

describe("importKitBundle accepted publish", () => {
  it("remaps choices, filament, and progress together when the exported Part key is stale", () => {
    const { database, repo, plan, source } = acceptedPlanFixture("RemappedImportHost");
    const sourceAccepted = repo.readAcceptedPlanOperationalSnapshot(plan.id);
    if (sourceAccepted.kind !== "ready") throw new Error("source Plan is not ready");
    const sourcePart = sourceAccepted.snapshot.parts[0];
    if (!sourcePart) throw new Error("source Part is missing");

    const imported = repo.importKitBundle(
      {
        format: "print-partner-kit",
        version: 3,
        profile: { name: "Remapped import" },
        layers: [
          {
            layer_order: 0,
            layer_type: "base",
            project: { name: source.name, url: source.url },
          },
        ],
        parts: [
          {
            match_key: "legacy:widget.stl",
            relative_path: sourcePart.relativePath,
            source_layer: sourcePart.sourceLayer,
            filename: sourcePart.filename,
            role: "accent",
            filament_color_id: "pla-black",
            quantity_override: 3,
            included: true,
            print_units: [true, false, false],
          },
        ],
      },
      "Remapped import",
    );

    expect(imported.warnings).toEqual([]);
    const accepted = repo.readAcceptedPlanOperationalSnapshot(imported.profile_id);
    if (accepted.kind !== "ready") throw new Error("imported Plan is not ready");
    expect(accepted.snapshot.parts[0]).toMatchObject({
      partKey: sourcePart.partKey,
      quantityOverride: 3,
      quantityEffective: 3,
      roleOverride: "accent",
      effectiveRole: "accent",
      filamentColorId: "pla-black",
    });
    expect(accepted.snapshot.parts[0]?.units.filter((unit) => unit.completed)).toHaveLength(1);
    database.close();
  });

  it("publishes exported accepted choices before applying optional progress", () => {
    const { database, repo, plan } = acceptedPlanFixture(
      "LegacyBundleSource",
      ["cap.stl", "base_x2.stl", "bracket.stl"],
      new Map([
        ["parts/cap.stl", { quantity: 1, role: "accent", color: "#33bbcc" }],
      ]),
    );
    const initial = repo.readAcceptedPlanOperationalSnapshot(plan.id);
    if (initial.kind !== "ready") throw new Error("source Plan is not ready");
    const cap = initial.snapshot.parts.find((part) => part.filename === "cap.stl");
    const base = initial.snapshot.parts.find((part) => part.filename === "base_x2.stl");
    const bracket = initial.snapshot.parts.find((part) => part.filename === "bracket.stl");
    if (!cap || !base || !bracket) throw new Error("source Parts are missing");
    editAcceptedPartsForTest(repo, plan.id, [
      { projectionPartId: cap.projectionPartId, quantityOverride: 3 },
      { projectionPartId: base.projectionPartId, quantityOverride: 154 },
      { projectionPartId: bracket.projectionPartId, included: false },
    ]);
    const configured = repo.readAcceptedPlanOperationalSnapshot(plan.id);
    if (configured.kind !== "ready") throw new Error("configured source Plan is not ready");
    const configuredCap = configured.snapshot.parts.find((part) => part.filename === "cap.stl");
    if (!configuredCap) throw new Error("configured cap is missing");
    expect(
      repo.setAcceptedPrintedCounts({
        expected: acceptedPlanBasis(configured.snapshot),
        rows: [{ partId: configuredCap.projectionPartId, printedCount: 2 }],
      }).kind,
    ).toBe("updated");
    const sourceBeforeImport = repo.readAcceptedPlanOperationalSnapshot(plan.id);
    if (sourceBeforeImport.kind !== "ready") throw new Error("source Plan changed before export");
    const captured = captureAcceptedOperationalExport({ repository: repo, profileId: plan.id });
    if (captured.kind !== "ready") throw new Error("captured export is not ready");
    const data = buildKitBundleData({
      mode: {
        kind: "accepted_progress",
        recipe: repo.readEditableKitRecipe(plan.id),
        accepted: captured.export,
      },
      exportedAt: "2026-09-29T19:42:46.371Z",
    });
    const exportedBase = Array.isArray(data.parts)
      ? data.parts.find(
          (part): part is Record<string, unknown> =>
            part !== null &&
            typeof part === "object" &&
            !Array.isArray(part) &&
            part.filename === "base_x2.stl",
        )
      : undefined;
    if (!exportedBase) throw new Error("exported base is missing");
    delete exportedBase.print_units;

    const imported = repo.importKitBundle(data, "Legacy bundle copy");

    expect(imported.warnings).toEqual([]);
    const accepted = repo.readAcceptedPlanOperationalSnapshot(imported.profile_id);
    if (accepted.kind !== "ready") throw new Error("imported Plan is not ready");
    const importedCap = accepted.snapshot.parts.find((part) => part.filename === "cap.stl");
    const importedBase = accepted.snapshot.parts.find((part) => part.filename === "base_x2.stl");
    const importedBracket = accepted.snapshot.parts.find((part) => part.filename === "bracket.stl");
    expect(importedCap).toMatchObject({
      quantityInferred: 1,
      quantityOverride: 3,
      quantityEffective: 3,
      roleOverride: "accent",
      effectiveRole: "accent",
    });
    expect(importedCap?.units.filter((unit) => unit.completed)).toHaveLength(2);
    expect(importedBase).toMatchObject({
      quantityInferred: 2,
      quantityOverride: 154,
      quantityEffective: 154,
    });
    expect(importedBase?.units).toHaveLength(154);
    expect(importedBase?.units.some((unit) => unit.completed)).toBe(false);
    expect(importedBracket).toMatchObject({
      quantityInferred: 1,
      quantityOverride: null,
      quantityEffective: 1,
      included: false,
    });
    expect(
      accepted.snapshot.parts
        .filter((part) => part.included)
        .reduce((total, part) => total + part.units.length, 0),
    ).toBe(157);
    expect(repo.readAcceptedPlanOperationalSnapshot(plan.id)).toEqual(sourceBeforeImport);
    database.close();
  });

  it("leaves unmatched kit Parts unpublished instead of inserting working rows", () => {
    const { database, repo } = acceptedPlanFixture("ImportHost");
    const imported = repo.importKitBundle(
      {
        format: "print-partner-kit",
        version: 3,
        profile: { name: "Imported unmatched" },
        layers: [],
        parts: [
          {
            match_key: "ghost.stl",
            relative_path: "ghost.stl",
            filename: "ghost.stl",
            role: "primary",
            quantity_override: 4,
            quantity_effective: 4,
            included: true,
            print_units: [true, true],
          },
        ],
      },
      "Imported unmatched",
    );
    expect(imported.parts_imported).toBe(0);
    expect(repo.readAcceptedPlanOperationalSnapshot(imported.profile_id).kind).toBe("empty");
    expect(repo.listParts(imported.profile_id).parts).toEqual([]);
    database.close();
  });

  it("applies matched kit Sources and copies accepted printed counts", () => {
    const { database, repo, plan } = acceptedPlanFixture("ExportHost");
    const source = repo.readAcceptedPlanOperationalSnapshot(plan.id);
    if (source.kind !== "ready") throw new Error("source Plan is not ready");
    const part = source.snapshot.parts[0];
    if (!part) throw new Error("source Part is missing");
    expect(
      repo.setAcceptedPrintedCounts({
        expected: acceptedPlanBasis(source.snapshot),
        rows: [{ partId: part.projectionPartId, printedCount: 1 }],
      }).kind,
    ).toBe("updated");
    const captured = captureAcceptedOperationalExport({
      repository: repo,
      profileId: plan.id,
    });
    if (captured.kind !== "ready") throw new Error("captured export is not ready");
    const recipe = repo.readEditableKitRecipe(plan.id);
    const data = buildKitBundleData({
      mode: {
        kind: "accepted_progress",
        recipe,
        accepted: captured.export,
      },
      exportedAt: "2026-08-21T15:00:00.000Z",
    });
    const imported = repo.importKitBundle(data, "Imported matched");
    expect(imported.parts_imported).toBe(1);
    const accepted = repo.readAcceptedPlanOperationalSnapshot(imported.profile_id);
    expect(accepted.kind).toBe("ready");
    if (accepted.kind !== "ready") throw new Error("imported Plan is not ready");
    expect(accepted.snapshot.parts[0]?.filename).toBe("widget.stl");
    expect(accepted.snapshot.parts[0]?.units[0]?.completed).toBe(true);
    database.close();
  });

  it("warns and skips operational state when matched Sources cannot publish", () => {
    const { database, repo, repoPath, source } = acceptedPlanFixture("FailedImportHost");
    rmSync(join(repoPath, "parts", "widget.stl"));

    const imported = repo.importKitBundle(
      {
        format: "print-partner-kit",
        version: 3,
        profile: { name: "Failed import" },
        sources: [{ name: source.name, url: source.url }],
        layers: [
          {
            layer_order: 0,
            layer_type: "base",
            project: { name: source.name, url: source.url },
          },
        ],
        parts: [
          {
            match_key: "widget.stl",
            role: "primary",
            filament_color_id: "pla-black",
            quantity_override: 1,
            included: true,
            print_units: [true],
          },
        ],
      },
      "Failed import",
    );

    expect(imported.parts_imported).toBe(0);
    expect(imported.warnings).toContain(
      "Accepted Plan publication failed; imported filament and checkoff state was not applied.",
    );
    expect(repo.readAcceptedPlanOperationalSnapshot(imported.profile_id).kind).toBe("empty");
    database.close();
  });

  it("warns instead of silently skipping a missing imported operational target", () => {
    const { database, repo, source } = acceptedPlanFixture("MissingOverlayTargetHost");
    const imported = repo.importKitBundle(
      {
        format: "print-partner-kit",
        version: 1,
        profile: { name: "Missing overlay target" },
        layers: [
          {
            layer_order: 0,
            layer_type: "base",
            project: { name: source.name, url: source.url },
          },
        ],
        parts: [
          {
            match_key: "missing:ghost.stl",
            relative_path: "parts/ghost.stl",
            source_layer: "base:ghost",
            filament_color_id: "pla-black",
            print_units: [true],
          },
        ],
      },
      "Missing overlay target",
    );

    expect(imported.warnings).toContain(
      "Accepted Plan was published, but imported filament and checkoff state was not applied: Imported Part target is missing: missing:ghost.stl.",
    );
    const accepted = repo.readAcceptedPlanOperationalSnapshot(imported.profile_id);
    if (accepted.kind !== "ready") throw new Error("imported Plan is not ready");
    expect(accepted.snapshot.parts[0]?.filamentColorId).toBeNull();
    expect(accepted.snapshot.parts[0]?.units[0]?.completed).toBe(false);
    database.close();
  });

  it("reports an invalid overlay without applying its filament value", () => {
    const { database, repo, plan, source } = acceptedPlanFixture("InvalidOverlayHost");
    const sourceAccepted = repo.readAcceptedPlanOperationalSnapshot(plan.id);
    if (sourceAccepted.kind !== "ready") throw new Error("source Plan is not ready");
    const partKey = sourceAccepted.snapshot.parts[0]?.partKey;
    if (!partKey) throw new Error("source Part is missing");
    const imported = repo.importKitBundle(
      {
        format: "print-partner-kit",
        version: 3,
        profile: { name: "Invalid overlay" },
        layers: [
          {
            layer_order: 0,
            layer_type: "base",
            project: { name: source.name, url: source.url },
          },
        ],
        parts: [
          {
            match_key: partKey,
            filament_color_id: "pla-black",
            print_units: [true, true],
          },
        ],
      },
      "Invalid overlay",
    );

    expect(imported.warnings).toContain(
      "Accepted Plan was published, but imported filament and checkoff state was not applied: Printed count is invalid for widget.stl.",
    );
    const accepted = repo.readAcceptedPlanOperationalSnapshot(imported.profile_id);
    if (accepted.kind !== "ready") throw new Error("imported Plan is not ready");
    expect(accepted.snapshot.parts[0]?.filamentColorId).toBeNull();
    expect(accepted.snapshot.parts[0]?.units[0]?.completed).toBe(false);
    database.close();
  });
});
