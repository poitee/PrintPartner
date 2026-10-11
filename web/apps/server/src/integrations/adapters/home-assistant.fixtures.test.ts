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
const webhookFixtures = ["webhook-upload.json", "webhook-response.json"];
interface WebhookUploadFixture {
  method: string;
  path: string;
  content_type: string;
  fields: {
    file: { filename: string; content: string };
    filename: string;
  };
}
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

  it("has adapter replay coverage for every fixture", () => {
    expect([
      ...Object.keys(expectedStatuses),
      ...Object.keys(expectedConnections),
      ...webhookFixtures,
    ].sort()).toStrictEqual(fixtureNames);
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

  it("replays webhook upload and response fixtures through the adapter", async () => {
    const fixture = JSON.parse(readFileSync(
      new URL("webhook-upload.json", fixtureDirectory), "utf8",
    )) as WebhookUploadFixture;
    const responsePayload: unknown = JSON.parse(readFileSync(
      new URL("webhook-response.json", fixtureDirectory), "utf8",
    ));
    expect(responsePayload).toStrictEqual({});
    const fetchMock = mockFixtureResponse("webhook-response.json");
    // Inputs and expected output are independent of the fixture's request fields.
    const actual = await homeAssistantAdapter.uploadFile!(
      { ...config, webhook_id: "fixture/id" },
      new TextEncoder().encode("; fixture gcode\n"),
      "part.gcode",
      { start: true },
    );
    expect(actual).toStrictEqual({
      ok: true,
      remote_path: "part.gcode",
      started: false,
      message: "Sent part.gcode to Home Assistant webhook",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      `${config.base_url}${fixture.path.replace("{webhook_id}", "fixture%2Fid")}`,
    );
    expect(init?.method).toBe(fixture.method);
    const request = new Request(String(url), init);
    expect(request.headers.get("content-type")?.split(";")[0]).toBe(fixture.content_type);
    expect(request.headers.has("authorization")).toBe(false);
    const form = init?.body;
    if (!(form instanceof FormData)) throw new Error("Expected multipart FormData");
    expect([...form.keys()].sort()).toStrictEqual(Object.keys(fixture.fields).sort());
    expect(form.get("filename")).toBe(fixture.fields.filename);
    const file = form.get("file");
    if (!(file instanceof File)) throw new Error("Expected uploaded file");
    expect(file.name).toBe(fixture.fields.file.filename);
    expect(await file.text()).toBe(fixture.fields.file.content);
  });
});
