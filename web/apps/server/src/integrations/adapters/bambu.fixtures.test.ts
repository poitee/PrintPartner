import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { statusFromBambuPrint } from "./bambu.js";

const fixtureDirectory = new URL("../../../../../../fixtures/drivers/bambu/", import.meta.url);
const fixtureNames = readdirSync(fixtureDirectory).filter((name) => name.endsWith(".json")).sort();
const expectedStatuses = {
  "ams-tray-synthetic.json": { state: "idle", message: "Idle" },
  "pushall-idle.json": { state: "idle", message: "Idle" },
  "pushall-printing.json": {
    state: "printing",
    progress: 42,
    filename: "frame_x.3mf",
    eta_seconds: 720,
    nozzle_temperature_c: 218.4,
    nozzle_target_c: 220,
    bed_temperature_c: 59.7,
    bed_target_c: 60,
    message: "Printing frame_x.3mf",
  },
  "pushall-error.json": { state: "error", message: "Error" },
};

describe(`Bambu LAN MQTT fixtures (${fixtureNames.length} fixtures)`, () => {
  it("covers every fixture with an expected adapter status", () => {
    expect(fixtureNames).toEqual(Object.keys(expectedStatuses).sort());
  });

  it.each(fixtureNames)("parses %s with the TS adapter", (name) => {
    const payload = JSON.parse(readFileSync(new URL(name, fixtureDirectory), "utf8"));
    expect(payload.print).toBeDefined();
    const status = statusFromBambuPrint(payload.print);
    expect(status).toMatchObject(expectedStatuses[name as keyof typeof expectedStatuses]);
    if (status.state !== "printing") {
      expect(status.progress).toBeUndefined();
      expect(status.eta_seconds).toBeUndefined();
    }
  });
});
