import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { createSelfHostPorts } from "../adapters/self-host/index.js";
import { saveFleet } from "../services/printer-fleet.js";
import type { PrinterMachine } from "@print-partner/domain";

let cleanup: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

async function makeApp(fleet?: PrinterMachine[]) {
  const dir = mkdtempSync(join(tmpdir(), "pp-profile-assignment-route-"));
  process.env.PRINT_PARTNER_DATA_DIR = dir;
  delete process.env.PRINT_PARTNER_API_KEY;
  const config = loadConfig();
  const ports = createSelfHostPorts(dir);
  await ports.db.connect();
  const app = await buildApp(config, ports);
  const repo = ports.repository!;
  if (fleet?.length) {
    saveFleet(repo, fleet);
  }
  cleanup.push(() => {
    void app.close();
    void ports.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { app, repo };
}

const TEST_PRINTER: PrinterMachine = {
  id: "printer-abc",
  name: "Test Voron",
  model: "Test Voron",
  bed_width_mm: 350,
  bed_depth_mm: 350,
  bed_height_mm: 350,
  margin_mm: 4,
  max_filament_slots: 2,
  loaded_filaments: [
    { slot: 1, filament_color_id: null, label: "PLA" },
    { slot: 2, filament_color_id: null, label: "" },
  ],
};

describe("printer profile assignment routes", () => {
  it("GET returns auto_match defaults for unknown assignment", async () => {
    const { app } = await makeApp([TEST_PRINTER]);
    const res = await app.inject({
      method: "GET",
      url: "/printers/printer-abc/profile-assignment",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      profile_source: string;
      machine_profile_id: number | null;
      last_synced_at: string | null;
      filament_slots: Array<{ slot_index: number }>;
    };
    expect(body.profile_source).toBe("auto_match");
    expect(body.machine_profile_id).toBeNull();
    expect(body.last_synced_at).toBeNull();
    expect(body.filament_slots).toHaveLength(2);
  });

  it("PUT assigned machine then GET shows last_synced_at from that profile", async () => {
    const { app, repo } = await makeApp([TEST_PRINTER]);
    repo.upsertSyncedPrinterProfile({
      name: "Voron 350",
      slicerFormat: "orca",
      resolvedFlatConfig: "{}",
      sourcePath: "/tmp/voron.json",
    });
    const machineId = repo.listSlicerPrinterProfiles().find((p) => p.name === "Voron 350")!.id;

    const put = await app.inject({
      method: "PUT",
      url: "/printers/printer-abc/profile-assignment",
      payload: {
        profile_source: "assigned",
        machine_profile_id: machineId,
        filament_slots: [
          { slot_index: 1, filament_profile_id: null },
          { slot_index: 2, filament_profile_id: null },
        ],
      },
    });
    expect(put.statusCode).toBe(200);

    const get = await app.inject({
      method: "GET",
      url: "/printers/printer-abc/profile-assignment",
    });
    const body = get.json() as {
      profile_source: string;
      machine_profile_id: number;
      last_synced_at: string | null;
    };
    expect(body.profile_source).toBe("assigned");
    expect(body.machine_profile_id).toBe(machineId);
    expect(body.last_synced_at).toBeTruthy();
  });

  it("returns 404 when fleet printer is missing", async () => {
    const { app } = await makeApp([]);
    const res = await app.inject({
      method: "GET",
      url: "/printers/missing/profile-assignment",
    });
    expect(res.statusCode).toBe(404);
  });

  it("GET /slicer-profile-options lists synced profiles for pickers", async () => {
    const { app, repo } = await makeApp([TEST_PRINTER]);
    repo.upsertSyncedPrinterProfile({
      name: "Picker Machine",
      slicerFormat: "orca",
      resolvedFlatConfig: "{}",
      sourcePath: "/tmp/picker-machine.json",
    });
    const res = await app.inject({ method: "GET", url: "/slicer-profile-options" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      printers: Array<{ id: number; name: string; last_synced_at: string | null }>;
    };
    expect(body.printers.some((p) => p.name === "Picker Machine")).toBe(true);
  });
});
