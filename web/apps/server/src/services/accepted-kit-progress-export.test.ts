import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { getDb, SqliteDatabase } from "../db/client.js";
import { AppRepository } from "../db/repository.js";
import * as schema from "../db/schema.js";
import type { AcceptedOperationalExport } from "./accepted-operational-export.js";
import {
  buildKitBundleData,
  type EditableKitRecipe,
  loadKitBundleBytes,
  writeKitBundleData,
} from "./export-kit.js";
import { EMPTY_KIT_MANIFEST } from "./kit-manifest-store.js";

function recipe(): EditableKitRecipe {
  return {
    profile: { id: 7, name: "Working Build", orderNumber: "WORK-1" },
    layers: [{ layer_order: 0, layer_type: "base", project: null }],
    sources: [{ name: "Editable Source" }],
    kitManifest: { ...EMPTY_KIT_MANIFEST },
    workingParts: [
      {
        matchKey: "same-key",
        relativePath: "working.stl",
        filename: "working.stl",
        sourceLayer: "base:Working",
        status: "ok",
        role: "primary",
        filamentColorId: null,
        filamentCustomHex: null,
        quantityInferred: 9,
        quantityOverride: null,
        quantityEffective: 9,
        included: true,
        notes: "working",
        geometrySame: null,
        requirement: null,
        optionGroupId: null,
        manifestSource: null,
      },
    ],
  };
}

function accepted(): AcceptedOperationalExport {
  return {
    basis: {
      profileId: 7,
      planVersion: 4,
      revisionId: 19,
      revisionDigest: "a".repeat(64),
      requiredUnitMappingDigest: "b".repeat(64),
    },
    profile: {
      id: 7,
      name: "Accepted Build",
      orderNumber: "ACCEPTED-1",
      specialRequest: null,
      archivedAt: null,
    },
    provenance: { kind: "legacy" },
    parts: [
      {
        revisionPartId: 31,
        projectionPartId: 41,
        partKey: "same-key",
        relativePath: "accepted.stl",
        filename: "accepted.stl",
        sourceLayer: "base:Accepted",
        status: "ok",
        role: "accent",
        filamentColorId: "red",
        filamentCustomHex: "#cc0000",
        spoolmanSpoolId: "12",
        quantityInferred: 2,
        quantityOverride: null,
        quantityEffective: 2,
        included: true,
        notes: "accepted",
        geometrySame: true,
        requirement: "pair",
        optionGroupId: "head",
        manifestSource: "kit.yaml",
        artifact: { kind: "unavailable", reason: "legacy" },
        units: [
          { token: "31:0", unitIndex: 0, completed: true, assembled: false },
          { token: "31:1", unitIndex: 1, completed: false, assembled: false },
        ],
      },
      {
        revisionPartId: 32,
        projectionPartId: 42,
        partKey: "accepted-only",
        relativePath: "accepted-only.stl",
        filename: "accepted-only.stl",
        sourceLayer: "addon:Accepted",
        status: "ok",
        role: "clear",
        filamentColorId: null,
        filamentCustomHex: null,
        spoolmanSpoolId: null,
        quantityInferred: 1,
        quantityOverride: null,
        quantityEffective: 1,
        included: true,
        notes: "",
        geometrySame: null,
        requirement: null,
        optionGroupId: null,
        manifestSource: null,
        artifact: { kind: "unavailable", reason: "untracked_source" },
        units: [{ token: "32:0", unitIndex: 0, completed: true, assembled: false }],
      },
    ],
  };
}

