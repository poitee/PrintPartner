import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDb, SqliteDatabase } from "./db/client.js";
import { AppRepository } from "./db/repository.js";
import {
  clearFleetIntegrationBinds,
  loadFleet,
  newMachineFromPreset,
  parsePrinterMachine,
  saveFleet,
} from "./services/printer-fleet.js";

describe("printer fleet persistence", () => {
  it("printer fleet CRUD", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-printers-"));
    const sqlite = new SqliteDatabase(dir);
    sqlite.connect();
    const repo = new AppRepository(getDb(sqlite), undefined, sqlite.reposDir);
    saveFleet(repo, []);
    expect(loadFleet(repo)).toEqual([]);
    saveFleet(repo, [
      {
        id: "p1",
        name: "A",
        model: "A",
        bed_width_mm: 250,
        bed_depth_mm: 210,
        bed_height_mm: 250,
        margin_mm: 4,
        max_filament_slots: 1,
        loaded_filaments: [{ slot: 1, filament_color_id: null, label: "" }],
      },
    ]);
    expect(loadFleet(repo)).toHaveLength(1);
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("printer fleet round-trips integration_id bind and clears on host delete", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-printer-bind-"));
    const sqlite = new SqliteDatabase(dir);
    sqlite.connect();
    const repo = new AppRepository(getDb(sqlite), undefined, sqlite.reposDir);

    const legacy = parsePrinterMachine({
      id: "legacy",
      name: "Legacy",
      bed_width_mm: 250,
      bed_depth_mm: 210,
      bed_height_mm: null,
      margin_mm: 4,
      max_filament_slots: 1,
      loaded_filaments: [],
    });
    expect(legacy.integration_id).toBeUndefined();
    expect(legacy.model).toBe("Legacy");

    expect(newMachineFromPreset({
      id: "preset-core-one",
      name: "Core One",
      model_slug: "prusa-core-one",
      bed_width_mm: 250,
      bed_depth_mm: 220,
      bed_height_mm: 270,
      max_filament_slots: 1,
    }).model).toBe("prusa-core-one");

    saveFleet(repo, [
      {
        id: "p1",
        name: "Voron",
        model: "Voron",
        bed_width_mm: 350,
        bed_depth_mm: 350,
        bed_height_mm: 345,
        margin_mm: 4,
        max_filament_slots: 1,
        loaded_filaments: [{ slot: 1, filament_color_id: null, label: "" }],
        integration_id: "int-moon",
        device_id: "default",
      },
      {
        id: "p2",
        name: "Other",
        model: "Other",
        bed_width_mm: 250,
        bed_depth_mm: 210,
        bed_height_mm: null,
        margin_mm: 4,
        max_filament_slots: 1,
        loaded_filaments: [{ slot: 1, filament_color_id: null, label: "" }],
        integration_id: "int-other",
        device_id: "default",
      },
    ]);

    const loaded = loadFleet(repo);
    expect(loaded.find((p) => p.id === "p1")?.integration_id).toBe("int-moon");
    expect(loaded.find((p) => p.id === "p1")?.device_id).toBe("default");

    expect(clearFleetIntegrationBinds(repo, "int-moon")).toBe(1);
    const after = loadFleet(repo);
    expect(after.find((p) => p.id === "p1")?.integration_id).toBeNull();
    expect(after.find((p) => p.id === "p1")?.device_id).toBeNull();
    expect(after.find((p) => p.id === "p2")?.integration_id).toBe("int-other");

    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
