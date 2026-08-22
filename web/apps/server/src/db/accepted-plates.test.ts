import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_ACCEPTED_PLATES, parseAcceptedStlMesh } from "@print-partner/domain";
import { acceptedPlanBasis } from "./accepted-plan-progress.js";
import { backfillAcceptedPlanRevisions } from "./accepted-plan-revisions.js";
import { AcceptedPlateIntegrityError } from "./accepted-plates.js";
import { getDb, SqliteDatabase } from "./client.js";
import { backfillCurrentRequiredUnitSets } from "./required-units.js";
import { AppRepository } from "./repository.js";
import * as pgSchema from "./schema-pg.js";
import { registerPostgresSyncQuery, unregisterPostgresSyncQuery } from "./sync-db-bridge.js";
import {
  arrangeAcceptedPlates,
  initializeAcceptedPlates,
  type AcceptedPlateWorkspaceDependencies,
} from "../services/accepted-plate-workspace.js";
import { parseRequiredUnitToken } from "../services/required-units.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture(firstToken = 1) {
  const root = mkdtempSync(join(tmpdir(), "pp-accepted-plates-"));
  const database = new SqliteDatabase(root);
  database.connect();
  const repo = new AppRepository(getDb(database), "default", database.reposDir, undefined, {
    clock: () => new Date("2026-08-21T16:00:00.000Z"),
  });
  const raw = (database as unknown as { sqlite: Database.Database }).sqlite;
  const profile = repo.createProfile("Accepted Plate Build");
  const insertPart = raw.prepare(
    `INSERT INTO parts (
      tenant_id, profile_id, match_key, relative_path, filename, source_layer,
      status, role, quantity_auto, quantity_effective, included, notes
    ) VALUES ('default', ?, ?, ?, ?, 'base:test', 'base', 'primary', ?, ?, ?, '')`,
  );
  insertPart.run(profile.id, "bracket.stl", "bracket.stl", "bracket.stl", 2, 2, 1);
  insertPart.run(profile.id, "optional.stl", "optional.stl", "optional.stl", 1, 1, 0);
  backfillAcceptedPlanRevisions(raw, "2026-08-21T15:00:00.000Z");
  let token = firstToken;
  backfillCurrentRequiredUnitSets(raw, {
    now: () => "2026-08-21T15:01:00.000Z",
    tokenFactory: () => `ppu_${(token++).toString(16).padStart(32, "0")}`,
  });
  const accepted = repo.readAcceptedPlanOperationalSnapshot(profile.id);
  if (accepted.kind !== "ready") throw new Error("accepted fixture is unavailable");
  const required = accepted.snapshot.parts
    .filter((part) => part.included)
    .flatMap((part) => part.units);
  const notRequired = accepted.snapshot.parts
    .filter((part) => !part.included)
    .flatMap((part) => part.units);
  cleanups.push(() => {
    database.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { database, root, repo, raw, profile, accepted: accepted.snapshot, required, notRequired };
}

function plateInput(tokens: readonly string[]) {
  return [
    {
      plateId: "plate-main",
      printerId: "printer-core-one",
      printerName: "Core One",
      printerModel: "Prusa Core One",
      bedWidthUm: 250_000,
      bedDepthUm: 220_000,
      bedHeightUm: 220_000,
      marginUm: 5_000,
      units: tokens.map((token, index) => ({
        token,
        xUm: 5_000 + index * 60_000,
        yUm: 5_000,
        widthUm: 50_000,
        depthUm: 40_000,
        heightUm: 30_000,
      })),
    },
  ];
}

function acceptedPlateRows(raw: Database.Database) {
  return {
    heads: raw.prepare("SELECT * FROM accepted_plate_heads ORDER BY profile_id").all(),
    revisions: raw.prepare("SELECT * FROM accepted_plate_revisions ORDER BY id").all(),
    plates: raw.prepare("SELECT * FROM accepted_plates ORDER BY revision_id, plate_id").all(),
    units: raw
      .prepare(
        "SELECT * FROM accepted_plate_units ORDER BY revision_id, plate_id, required_unit_token",
      )
      .all(),
  };
}

function workspaceDependencies(repo: AppRepository, reposDir: string): AcceptedPlateWorkspaceDependencies {
  return {
    repository: repo,
    reposDir,
    limits: {
      maxArtifactBytes: 1_000_000,
      maxTotalSourceBytes: 1_000_000,
      maxObjects: 10,
      maxTriangles: 10,
    },
    loadPrinters: () => [{
      id: "printer-core-one",
      name: "Core One",
      model: "Prusa Core One",
      bed_width_mm: 250,
      bed_depth_mm: 220,
      bed_height_mm: 220,
      margin_mm: 5,
      max_filament_slots: 1,
      loaded_filaments: [],
    }],
  };
}

function nextApplyCommand(
  repo: AppRepository,
  profileId: number,
  current: ReturnType<typeof acceptedPlanBasis>,
  suffix: string,
) {
  const created = repo.recomputePlanDraft({
    profileId,
    actor: "test:user",
    idempotencyKey: `accepted-plate-draft-${suffix}`,
  });
  if (created.kind !== "created") throw new Error(`accepted Plate draft was not created: ${created.kind}`);
  const decisions = created.draft.parts.map((part) => {
    if (part.baseRevisionPartId == null) throw new Error("accepted Plate predecessor is missing");
    return {
      kind: "accept_prior_completion" as const,
      targetDraftPartId: part.id,
      predecessorRevisionPartId: part.baseRevisionPartId,
    };
  });
  const reconciled = repo.savePlanDraftRequiredUnitReconciliation({
    profileId,
    draftId: created.draft.id,
    expectedSnapshotDigest: created.draft.snapshotDigest,
    decisions,
    actorId: "test:user",
    idempotencyKey: `accepted-plate-reconciliation-${suffix}`,
  });
  if (reconciled.kind !== "saved") throw new Error("accepted Plate reconciliation failed");
  return {
    profileId,
    draftId: created.draft.id,
    expectedSnapshotDigest: reconciled.draft.snapshotDigest,
    expectedLifecycleVersion: 0,
    expectedBase: {
      kind: "revision" as const,
      revisionId: current.revisionId,
      planVersion: current.planVersion,
    },
    actorId: "test:user",
    idempotencyKey: `accepted-plate-apply-${suffix}`,
  };
}

function attachLocalSource(repo: AppRepository, root: string, profileId: number, suffix: string) {
  const sourceRoot = join(root, "repos", `accepted-plate-source-${suffix}`);
  mkdirSync(sourceRoot, { recursive: true });
  writeFileSync(join(sourceRoot, "bracket.stl"), `solid bracket
facet normal 0 0 1
outer loop
vertex 0 0 0
vertex 1 0 0
vertex 0 1 1
endloop
endfacet
endsolid bracket`);
  const source = repo.createSource({
    name: `Accepted Plate source ${suffix}`,
    source_kind: "local",
    local_path: sourceRoot,
  });
  repo.setBaseLayer(profileId, source.id);
}

describe("accepted Plate repository", () => {
  it("reads exact accepted setup units and the raw current head in one snapshot", () => {
    const { repo, profile, accepted, required } = fixture();

    expect(repo.readAcceptedPlateWorkspaceInput(profile.id)).toMatchObject({
      kind: "setup",
      basis: acceptedPlanBasis(accepted),
      expectedPlateRevisionId: null,
      units: required.map((unit) => ({
        token: unit.token,
        objectName: unit.objectName,
        filename: "bracket.stl",
        sourceLayer: "base:test",
        role: "primary",
        filamentColorId: null,
      })),
    });

    const published = repo.publishAcceptedPlates({
      profileId: profile.id,
      expected: acceptedPlanBasis(accepted),
      expectedPlateRevisionId: null,
      plates: plateInput(required.map((unit) => unit.token)),
    });
    if (published.kind !== "published") throw new Error("Plate publication failed");

    expect(repo.readAcceptedPlateWorkspaceInput(profile.id)).toMatchObject({
      kind: "ready",
      expectedPlateRevisionId: published.plateRevisionId,
      plateRevisionId: published.plateRevisionId,
      plateRevisionNumber: published.plateRevisionNumber,
      units: required.map((unit) => ({ token: unit.token })),
      plates: [{ plateId: "plate-main" }],
    });
  });

  it("distinguishes a missing profile from an existing empty Plan", () => {
    const { repo } = fixture();
    const empty = repo.createProfile("Empty accepted Plan");

    expect(repo.readAcceptedPlateWorkspaceInput(999_999)).toEqual({ kind: "profile_not_found" });
    expect(repo.readAcceptedPlateWorkspaceInput(empty.id)).toEqual({ kind: "empty_plan" });
  });

  it("publishes and reads exact micrometre geometry while projecting Object names", () => {
    const { repo, raw, profile, accepted, required } = fixture();
    const result = repo.publishAcceptedPlates({
      profileId: profile.id,
      expected: acceptedPlanBasis(accepted),
      expectedPlateRevisionId: null,
      plates: plateInput(required.map((unit) => unit.token)),
    });

    expect(result).toMatchObject({ kind: "published", plateRevisionNumber: 1 });
    const read = repo.readAcceptedPlates(profile.id);
    expect(read).toMatchObject({
      kind: "ready",
      basis: acceptedPlanBasis(accepted),
      plateRevisionNumber: 1,
      plates: [
        {
          plateId: "plate-main",
          ordinal: 1,
          printerId: "printer-core-one",
          printerName: "Core One",
          printerModel: "Prusa Core One",
          bedWidthUm: 250_000,
          bedDepthUm: 220_000,
          bedHeightUm: 220_000,
          marginUm: 5_000,
          units: [
            {
              token: required[0]!.token,
              objectName: required[0]!.objectName,
              xUm: 5_000,
              yUm: 5_000,
              widthUm: 50_000,
              depthUm: 40_000,
              heightUm: 30_000,
            },
            {
              token: required[1]!.token,
              objectName: required[1]!.objectName,
              xUm: 65_000,
              yUm: 5_000,
              widthUm: 50_000,
              depthUm: 40_000,
              heightUm: 30_000,
            },
          ],
        },
      ],
    });
    const storedUnitColumns = (
      raw.pragma("table_info(accepted_plate_units)") as { name: string }[]
    ).map((column) => column.name);
    expect(storedUnitColumns).not.toContain("object_name");
    expect(storedUnitColumns).not.toContain("rotation");
    expect(
      (raw.pragma("table_info(accepted_plates)") as { name: string; notnull: number }[]).find(
        (column) => column.name === "bed_height_um",
      )?.notnull,
    ).toBe(1);
  });

  it("reads a pre-v30 format-1 Plate digest with legacy auto and unpinned defaults", () => {
    const { repo, raw, profile, accepted, required } = fixture();
    const plates = plateInput(required.map((unit) => unit.token));
    const published = repo.publishAcceptedPlates({
      profileId: profile.id,
      expected: acceptedPlanBasis(accepted),
      expectedPlateRevisionId: null,
      plates,
    });
    if (published.kind !== "published") throw new Error("Plate publish failed");
    plates[0]!.units[1]!.xUm = 55_000;
    const legacyCanonical = {
      format: 1,
      plates: plates.map((plate, index) => ({
        ordinal: index + 1,
        plateId: plate.plateId,
        printerId: plate.printerId,
        printerName: plate.printerName,
        printerModel: plate.printerModel,
        bedWidthUm: plate.bedWidthUm,
        bedDepthUm: plate.bedDepthUm,
        bedHeightUm: plate.bedHeightUm,
        marginUm: plate.marginUm,
        units: [...plate.units].sort((left, right) => left.token.localeCompare(right.token)).map((unit) => ({
          token: unit.token,
          xUm: unit.xUm,
          yUm: unit.yUm,
          widthUm: unit.widthUm,
          depthUm: unit.depthUm,
          heightUm: unit.heightUm,
        })),
      })),
    };
    const legacyDigest = createHash("sha256").update(JSON.stringify(legacyCanonical)).digest("hex");
    raw.exec(`
      DROP TRIGGER trg_accepted_plate_revisions_immutable_update;
      DROP TRIGGER trg_accepted_plate_units_immutable_update;
    `);
    raw.prepare("UPDATE accepted_plate_units SET x_um = ? WHERE revision_id = ? AND required_unit_token = ?")
      .run(55_000, published.plateRevisionId, required[1]!.token);
    raw.prepare("UPDATE accepted_plate_revisions SET layout_digest = ? WHERE id = ?")
      .run(legacyDigest, published.plateRevisionId);

    expect(repo.readAcceptedPlates(profile.id)).toMatchObject({
      kind: "ready",
      plates: [{ units: [
        { placement: "auto", pinned: false },
        { placement: "auto", pinned: false, xUm: 55_000 },
      ] }],
    });
  });

  it("preserves publication order as an immutable Plate ordinal", () => {
    const { repo, profile, accepted, required } = fixture();
    const plates = plateInput(required.map((unit) => unit.token));
    const first = plates[0]!;
    const published = repo.publishAcceptedPlates({
      profileId: profile.id,
      expected: acceptedPlanBasis(accepted),
      expectedPlateRevisionId: null,
      plates: [
        { ...first, plateId: "z-first" },
        { ...first, plateId: "a-second", units: [] },
      ],
    });
    expect(published).toMatchObject({ kind: "published" });

    const read = repo.readAcceptedPlates(profile.id);
    expect(read.kind).toBe("ready");
    if (read.kind !== "ready") throw new Error("Plate read failed");
    expect(read.plates.map((plate) => [plate.plateId, plate.ordinal])).toEqual([
      ["z-first", 1],
      ["a-second", 2],
    ]);

    if (published.kind !== "published") throw new Error("Plate publish failed");
    expect(
      repo.moveAcceptedPlateUnit({
        profileId: profile.id,
        expected: acceptedPlanBasis(accepted),
        expectedPlateRevisionId: published.plateRevisionId,
        plateId: "z-first",
        token: required[0]!.token,
        xUm: 6_000,
        yUm: 5_000,
      }),
    ).toMatchObject({ kind: "moved" });
    const moved = repo.readAcceptedPlates(profile.id);
    expect(moved.kind).toBe("ready");
    if (moved.kind !== "ready") throw new Error("Plate read failed");
    expect(moved.plates.map((plate) => [plate.plateId, plate.ordinal])).toEqual([
      ["z-first", 1],
      ["a-second", 2],
    ]);
  });

  it("resolves one immutable export input with accepted artifacts and stored ordinal order", () => {
    const { repo, profile, accepted, required } = fixture();
    const first = plateInput(required.map((unit) => unit.token))[0]!;
    const published = repo.publishAcceptedPlates({
      profileId: profile.id,
      expected: acceptedPlanBasis(accepted),
      expectedPlateRevisionId: null,
      plates: [
        { ...first, plateId: "z-first" },
        { ...first, plateId: "a-second", units: [] },
      ],
    });
    if (published.kind !== "published") throw new Error("Plate publish failed");

    const resolved = repo.readAcceptedPlateExportInput(profile.id);
    expect(resolved.kind).toBe("ready");
    if (resolved.kind !== "ready") throw new Error("Plate export input failed");
    expect(resolved.input).toMatchObject({
      basis: acceptedPlanBasis(accepted),
      plateRevisionId: published.plateRevisionId,
      plateRevisionNumber: 1,
      plates: [
        {
          plateId: "z-first",
          ordinal: 1,
          printerId: "printer-core-one",
          printerName: "Core One",
          printerModel: "Prusa Core One",
          bedWidthUm: 250_000,
          bedDepthUm: 220_000,
          bedHeightUm: 220_000,
          marginUm: 5_000,
          units: [
            { widthUm: 50_000, depthUm: 40_000, heightUm: 30_000, artifact: { kind: "unavailable", reason: "legacy" } },
            { widthUm: 50_000, depthUm: 40_000, heightUm: 30_000, artifact: { kind: "unavailable", reason: "legacy" } },
          ],
        },
        { plateId: "a-second", ordinal: 2, units: [] },
      ],
    });
    expect(resolved.input.layoutDigest).toMatch(/^[a-f0-9]{64}$/);

    expect(repo.moveAcceptedPlateUnit({
      profileId: profile.id,
      expected: acceptedPlanBasis(accepted),
      expectedPlateRevisionId: published.plateRevisionId,
      plateId: "z-first",
      token: required[0]!.token,
      xUm: 6_000,
      yUm: 5_000,
    })).toMatchObject({ kind: "moved" });
    expect(resolved.input.plates[0]!.units[0]!.xUm).toBe(5_000);
  });

  it("blocks accepted export while any Required unit is unplaced", () => {
    const { repo, profile, accepted, required } = fixture();
    const basis = acceptedPlanBasis(accepted);
    const published = repo.publishAcceptedPlates({
      profileId: profile.id,
      expected: basis,
      expectedPlateRevisionId: null,
      plates: plateInput(required.map((unit) => unit.token)),
    });
    if (published.kind !== "published") throw new Error("Plate publish failed");
    const unplaced = repo.unplaceAcceptedPlateUnit({
      profileId: profile.id,
      expected: basis,
      expectedPlateRevisionId: published.plateRevisionId,
      plateId: "plate-main",
      token: required[0]!.token,
    });
    if (unplaced.kind !== "moved") throw new Error("Plate unplace failed");

    expect(repo.readAcceptedPlateExportInput(profile.id)).toEqual({ kind: "unplaced_units" });
  });

  it("makes exact publication retries idempotent and stale changes compare-and-swap", () => {
    const { repo, raw, profile, accepted, required } = fixture();
    const basis = acceptedPlanBasis(accepted);
    const plates = plateInput(required.map((unit) => unit.token));
    const first = repo.publishAcceptedPlates({
      profileId: profile.id,
      expected: basis,
      expectedPlateRevisionId: null,
      plates,
    });
    if (first.kind !== "published") throw new Error("Plate publish failed");
    const before = acceptedPlateRows(raw);

    expect(
      repo.publishAcceptedPlates({
        profileId: profile.id,
        expected: basis,
        expectedPlateRevisionId: null,
        plates,
      }),
    ).toEqual({
      kind: "unchanged",
      plateRevisionId: first.plateRevisionId,
      plateRevisionNumber: first.plateRevisionNumber,
    });
    expect(acceptedPlateRows(raw)).toEqual(before);

    const changed = structuredClone(plates);
    changed[0]!.units[0]!.xUm += 1;
    expect(
      repo.publishAcceptedPlates({
        profileId: profile.id,
        expected: basis,
        expectedPlateRevisionId: null,
        plates: changed,
      }),
    ).toEqual({ kind: "plate_revision_changed" });
    expect(acceptedPlateRows(raw)).toEqual(before);

    expect(
      repo.publishAcceptedPlates({
        profileId: profile.id,
        expected: basis,
        expectedPlateRevisionId: first.plateRevisionId,
        plates: changed,
      }),
    ).toMatchObject({ kind: "published", plateRevisionNumber: 2 });
  });

  it("requires full positive build volume and PostgreSQL-sized coordinates", () => {
    const { repo, raw, profile, accepted, required } = fixture();
    const basis = acceptedPlanBasis(accepted);
    const tooLarge = plateInput(required.map((unit) => unit.token));
    tooLarge[0]!.bedWidthUm = 2_147_483_648;
    for (const plates of [tooLarge]) {
      const before = acceptedPlateRows(raw);
      expect(
        repo.publishAcceptedPlates({
          profileId: profile.id,
          expected: basis,
          expectedPlateRevisionId: null,
          plates,
        }),
      ).toEqual({ kind: "invalid_geometry", reason: "outside_build_area" });
      expect(acceptedPlateRows(raw)).toEqual(before);
    }
  });

  it("rejects one Plate beyond the classic ZIP-safe publication ceiling without writes", () => {
    const { repo, raw, profile, accepted, required } = fixture();
    const base = plateInput(required.map((unit) => unit.token))[0]!;
    const before = acceptedPlateRows(raw);
    const plates = Array.from({ length: MAX_ACCEPTED_PLATES + 1 }, (_, index) => ({
      ...base,
      plateId: `plate-${index + 1}`,
      units: index === 0 ? base.units : [],
    }));
    expect(repo.publishAcceptedPlates({
      profileId: profile.id,
      expected: acceptedPlanBasis(accepted),
      expectedPlateRevisionId: null,
      plates,
    })).toEqual({ kind: "invalid_units" });
    expect(acceptedPlateRows(raw)).toEqual(before);
  });

  it("admits the exact ZIP-safe Plate count to publication while rolling back an injected stop", () => {
    const { repo, raw, profile, accepted, required } = fixture();
    const base = plateInput(required.map((unit) => unit.token))[0]!;
    const before = acceptedPlateRows(raw);
    raw.exec(`CREATE TRIGGER stop_boundary_plate_publication
      BEFORE INSERT ON accepted_plate_revisions
      BEGIN
        SELECT RAISE(ABORT, 'injected boundary stop');
      END`);
    const plates = Array.from({ length: MAX_ACCEPTED_PLATES }, (_, index) => ({
      ...base,
      plateId: `boundary-${index + 1}`,
      units: index === 0 ? base.units : [],
    }));
    expect(() => repo.publishAcceptedPlates({
      profileId: profile.id,
      expected: acceptedPlanBasis(accepted),
      expectedPlateRevisionId: null,
      plates,
    })).toThrow(/injected boundary stop/i);
    expect(acceptedPlateRows(raw)).toEqual(before);
  }, 20_000);

  it("blocks direct immutable history deletion while the Build exists", () => {
    const { repo, raw, profile, accepted, required } = fixture();
    expect(
      repo.publishAcceptedPlates({
        profileId: profile.id,
        expected: acceptedPlanBasis(accepted),
        expectedPlateRevisionId: null,
        plates: plateInput(required.map((unit) => unit.token)),
      }),
    ).toMatchObject({ kind: "published" });

    expect(() =>
      raw.prepare(`INSERT INTO accepted_plates (
        tenant_id, revision_id, plate_id, ordinal, printer_id, printer_name, printer_model,
        bed_width_um, bed_depth_um, bed_height_um, margin_um
      ) SELECT tenant_id, revision_id, 'late-plate', 2, printer_id, printer_name, printer_model,
               bed_width_um, bed_depth_um, bed_height_um, margin_um
          FROM accepted_plates LIMIT 1`).run(),
    ).toThrow(/ownership/i);
    for (const statement of [
      "UPDATE accepted_plate_units SET x_um = x_um + 1",
      "UPDATE accepted_plates SET printer_name = 'Changed'",
      "UPDATE accepted_plate_revisions SET created_at = 'changed'",
    ]) {
      expect(() => raw.prepare(statement).run()).toThrow(/immutable/i);
    }
    for (const table of ["accepted_plate_units", "accepted_plates", "accepted_plate_revisions"]) {
      expect(() => raw.prepare(`DELETE FROM ${table}`).run()).toThrow(/immutable/i);
    }
  });

  it.each([
    {
      label: "removed unit",
      corrupt(raw: Database.Database) {
        raw.exec("DROP TRIGGER trg_accepted_plate_units_immutable_delete");
        raw.prepare("DELETE FROM accepted_plate_units WHERE required_unit_token = (SELECT required_unit_token FROM accepted_plate_units LIMIT 1)").run();
      },
      code: "counts",
    },
    {
      label: "orphan unit",
      corrupt(raw: Database.Database) {
        raw.exec("DROP TRIGGER trg_accepted_plate_units_immutable_update");
        raw.prepare("UPDATE accepted_plate_units SET plate_id = 'missing-plate' WHERE required_unit_token = (SELECT required_unit_token FROM accepted_plate_units LIMIT 1)").run();
      },
      code: "layout",
    },
    {
      label: "extra Plate",
      corrupt(raw: Database.Database) {
        raw.exec("DROP TRIGGER trg_accepted_plates_ownership_insert");
        raw.prepare(`INSERT INTO accepted_plates (
          tenant_id, revision_id, plate_id, ordinal, printer_id, printer_name, printer_model,
          bed_width_um, bed_depth_um, bed_height_um, margin_um
        ) SELECT tenant_id, revision_id, 'extra-plate', 2, printer_id, printer_name, printer_model,
                 bed_width_um, bed_depth_um, bed_height_um, margin_um
            FROM accepted_plates LIMIT 1`).run();
      },
      code: "counts",
    },
    {
      label: "tenant-mismatched unit",
      corrupt(raw: Database.Database) {
        raw.exec("DROP TRIGGER trg_accepted_plate_units_immutable_update");
        raw.prepare("UPDATE accepted_plate_units SET tenant_id = 'other' WHERE required_unit_token = (SELECT required_unit_token FROM accepted_plate_units LIMIT 1)").run();
      },
      code: "layout",
    },
    {
      label: "digest mismatch",
      corrupt(raw: Database.Database) {
        raw.exec("DROP TRIGGER trg_accepted_plate_units_immutable_update");
        raw.prepare("UPDATE accepted_plate_units SET x_um = x_um + 1 WHERE required_unit_token = (SELECT required_unit_token FROM accepted_plate_units LIMIT 1)").run();
      },
      code: "layout_digest",
    },
  ] satisfies readonly {
    label: string;
    corrupt: (raw: Database.Database) => void;
    code: AcceptedPlateIntegrityError["code"];
  }[])("rejects $label corruption with a typed integrity error", ({ corrupt, code }) => {
    const { repo, raw, profile, accepted, required } = fixture();
    expect(
      repo.publishAcceptedPlates({
        profileId: profile.id,
        expected: acceptedPlanBasis(accepted),
        expectedPlateRevisionId: null,
        plates: plateInput(required.map((unit) => unit.token)),
      }),
    ).toMatchObject({ kind: "published" });
    corrupt(raw);

    expect(() => repo.readAcceptedPlates(profile.id)).toThrowError(
      expect.objectContaining<Partial<AcceptedPlateIntegrityError>>({ code }),
    );
  });

  it("rolls back a publication failure after inserting its revision", () => {
    const { repo, raw, profile, accepted, required } = fixture();
    const before = acceptedPlateRows(raw);
    raw.exec(`CREATE TRIGGER fail_accepted_plate_insert
      BEFORE INSERT ON accepted_plates
      BEGIN
        SELECT RAISE(ABORT, 'injected accepted Plate insert failure');
      END`);

    expect(() =>
      repo.publishAcceptedPlates({
        profileId: profile.id,
        expected: acceptedPlanBasis(accepted),
        expectedPlateRevisionId: null,
        plates: plateInput(required.map((unit) => unit.token)),
      }),
    ).toThrow(/injected accepted Plate insert failure/i);
    expect(acceptedPlateRows(raw)).toEqual(before);
  });

  it("serializes barrier-released publishers on two connections against one expected head", async () => {
    const { root, raw, profile, accepted, required } = fixture();
    const basis = acceptedPlanBasis(accepted);
    const layouts = [plateInput(required.map((unit) => unit.token)), plateInput(required.map((unit) => unit.token))];
    layouts[1]![0]!.units[0]!.xUm += 1;
    const startPath = join(root, "publishers-start");
    const children = layouts.map((plates, index) => {
      const readyPath = join(root, `publisher-${index}-ready`);
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          `import { existsSync, writeFileSync } from "node:fs";
import { getDb, SqliteDatabase } from "./src/db/client.ts";
import { AppRepository } from "./src/db/repository.ts";
const database = new SqliteDatabase(process.argv[1]);
database.connect();
const repo = new AppRepository(getDb(database), "default", database.reposDir);
writeFileSync(process.argv[5], "ready");
while (!existsSync(process.argv[6])) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
const result = repo.publishAcceptedPlates({
  profileId: Number(process.argv[2]),
  expected: JSON.parse(process.argv[3]),
  expectedPlateRevisionId: null,
  plates: JSON.parse(process.argv[4]),
});
process.stdout.write(JSON.stringify(result));
database.close();`,
          root,
          String(profile.id),
          JSON.stringify(basis),
          JSON.stringify(plates),
          readyPath,
          startPath,
        ],
        { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      let error = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        error += chunk.toString("utf8");
      });
      return { child, readyPath, output: () => output, error: () => error };
    });
    const deadline = Date.now() + 15_000;
    while (children.some(({ readyPath }) => !existsSync(readyPath))) {
      if (Date.now() >= deadline) {
        throw new Error(children.map(({ error }) => error()).join("\n"));
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    writeFileSync(startPath, "start");
    const exits = await Promise.all(children.map(({ child }) => once(child, "exit")));
    expect(exits.map(([code]) => code)).toEqual([0, 0]);
    const results = children.map(({ output }) => JSON.parse(output()));
    expect(results.map((result) => result.kind).sort()).toEqual([
      "plate_revision_changed",
      "published",
    ]);
    expect(acceptedPlateRows(raw).revisions).toHaveLength(1);
  }, 20_000);

  it("projects a defensively restored historical head as setup for the current accepted basis", () => {
    const { root, repo, raw, profile, accepted, required } = fixture();
    const basisA = acceptedPlanBasis(accepted);
    const published = repo.publishAcceptedPlates({
      profileId: profile.id,
      expected: basisA,
      expectedPlateRevisionId: null,
      plates: plateInput(required.map((unit) => unit.token)),
    });
    if (published.kind !== "published") throw new Error("Plate publish failed");
    attachLocalSource(repo, root, profile.id, "stale-head");
    const command = nextApplyCommand(repo, profile.id, basisA, "stale-head");
    const secondDatabase = new SqliteDatabase(root);
    secondDatabase.connect();
    cleanups.push(() => secondDatabase.close());
    const secondRepo = new AppRepository(getDb(secondDatabase), "default", secondDatabase.reposDir);
    expect(secondRepo.applyPlanChanges(command)).toMatchObject({ kind: "applied" });
    raw.prepare(
      "INSERT INTO accepted_plate_heads (tenant_id, profile_id, current_revision_id) VALUES ('default', ?, ?)",
    ).run(profile.id, published.plateRevisionId);
    const basisB = repo.readAcceptedPlanOperationalSnapshot(profile.id);
    if (basisB.kind !== "ready") throw new Error("accepted basis B is unavailable");

    expect(repo.readAcceptedPlateWorkspaceInput(profile.id)).toMatchObject({
      kind: "setup",
      basis: acceptedPlanBasis(basisB.snapshot),
      expectedPlateRevisionId: published.plateRevisionId,
    });
  });

  it("rejects initialization when Apply commits during artifact loading without recreating the head", async () => {
    const { root, repo, raw, profile, accepted, required } = fixture();
    const basisA = acceptedPlanBasis(accepted);
    const published = repo.publishAcceptedPlates({
      profileId: profile.id,
      expected: basisA,
      expectedPlateRevisionId: null,
      plates: plateInput(required.map((unit) => unit.token)),
    });
    if (published.kind !== "published") throw new Error("Plate publish failed");
    const before = acceptedPlateRows(raw);
    attachLocalSource(repo, root, profile.id, "apply-race");
    const applyCommand = nextApplyCommand(repo, profile.id, basisA, "apply-race");
    const secondDatabase = new SqliteDatabase(root);
    secondDatabase.connect();
    cleanups.push(() => secondDatabase.close());
    const secondRepo = new AppRepository(getDb(secondDatabase), "default", secondDatabase.reposDir);
    const mesh = parseAcceptedStlMesh(Buffer.from(`solid geometry
facet normal 0 0 1
outer loop
vertex 0 0 0
vertex 50 0 0
vertex 0 40 30
endloop
endfacet
endsolid geometry`));
    if (!mesh) throw new Error("Apply race geometry is invalid");
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const loading = new Promise<void>((resolve) => {
      started = resolve;
    });
    const dependencies = {
      repository: repo,
      reposDir: repo.reposDir,
      limits: {
        maxArtifactBytes: 1_000_000,
        maxTotalSourceBytes: 1_000_000,
        maxObjects: 10,
        maxTriangles: 10,
      },
      loadPrinters: () => [{
        id: "printer-core-one",
        name: "Core One",
        model: "Prusa Core One",
        bed_width_mm: 250,
        bed_depth_mm: 220,
        bed_height_mm: 220,
        margin_mm: 5,
        max_filament_slots: 1,
        loaded_filaments: [],
      }],
      loadGeometry: async () => {
        started();
        await released;
        return {
          kind: "ready" as const,
          geometryByToken: new Map(required.map((unit) => [
            parseRequiredUnitToken(unit.token),
            { mesh, dimensions: { widthUm: 50_000, depthUm: 40_000, heightUm: 30_000 } },
          ])),
        };
      },
    } satisfies AcceptedPlateWorkspaceDependencies;
    const initialization = initializeAcceptedPlates(dependencies, {
      profileId: profile.id,
      expected: basisA,
      expectedPlateRevisionId: published.plateRevisionId,
      assignments: required.map((unit) => ({
        token: parseRequiredUnitToken(unit.token),
        printerId: "printer-core-one",
      })),
    });
    await loading;

    expect(secondRepo.applyPlanChanges(applyCommand)).toMatchObject({ kind: "applied" });
    expect(raw.prepare("SELECT COUNT(*) FROM accepted_plate_heads").pluck().get()).toBe(0);
    release();
    await expect(initialization).resolves.toEqual({ kind: "stale_accepted_plan" });

    const after = acceptedPlateRows(raw);
    expect(after.heads).toEqual([]);
    expect(after.revisions).toEqual(before.revisions);
    expect(after.plates).toEqual(before.plates);
    expect(after.units).toEqual(before.units);
  });

  it("makes another tenant's Plate state indistinguishable from missing state", () => {
    const { database, repo, raw, profile, accepted, required } = fixture();
    const basis = acceptedPlanBasis(accepted);
    const published = repo.publishAcceptedPlates({
      profileId: profile.id,
      expected: basis,
      expectedPlateRevisionId: null,
      plates: plateInput(required.map((unit) => unit.token)),
    });
    if (published.kind !== "published") throw new Error("Plate publish failed");
    const otherRepo = new AppRepository(getDb(database), "other", database.reposDir);
    const before = acceptedPlateRows(raw);

    expect(otherRepo.readAcceptedPlates(profile.id)).toEqual(otherRepo.readAcceptedPlates(999_999));
    expect(
      otherRepo.publishAcceptedPlates({
        profileId: profile.id,
        expected: basis,
        expectedPlateRevisionId: published.plateRevisionId,
        plates: plateInput(required.map((unit) => unit.token)),
      }),
    ).toEqual({ kind: "stale_accepted_plan" });
    expect(
      otherRepo.moveAcceptedPlateUnit({
        profileId: profile.id,
        expected: basis,
        expectedPlateRevisionId: published.plateRevisionId,
        plateId: "plate-main",
        token: required[0]!.token,
        xUm: 6_000,
        yUm: 5_000,
      }),
    ).toEqual({ kind: "stale_accepted_plan" });
    expect(acceptedPlateRows(raw)).toEqual(before);
  });

  it.each([
    ["duplicate", (tokens: string[]) => plateInput([tokens[0]!, tokens[0]!])],
    ["invented", (tokens: string[]) => plateInput([tokens[0]!, "ppu_ffffffffffffffffffffffffffffffff"])],
  ])("rejects %s token coverage without writing", (_label, arrange) => {
    const { repo, raw, profile, accepted, required } = fixture();
    const before = acceptedPlateRows(raw);
    expect(
      repo.publishAcceptedPlates({
        profileId: profile.id,
        expected: acceptedPlanBasis(accepted),
        expectedPlateRevisionId: null,
        plates: arrange(required.map((unit) => unit.token)),
      }),
    ).toEqual({ kind: "invalid_units" });
    expect(acceptedPlateRows(raw)).toEqual(before);
  });

  it("publishes and reads a selected Required-unit subset", () => {
    const { repo, profile, accepted, required } = fixture();
    const selected = required[0];
    if (!selected) throw new Error("Required unit is missing");

    expect(repo.publishAcceptedPlates({
      profileId: profile.id,
      expected: acceptedPlanBasis(accepted),
      expectedPlateRevisionId: null,
      plates: plateInput([selected.token]),
    })).toMatchObject({ kind: "published" });

    expect(repo.readAcceptedPlates(profile.id)).toMatchObject({
      kind: "ready",
      plates: [{ units: [{ token: selected.token }] }],
    });
  });

  it("rejects a not-required token and a token from another Build without writing", () => {
    const first = fixture();
    const foreign = fixture(100);
    const cases = [first.notRequired[0]!.token, foreign.required[0]!.token];
    for (const token of cases) {
      const before = acceptedPlateRows(first.raw);
      expect(
        first.repo.publishAcceptedPlates({
          profileId: first.profile.id,
          expected: acceptedPlanBasis(first.accepted),
          expectedPlateRevisionId: null,
          plates: plateInput([first.required[0]!.token, token]),
        }),
      ).toEqual({ kind: "invalid_units" });
      expect(acceptedPlateRows(first.raw)).toEqual(before);
    }
  });

  it("rejects a stale accepted basis without writing", () => {
    const { repo, raw, profile, accepted, required } = fixture();
    const before = acceptedPlateRows(raw);
    const stale = { ...acceptedPlanBasis(accepted), revisionDigest: "f".repeat(64) };
    expect(
      repo.publishAcceptedPlates({
        profileId: profile.id,
        expected: stale,
        expectedPlateRevisionId: null,
        plates: plateInput(required.map((unit) => unit.token)),
      }),
    ).toEqual({ kind: "stale_accepted_plan" });
    expect(acceptedPlateRows(raw)).toEqual(before);
  });

  it("moves one token by copying the full immutable Plate revision", () => {
    const { repo, raw, profile, accepted, required } = fixture();
    const published = repo.publishAcceptedPlates({
      profileId: profile.id,
      expected: acceptedPlanBasis(accepted),
      expectedPlateRevisionId: null,
      plates: plateInput(required.map((unit) => unit.token)),
    });
    if (published.kind !== "published") throw new Error("Plate publish failed");

    const moved = repo.moveAcceptedPlateUnit({
      profileId: profile.id,
      expected: acceptedPlanBasis(accepted),
      expectedPlateRevisionId: published.plateRevisionId,
      plateId: "plate-main",
      token: required[1]!.token,
      xUm: 70_000,
      yUm: 10_000,
    });
    expect(moved).toMatchObject({ kind: "moved", plateRevisionNumber: 2 });
    const read = repo.readAcceptedPlates(profile.id);
    expect(read.kind).toBe("ready");
    if (read.kind !== "ready") throw new Error("Plate read failed");
    expect(read.plates[0]!.units).toMatchObject([
      { token: required[0]!.token, xUm: 5_000, yUm: 5_000, heightUm: 30_000 },
      { token: required[1]!.token, xUm: 70_000, yUm: 10_000, heightUm: 30_000 },
    ]);
    expect(
      raw.prepare("SELECT count(*) AS count FROM accepted_plate_revisions").get(),
    ).toEqual({ count: 2 });
    expect(
      raw.prepare("SELECT count(*) AS count FROM accepted_plate_units").get(),
    ).toEqual({ count: 4 });
  });

  it("returns unchanged for an exact repeated move and rejects a stale Plate revision", () => {
    const { repo, raw, profile, accepted, required } = fixture();
    const published = repo.publishAcceptedPlates({
      profileId: profile.id,
      expected: acceptedPlanBasis(accepted),
      expectedPlateRevisionId: null,
      plates: plateInput(required.map((unit) => unit.token)),
    });
    if (published.kind !== "published") throw new Error("Plate publish failed");
    const before = acceptedPlateRows(raw);

    expect(
      repo.moveAcceptedPlateUnit({
        profileId: profile.id,
        expected: acceptedPlanBasis(accepted),
        expectedPlateRevisionId: published.plateRevisionId,
        plateId: "plate-main",
        token: required[0]!.token,
        xUm: 5_000,
        yUm: 5_000,
      }),
    ).toEqual({
      kind: "unchanged",
      plateRevisionId: published.plateRevisionId,
      plateRevisionNumber: 1,
    });
    expect(acceptedPlateRows(raw)).toEqual(before);

    expect(
      repo.moveAcceptedPlateUnit({
        profileId: profile.id,
        expected: acceptedPlanBasis(accepted),
        expectedPlateRevisionId: published.plateRevisionId + 1,
        plateId: "plate-main",
        token: required[0]!.token,
        xUm: 6_000,
        yUm: 5_000,
      }),
    ).toEqual({ kind: "plate_revision_changed" });
    expect(acceptedPlateRows(raw)).toEqual(before);
  });

  it("keeps placement provenance separate from pin state across edits", () => {
    const { repo, profile, accepted, required } = fixture();
    const basis = acceptedPlanBasis(accepted);
    const published = repo.publishAcceptedPlates({
      profileId: profile.id,
      expected: basis,
      expectedPlateRevisionId: null,
      plates: plateInput(required.map((unit) => unit.token)),
    });
    if (published.kind !== "published") throw new Error("Plate publish failed");
    const pinned = repo.pinAcceptedPlateUnit({
      profileId: profile.id,
      expected: basis,
      expectedPlateRevisionId: published.plateRevisionId,
      plateId: "plate-main",
      token: required[0]!.token,
      pinned: true,
    });
    if (pinned.kind !== "moved") throw new Error("Plate pin failed");
    const moved = repo.moveAcceptedPlateUnit({
      profileId: profile.id,
      expected: basis,
      expectedPlateRevisionId: pinned.plateRevisionId,
      plateId: "plate-main",
      token: required[0]!.token,
      xUm: 10_000,
      yUm: 10_000,
    });
    if (moved.kind !== "moved") throw new Error("Plate move failed");
    const movedLayout = repo.readAcceptedPlates(profile.id);
    if (movedLayout.kind !== "ready") throw new Error("Plate read failed");
    expect(movedLayout.plates[0]?.units.find((unit) => unit.token === required[0]!.token)).toMatchObject({
      placement: "manual",
      pinned: true,
    });
    const unplaced = repo.unplaceAcceptedPlateUnit({
      profileId: profile.id,
      expected: basis,
      expectedPlateRevisionId: moved.plateRevisionId,
      plateId: "plate-main",
      token: required[0]!.token,
    });
    expect(unplaced).toMatchObject({ kind: "moved", plateRevisionNumber: 4 });
    const unplacedLayout = repo.readAcceptedPlates(profile.id);
    if (unplacedLayout.kind !== "ready") throw new Error("Plate read failed");
    expect(unplacedLayout.plates[0]?.units.find((unit) => unit.token === required[0]!.token)).toMatchObject({
      placement: "unplaced",
      pinned: false,
    });
  });

  it("creates a new target Plate when dimensions fit even if stale source coordinates do not", () => {
    const { repo, profile, accepted, required } = fixture();
    const basis = acceptedPlanBasis(accepted);
    const published = repo.publishAcceptedPlates({
      profileId: profile.id,
      expected: basis,
      expectedPlateRevisionId: null,
      plates: plateInput(required.map((unit) => unit.token)),
    });
    if (published.kind !== "published") throw new Error("Plate publish failed");
    const transferred = repo.transferAcceptedPlateUnit({
      profileId: profile.id,
      expected: basis,
      expectedPlateRevisionId: published.plateRevisionId,
      plateId: "plate-main",
      token: required[1]!.token,
      targetPrinter: {
        printerId: "printer-core-one",
        printerName: "Core One",
        printerModel: "Prusa Core One",
        bedWidthUm: 60_000,
        bedDepthUm: 50_000,
        bedHeightUm: 30_000,
        marginUm: 5_000,
      },
    });
    expect(transferred).toMatchObject({ kind: "moved", plateRevisionNumber: 2 });
    expect(repo.readAcceptedPlates(profile.id)).toMatchObject({
      kind: "ready",
      plates: [
        { plateId: "plate-main", units: [{ token: required[0]!.token }] },
        {
          printerId: "printer-core-one",
          bedWidthUm: 60_000,
          units: [{ token: required[1]!.token, placement: "unplaced" }],
        },
      ],
    });
    const ready = repo.readAcceptedPlates(profile.id);
    if (ready.kind !== "ready") throw new Error("Plate read failed");
    expect(ready.plates[1]!.plateId).not.toBe("plate-main");
  });

  it("appends undo and later edits without reusing revision numbers", () => {
    const { repo, raw, profile, accepted, required, root } = fixture();
    const basis = acceptedPlanBasis(accepted);
    const initialPlates = plateInput(required.map((unit) => unit.token));
    initialPlates[0]!.plateId = "plate_00000000000000000000000000000001";
    const published = repo.publishAcceptedPlates({
      profileId: profile.id,
      expected: basis,
      expectedPlateRevisionId: null,
      plates: initialPlates,
    });
    if (published.kind !== "published") throw new Error("Plate publish failed");
    const arranged = arrangeAcceptedPlates(workspaceDependencies(repo, join(root, "repos")), {
      profileId: profile.id,
      expected: basis,
      expectedPlateRevisionId: published.plateRevisionId,
      mode: "all",
    });
    if (arranged.kind !== "workspace" || arranged.workspace.kind !== "ready") {
      throw new Error("Plate arrangement failed");
    }
    expect(arranged.workspace.arrange_undo_revision_id).toBe(published.plateRevisionId);
    const restored = repo.restoreAcceptedPlates({
      profileId: profile.id,
      expected: basis,
      expectedPlateRevisionId: arranged.workspace.plate_revision_id,
      restorePlateRevisionId: published.plateRevisionId,
    });
    expect(restored).toMatchObject({ kind: "restored", plateRevisionNumber: 3 });
    if (restored.kind !== "restored") throw new Error("Plate restore failed");
    expect(restored.plateRevisionId).not.toBe(published.plateRevisionId);

    const moved = repo.moveAcceptedPlateUnit({
      profileId: profile.id,
      expected: basis,
      expectedPlateRevisionId: restored.plateRevisionId,
      plateId: initialPlates[0]!.plateId,
      token: required[0]!.token,
      xUm: 10_000,
      yUm: 10_000,
    });
    if (moved.kind !== "moved") throw new Error("Plate move failed");
    const pinned = repo.pinAcceptedPlateUnit({
      profileId: profile.id,
      expected: basis,
      expectedPlateRevisionId: moved.plateRevisionId,
      plateId: initialPlates[0]!.plateId,
      token: required[0]!.token,
      pinned: true,
    });
    if (pinned.kind !== "moved") throw new Error("Plate pin failed");
    const unplaced = repo.unplaceAcceptedPlateUnit({
      profileId: profile.id,
      expected: basis,
      expectedPlateRevisionId: pinned.plateRevisionId,
      plateId: initialPlates[0]!.plateId,
      token: required[0]!.token,
    });
    if (unplaced.kind !== "moved") throw new Error("Plate unplace failed");
    expect(repo.transferAcceptedPlateUnit({
      profileId: profile.id,
      expected: basis,
      expectedPlateRevisionId: unplaced.plateRevisionId,
      plateId: initialPlates[0]!.plateId,
      token: required[1]!.token,
      targetPrinter: {
        printerId: "printer-core-one",
        printerName: "Core One",
        printerModel: "Prusa Core One",
        bedWidthUm: 250_000,
        bedDepthUm: 220_000,
        bedHeightUm: 220_000,
        marginUm: 5_000,
      },
    })).toMatchObject({ kind: "moved", plateRevisionNumber: 7 });
    expect(
      raw.prepare("SELECT revision_number FROM accepted_plate_revisions ORDER BY revision_number").pluck().all(),
    ).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("enforces exact bounds and rejects one micrometre outside or an overlap", () => {
    const { repo, raw, profile, accepted, required } = fixture();
    const basis = acceptedPlanBasis(accepted);
    const exact = plateInput(required.map((unit) => unit.token));
    exact[0]!.units[1]!.xUm = 195_000;
    expect(repo.publishAcceptedPlates({ profileId: profile.id, expected: basis, expectedPlateRevisionId: null, plates: exact }))
      .toMatchObject({ kind: "published" });
    const count = acceptedPlateRows(raw).revisions.length;

    const outside = plateInput(required.map((unit) => unit.token));
    outside[0]!.units[1]!.xUm = 195_001;
    expect(
      repo.publishAcceptedPlates({ profileId: profile.id, expected: basis, expectedPlateRevisionId: null, plates: outside }),
    ).toEqual({ kind: "invalid_geometry", reason: "outside_build_area" });

    const overlap = plateInput(required.map((unit) => unit.token));
    overlap[0]!.units[1]!.xUm = 54_999;
    expect(
      repo.publishAcceptedPlates({ profileId: profile.id, expected: basis, expectedPlateRevisionId: null, plates: overlap }),
    ).toEqual({ kind: "invalid_geometry", reason: "overlapping_units" });
    expect(acceptedPlateRows(raw).revisions).toHaveLength(count);
  });

  it("accepts exact unit clearance and rejects one micrometre less", () => {
    const { repo, profile, accepted, required } = fixture();
    const basis = acceptedPlanBasis(accepted);
    const exact = plateInput(required.map((unit) => unit.token));
    exact[0]!.units[1]!.xUm = 60_000;
    expect(repo.publishAcceptedPlates({
      profileId: profile.id,
      expected: basis,
      expectedPlateRevisionId: null,
      plates: exact,
    })).toMatchObject({ kind: "published" });

    const tooClose = plateInput(required.map((unit) => unit.token));
    tooClose[0]!.units[1]!.xUm = 59_999;
    expect(repo.publishAcceptedPlates({
      profileId: profile.id,
      expected: basis,
      expectedPlateRevisionId: null,
      plates: tooClose,
    })).toEqual({ kind: "invalid_geometry", reason: "overlapping_units" });
  });

  it("accepts the exact captured height and rejects one micrometre above it without writing", () => {
    const { repo, raw, profile, accepted, required } = fixture();
    const basis = acceptedPlanBasis(accepted);
    const exact = plateInput(required.map((unit) => unit.token));
    exact[0]!.bedHeightUm = 30_000;
    expect(repo.publishAcceptedPlates({ profileId: profile.id, expected: basis, expectedPlateRevisionId: null, plates: exact }))
      .toMatchObject({ kind: "published" });
    const before = acceptedPlateRows(raw);

    const tooTall = plateInput(required.map((unit) => unit.token));
    tooTall[0]!.bedHeightUm = 29_999;
    expect(
      repo.publishAcceptedPlates({ profileId: profile.id, expected: basis, expectedPlateRevisionId: null, plates: tooTall }),
    ).toEqual({ kind: "invalid_geometry", reason: "outside_build_area" });
    expect(acceptedPlateRows(raw)).toEqual(before);
  });

  it("returns transaction_unavailable for PostgreSQL reads and mutations without querying", () => {
    const postgres = drizzle({} as Pool, { schema: pgSchema });
    let queries = 0;
    registerPostgresSyncQuery(postgres, () => {
      queries += 1;
      throw new Error("PostgreSQL mutation queried");
    });
    const repo = new AppRepository(postgres, "default", "/tmp/unused-accepted-plates");
    const expected = {
      profileId: 1,
      planVersion: 1,
      revisionId: 1,
      revisionDigest: "a".repeat(64),
      requiredUnitMappingDigest: "b".repeat(64),
    };
    try {
      expect(repo.readAcceptedPlates(1)).toEqual({ kind: "transaction_unavailable" });
      expect(repo.readAcceptedPlateExportInput(1)).toEqual({ kind: "transaction_unavailable" });
      expect(repo.readAcceptedPlateWorkspaceInput(1)).toEqual({ kind: "transaction_unavailable" });
      expect(repo.publishAcceptedPlates({ profileId: 1, expected, expectedPlateRevisionId: null, plates: [] })).toEqual({
        kind: "transaction_unavailable",
      });
      expect(
        repo.moveAcceptedPlateUnit({
          profileId: 1,
          expected,
          expectedPlateRevisionId: 1,
          plateId: "plate-main",
          token: "ppu_00000000000000000000000000000001",
          xUm: 0,
          yUm: 0,
        }),
      ).toEqual({ kind: "transaction_unavailable" });
      expect(queries).toBe(0);
    } finally {
      unregisterPostgresSyncQuery(postgres);
    }
  });

  it("cascades arranged Plate history when the Build is deleted", () => {
    const { repo, raw, profile, accepted, required, root } = fixture();
    const basis = acceptedPlanBasis(accepted);
    const initialPlates = plateInput(required.map((unit) => unit.token));
    initialPlates[0]!.plateId = "plate_00000000000000000000000000000001";
    const published = repo.publishAcceptedPlates({
        profileId: profile.id,
        expected: basis,
        expectedPlateRevisionId: null,
        plates: initialPlates,
      });
    if (published.kind !== "published") throw new Error("Plate publish failed");
    expect(arrangeAcceptedPlates(workspaceDependencies(repo, join(root, "repos")), {
      profileId: profile.id,
      expected: basis,
      expectedPlateRevisionId: published.plateRevisionId,
      mode: "all",
    })).toMatchObject({ kind: "workspace", workspace: { arrange_undo_revision_id: published.plateRevisionId } });

    expect(() => repo.deleteProfile(profile.id)).not.toThrow();
    for (const table of [
      "accepted_plate_heads",
      "accepted_plate_revisions",
      "accepted_plates",
      "accepted_plate_units",
    ]) {
      expect(raw.prepare(`SELECT count(*) FROM ${table}`).pluck().get()).toBe(0);
    }
  });
});
