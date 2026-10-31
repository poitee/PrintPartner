import { StatusExecution } from "../status-execution.js";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { moonrakerAdapter } from "./moonraker.js";

// Fake resolver: hostnames pass the real outbound guard without touching DNS.
vi.mock("node:dns/promises", () => ({
  lookup: async () => [{ address: "192.0.2.10", family: 4 }],
}));

const fixtureDirectory = new URL("../../../../../../fixtures/drivers/moonraker/", import.meta.url);

type Case = {
  name: string;
  base_url: string;
  fixture?: string;
  body?: unknown;
  expected: Record<string, unknown>;
  rust_rejects?: string;
};
const { cases } = JSON.parse(
  readFileSync(new URL("status-parity.json", fixtureDirectory), "utf8"),
) as { cases: Case[] };

function body(fixture: Case): string {
  return fixture.fixture
    ? readFileSync(new URL(fixture.fixture, fixtureDirectory), "utf8")
    : JSON.stringify(fixture.body);
}

afterEach(() => vi.unstubAllGlobals());

const execution = new StatusExecution();

describe(`${cases.length} Moonraker status parity cases through the TS adapter`, () => {
  it.each(cases)("$name", async (fixture) => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      // proc_stats is a second request Rust does not make; leave uptime absent.
      return path.endsWith("/printer/objects/query")
        ? new Response(body(fixture), { headers: { "content-type": "application/json" } })
        : new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const status = await execution.probe(moonrakerAdapter, { base_url: fixture.base_url });
    expect(JSON.parse(JSON.stringify(status))).toEqual(fixture.expected);

    // Status polling is read-only: no upload, print start or other mutation.
    const base = new URL(fixture.base_url).pathname.replace(/\/+$/, "");
    expect(
      fetchMock.mock.calls.map(([input, init]) => [
        (init?.method ?? "GET").toUpperCase(),
        new URL(String(input)).pathname,
      ]),
    ).toEqual([
      ["GET", `${base}/printer/objects/query`],
      ["GET", `${base}/machine/proc_stats`],
    ]);
  });
});
