import { readFileSync, readdirSync } from "node:fs";
import type { IntegrationTestResult, PrinterHostStatus } from "@print-partner/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { homeAssistantAdapter } from "./home-assistant.js";

const fixtureDirectory = new URL(
  "../../../../../../fixtures/integrations/home-assistant/",
  import.meta.url,
);
const fixtureNames = readdirSync(fixtureDirectory)
  .filter((name) => name.endsWith(".json"))
  .sort();

// Expected values are independent of the fixture payload and adapter mapping.
// Include undefined fields so strict equality checks the complete status shape.
function status(
  state: PrinterHostStatus["state"],
  message: string,
  progress: number | undefined = undefined,
  filename: string | undefined = undefined,
): PrinterHostStatus {
  return { state, message, progress, filename };
}

const expectedStatuses: Record<string, PrinterHostStatus> = {
  "state-complete.json": status("complete", "Complete · part.gcode", undefined, "part.gcode"),
  "state-done.json": status("complete", "Complete · part.gcode", undefined, "part.gcode"),
  "state-empty.json": status("offline", ""),
  "state-error.json": status("error", "error"),
  "state-failure.json": status("error", "failure"),
  "state-finished.json": status("complete", "Complete · part.gcode", undefined, "part.gcode"),
  "state-idle.json": status("idle", "Idle"),
  "state-missing.json": status("offline", "Offline"),
  "state-normalized.json": status("printing", " Printing "),
  "state-paused.json": status("paused", "paused", 76, "part.gcode"),
  "state-printing.json": status("printing", "Printing part.gcode", 42, "part.gcode"),
  "state-ready.json": status("idle", "Idle"),
  "state-standby.json": status("idle", "Idle"),
  "state-unavailable.json": status("offline", "unavailable"),
  "state-unknown.json": status("offline", "unknown"),
  "state-unrecognized.json": status("unknown", "warming_up"),
};
const expectedConnections: Record<string, IntegrationTestResult> = {
  "api-running.json": { ok: true, message: "Connected" },
  "api-running-version.json": { ok: true, message: "Connected (HA 2024.1.0)" },
};
const config = {
  base_url: "http://192.168.1.10:8123",
  token: "synthetic-fixture-token",
};

function mockFixtureResponse(name: string) {
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response(
    readFileSync(new URL(name, fixtureDirectory), "utf8"),
    { headers: { "Content-Type": "application/json" } },
  ));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe(`Home Assistant JSON fixtures (${fixtureNames.length} fixtures)`, () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("contains fixtures", () => {
    expect(fixtureNames.length).toBeGreaterThan(0);
  });

  it.each(fixtureNames)("parses %s", (name) => {
    const payload: unknown = JSON.parse(
      readFileSync(new URL(name, fixtureDirectory), "utf8"),
    );
    expect(payload).toBeTypeOf("object");
    expect(payload).not.toBeNull();
    expect(Array.isArray(payload)).toBe(false);
  });

  it("has expected adapter outputs for every state and API probe fixture", () => {
    const consumedFixtures = fixtureNames.filter(
      (name) => name.startsWith("state-") || name.startsWith("api-running"),
    );
    expect([...Object.keys(expectedStatuses), ...Object.keys(expectedConnections)].sort())
      .toStrictEqual(consumedFixtures);
  });

  it.each(Object.keys(expectedStatuses))("maps adapter status for %s", async (name) => {
    const fetchMock = mockFixtureResponse(name);
    const actual = await homeAssistantAdapter.getStatus!({
      ...config,
      entity_id: "sensor.printer_state",
    });
    expect(actual).toStrictEqual(expectedStatuses[name]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `${config.base_url}/api/states/sensor.printer_state`,
    );
  });

  it.each(Object.keys(expectedConnections))("probes adapter connection for %s", async (name) => {
    const fetchMock = mockFixtureResponse(name);
    const actual = await homeAssistantAdapter.testConnection(config);
    expect(actual).toStrictEqual(expectedConnections[name]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${config.base_url}/api/`);
  });
});
