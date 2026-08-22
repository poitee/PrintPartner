import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDb, SqliteDatabase, type DrizzleDb } from "./client.js";
import { AppRepository } from "./repository.js";
import * as schema from "./schema.js";
import { eq } from "drizzle-orm";

function withRepo(fn: (repo: AppRepository, db: DrizzleDb) => void) {
  const dir = mkdtempSync(join(tmpdir(), "pp-db-"));
  const sqlite = new SqliteDatabase(dir);
  sqlite.connect();
  try {
    fn(new AppRepository(getDb(sqlite), undefined, sqlite.reposDir), getDb(sqlite));
  } finally {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function insertIncludedPart(db: DrizzleDb, profileId: number, filename = "bracket.stl") {
  return db
    .insert(schema.parts)
    .values({
      tenantId: "default",
      profileId,
      matchKey: filename,
      relativePath: filename,
      filename,
      quantityEffective: 1,
      included: true,
    })
    .returning()
    .get()!;
}

describe("AppRepository", () => {
  it("creates and lists sources and plans", () => {
    withRepo((repo) => {
      expect(repo.listSources()).toEqual([]);
      const source = repo.createSource({
        name: "Test Repo",
        url: "https://github.com/example/test",
        source_kind: "github",
      });
      expect(source.name).toBe("Test Repo");

      const plan = repo.createProfile("My Plan");
      expect(plan.name).toBe("My Plan");
      expect(plan.archived_at).toBeNull();
      expect(plan.last_used_at).toBeTruthy();
      expect(repo.listProfileHeaders()).toHaveLength(1);
    });
  });

  it("touches last_used_at and duplicates as a fresh non-archived spine plan", () => {
    withRepo((repo, db) => {
      const plan = repo.createProfile("Template");
      insertIncludedPart(db, plan.id);
      db.update(schema.buildProfiles)
        .set({ archivedAt: "2026-08-21T17:00:00.000Z" })
        .where(eq(schema.buildProfiles.id, plan.id))
        .run();
      const touched = repo.touchProfileLastUsed(plan.id);
      expect(touched.last_used_at).toBeTruthy();

      const copy = repo.duplicateProfile(plan.id, "Next customer", { clearCheckoff: true });
      expect(copy.archived_at).toBeNull();
      expect(copy.last_used_at).toBeTruthy();
      expect(copy.name).toBe("Next customer");
    });
  });

  it("persists special_request on the plan and copies it on duplicate", () => {
    withRepo((repo) => {
      const plan = repo.createProfile("Desk job");
      expect(plan.special_request).toBeNull();

      const updated = repo.updateProfileSpecialRequest(
        plan.id,
        "contact customer before printing",
      );
      expect(updated.special_request).toBe("contact customer before printing");
      expect(repo.getProfileHeader(plan.id)?.special_request).toBe(
        "contact customer before printing",
      );

      const cleared = repo.updateProfileSpecialRequest(plan.id, "  ");
      expect(cleared.special_request).toBeNull();

      repo.updateProfileSpecialRequest(plan.id, "bag separately");
      const copy = repo.duplicateProfile(plan.id, "Desk job copy");
      expect(copy.special_request).toBe("bag separately");
    });
  });

  it("upserts assignment and slot filaments, defaults to auto_match when missing", () => {
    withRepo((repo) => {
      expect(repo.getPrinterProfileAssignment("p1")).toBeNull();
      repo.upsertPrinterProfileAssignment({
        printerId: "p1",
        machineProfileId: null,
        profileSource: "assigned",
        filamentSlots: [
          { slotIndex: 1, filamentProfileId: null },
          { slotIndex: 2, filamentProfileId: null },
        ],
      });
      const row = repo.getPrinterProfileAssignment("p1");
      expect(row?.profileSource).toBe("assigned");
      expect(repo.listFilamentSlotAssignments("p1")).toEqual([
        { slotIndex: 1, filamentProfileId: null },
        { slotIndex: 2, filamentProfileId: null },
      ]);
    });
  });

  it("loads slicer profiles by id with last_synced_at", () => {
    withRepo((repo) => {
      repo.upsertSyncedPrinterProfile({
        name: "Voron 350",
        slicerFormat: "orca",
        resolvedFlatConfig: "{}",
        sourcePath: "/tmp/machine.json",
      });
      repo.upsertSyncedFilamentProfile({
        name: "PLA Basic",
        materialType: "PLA",
        resolvedFlatConfig: "{}",
        sourcePath: "/tmp/filament.json",
      });
      const machine = repo.listSlicerPrinterProfiles().find((p) => p.name === "Voron 350")!;
      const filament = repo.listSlicerFilamentProfiles().find((p) => p.name === "PLA Basic")!;
      expect(repo.getSlicerPrinterProfileById(machine.id)?.name).toBe("Voron 350");
      expect(repo.getSlicerPrinterProfileById(machine.id)?.lastSyncedAt).toBeTruthy();
      expect(repo.getSlicerFilamentProfileById(filament.id)?.name).toBe("PLA Basic");
      expect(repo.getSlicerFilamentProfileById(filament.id)?.lastSyncedAt).toBeTruthy();
    });
  });

  it("replaces slot assignments on upsert", () => {
    withRepo((repo) => {
      repo.upsertPrinterProfileAssignment({
        printerId: "p1",
        machineProfileId: null,
        profileSource: "assigned",
        filamentSlots: [{ slotIndex: 1, filamentProfileId: null }],
      });
      repo.upsertSyncedFilamentProfile({
        name: "PETG",
        materialType: "PETG",
        resolvedFlatConfig: "{}",
        sourcePath: "/tmp/petg.json",
      });
      const filamentId = repo.listSlicerFilamentProfiles().find((p) => p.name === "PETG")!.id;
      repo.upsertPrinterProfileAssignment({
        printerId: "p1",
        machineProfileId: null,
        profileSource: "assigned",
        filamentSlots: [
          { slotIndex: 1, filamentProfileId: filamentId },
          { slotIndex: 2, filamentProfileId: null },
        ],
      });
      expect(repo.listFilamentSlotAssignments("p1")).toEqual([
        { slotIndex: 1, filamentProfileId: filamentId },
        { slotIndex: 2, filamentProfileId: null },
      ]);
    });
  });
});