describe("buildKitBundleData", () => {
  it("keeps editable format v3 Parts and omits print_units", () => {
    const data = buildKitBundleData({
      mode: { kind: "editable", recipe: recipe() },
      exportedAt: "2026-08-21T15:00:00.000Z",
    });

    expect(Object.keys(data).sort()).toEqual([
      "exported_at",
      "format",
      "kit_manifest",
      "layers",
      "parts",
      "profile",
      "sources",
      "version",
    ]);
    expect(data.parts).toEqual([
      expect.objectContaining({
        match_key: "same-key",
        relative_path: "working.stl",
        quantity_effective: 9,
      }),
    ]);
    expect(JSON.stringify(data)).not.toContain("print_units");
  });

  it("serializes accepted Parts and their adjacent accepted progress without a working overlay", () => {
    const data = buildKitBundleData({
      mode: { kind: "accepted_progress", recipe: recipe(), accepted: accepted() },
      exportedAt: "2026-08-21T15:00:00.000Z",
    });

    expect(data.parts).toEqual([
      expect.objectContaining({
        match_key: "same-key",
        relative_path: "accepted.stl",
        source_layer: "base:Accepted",
        role: "accent",
        quantity_auto: 2,
        quantity_effective: 2,
        print_units: [true, false],
      }),
      expect.objectContaining({
        match_key: "accepted-only",
        relative_path: "accepted-only.stl",
        print_units: [true],
      }),
    ]);
    expect(JSON.stringify(data)).not.toContain("working.stl");
  });

  it("serializes an empty accepted Plan as an empty progress Part list", () => {
    const data = buildKitBundleData({
      mode: { kind: "accepted_progress", recipe: recipe(), accepted: null },
      exportedAt: "2026-08-21T15:00:00.000Z",
    });
    expect(data.parts).toEqual([]);
  });

  it("imports matched kit Sources through Apply rather than compatibility Part rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "print-partner-accepted-kit-import-"));
    const sqlite = new SqliteDatabase(dir);
    sqlite.connect();
    try {
      const db = getDb(sqlite);
      const repo = new AppRepository(db, undefined, sqlite.reposDir);
      const data = buildKitBundleData({
        mode: { kind: "accepted_progress", recipe: recipe(), accepted: accepted() },
        exportedAt: "2026-08-21T15:00:00.000Z",
      });

      const imported = repo.importKitBundle(data, "Imported accepted progress");
      expect(imported.parts_imported).toBe(0);
      expect(repo.readAcceptedPlanOperationalSnapshot(imported.profile_id).kind).toBe("empty");
      expect(repo.listParts(imported.profile_id).parts).toEqual([]);
      expect(
        db
          .select({ token: schema.requiredUnits.token })
          .from(schema.requiredUnits)
          .where(eq(schema.requiredUnits.profileId, imported.profile_id))
          .all(),
      ).toEqual([]);
    } finally {
      sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an intermediate export-directory symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "print-partner-accepted-kit-write-"));
    const exportsDir = join(root, "exports");
    const outside = join(root, "outside");
    mkdirSync(exportsDir);
    mkdirSync(outside);
    symlinkSync(outside, join(exportsDir, "profile-7-Build"));
    try {
      expect(() =>
        writeKitBundleData({
          data: { format: "print-partner-kit", version: 3 },
          profileId: 7,
          profileName: "Build",
          exportsDir,
        }),
      ).toThrow();
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains same-second editable and accepted-progress bundles at distinct paths", () => {
    const root = mkdtempSync(join(tmpdir(), "print-partner-accepted-kit-retention-"));
    try {
      const editable = writeKitBundleData({
        data: { format: "print-partner-kit", version: 3, parts: [{ mode: "editable" }] },
        profileId: 7,
        profileName: "A/B",
        exportsDir: root,
      });
      const acceptedProgress = writeKitBundleData({
        data: {
          format: "print-partner-kit",
          version: 3,
          parts: [{ mode: "accepted", print_units: [true] }],
        },
        profileId: 7,
        profileName: "A/B",
        exportsDir: root,
      });

      expect(acceptedProgress).not.toBe(editable);
      expect(loadKitBundleBytes(editable).parts).toEqual([{ mode: "editable" }]);
      expect(loadKitBundleBytes(acceptedProgress).parts).toEqual([
        { mode: "accepted", print_units: [true] },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("separates Builds whose readable names have the same slug", () => {
    const root = mkdtempSync(join(tmpdir(), "print-partner-accepted-kit-builds-"));
    try {
      const first = writeKitBundleData({
        data: { format: "print-partner-kit", version: 3 },
        profileId: 7,
        profileName: "A/B",
        exportsDir: root,
      });
      const second = writeKitBundleData({
        data: { format: "print-partner-kit", version: 3 },
        profileId: 8,
        profileName: "A_B",
        exportsDir: root,
      });

      expect(first).not.toBe(second);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
