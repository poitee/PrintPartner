import { StatusExecution } from "../status-execution.js";
import { readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prusalinkAdapter } from "./prusalink.js";

const fixtureDirectory = new URL(
  "../../../../../../fixtures/drivers/prusalink/",
  import.meta.url,
);
const fixtureNames = [
  "digest-401", "info", "job", "status-error", "status-idle",
  "status-printing", "upload-response",
];

type Fixture = { status: number; headers: Record<string, string>; body: unknown };
function response(name: string): Response {
  const fixture: Fixture = JSON.parse(readFileSync(
    new URL(`${name}.json`, fixtureDirectory), "utf8",
  ));
  return new Response(fixture.body === null ? null : JSON.stringify(fixture.body), {
    status: fixture.status,
    headers: fixture.headers,
  });
}

const config = {
  base_url: "http://192.0.2.10",
  username: "fixture-user",
  password: "synthetic-fixture-password",
};

function stubResponses(routes: Record<string, string>) {
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (!new Headers(init?.headers).has("Authorization")) {
      expect(path).toBe("/api/v1/status");
      expect(init?.method).toBe("GET");
      return response("digest-401");
    }
    const name = routes[path];
    return name ? response(name) : new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

const execution = new StatusExecution();

describe("7 PrusaLink fixtures parsed through the TS adapter", () => {
  it("covers the complete fixture inventory", () => {
    expect(readdirSync(fixtureDirectory).filter((name) => name.endsWith(".json")).sort())
      .toEqual(fixtureNames.map((name) => `${name}.json`));
  });

  it("digest-401: parses the challenge into authenticated requests", async () => {
    const fetchMock = stubResponses({ "/api/v1/status": "status-idle" });
    expect((await execution.probe(prusalinkAdapter, config)).state).toBe("idle");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const authorization = new Headers(fetchMock.mock.calls[1]![1]?.headers)
      .get("Authorization");
    expect(authorization).toContain('Digest username="fixture-user"');
    expect(authorization).toContain('realm="Printer API"');
    expect(authorization).toContain('nonce="fixture-nonce"');
    expect(authorization).toContain('uri="/api/v1/status"');
    expect(authorization).toMatch(/response="[a-f0-9]{32}"/);
    expect(authorization).toContain("qop=auth");
  });

  it("info: reads the connection label from version/info metadata", async () => {
    stubResponses({ "/api/v1/info": "info", "/api/v1/status": "status-idle" });
    expect(await execution.test(prusalinkAdapter, config)).toEqual({
      ok: true, message: "Connected (Fixture Prusa, state: idle)",
    });
  });

  it("status-idle: maps READY and reads temperatures", async () => {
    stubResponses({ "/api/v1/status": "status-idle" });
    expect(await execution.probe(prusalinkAdapter, config)).toMatchObject({
      state: "idle", message: "Idle", ip_address: "192.0.2.10",
      nozzle_temperature_c: 24.5, nozzle_target_c: 0,
      bed_temperature_c: 23, bed_target_c: 0,
    });
  });

  it("status-printing: reads progress, filename, ETA and temperatures", async () => {
    stubResponses({ "/api/v1/status": "status-printing" });
    expect(await execution.probe(prusalinkAdapter, config)).toMatchObject({
      state: "printing", progress: 33, filename: "benchy.gcode",
      eta_seconds: 1200, message: "Printing benchy.gcode",
      nozzle_temperature_c: 214.5, nozzle_target_c: 215,
      bed_temperature_c: 59.5, bed_target_c: 60,
    });
  });

  it("status-error: maps ERROR", async () => {
    stubResponses({ "/api/v1/status": "status-error" });
    expect(await execution.probe(prusalinkAdapter, config)).toMatchObject({
      state: "error", message: "ERROR", nozzle_temperature_c: 30,
      nozzle_target_c: 0, bed_temperature_c: 25, bed_target_c: 0,
    });
  });

  it("job: reads the active filename and fallback progress / ETA", async () => {
    const fetchMock = stubResponses({ "/api/v1/job": "job" });
    // A status without job metadata exercises the adapter's /job fallback.
    const routedFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      if (new URL(String(input)).pathname === "/api/v1/status"
        && new Headers(init?.headers).has("Authorization")) {
        return new Response(JSON.stringify({ printer: { state: "PRINTING" } }), {
          headers: { "content-type": "application/json" },
        });
      }
      return routedFetch(input, init);
    });
    expect(await execution.probe(prusalinkAdapter, config)).toMatchObject({
      state: "printing", filename: "bracket.bgcode", progress: 43,
      eta_seconds: 900, message: "Printing bracket.bgcode",
    });
  });

  it("upload-response: accepts HTTP 201 for an authenticated PUT", async () => {
    const fetchMock = stubResponses({
      "/api/v1/files/usb/benchy.gcode": "upload-response",
    });
    expect(await prusalinkAdapter.uploadFile!(
      config, new TextEncoder().encode("; synthetic gcode\n"), "benchy.gcode",
    )).toEqual({
      ok: true, remote_path: "usb/benchy.gcode", started: false,
      message: "Uploaded benchy.gcode",
    });
    const uploadRequest = fetchMock.mock.calls[1]![1];
    expect(uploadRequest?.method).toBe("PUT");
    expect(new Headers(uploadRequest?.headers).get("Authorization"))
      .toContain('uri="/api/v1/files/usb/benchy.gcode"');
  });
});
