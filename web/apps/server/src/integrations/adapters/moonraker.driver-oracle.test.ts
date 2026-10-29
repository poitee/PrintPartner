// Replays fixtures/drivers/moonraker/driver through the Node adapter and checks the
// results against the oracle files that the Rust driver test
// (rust/crates/pp-drivers/tests/ticket_t_21_moonraker_driver.rs) also replays.
// UPDATE_MOONRAKER_ORACLE=1 rewrites the oracle files instead of checking them.
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { StatusExecution } from "../status-execution.js";
import { moonrakerAdapter } from "./moonraker.js";

const here = new URL("../../../../../../fixtures/drivers/moonraker/driver/", import.meta.url);
const execution = new StatusExecution();

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, here), "utf8")) as T;
}

function checkOracle(name: string, actual: unknown) {
  const text = `${JSON.stringify(actual, null, 2)}\n`;
  if (process.env.UPDATE_MOONRAKER_ORACLE) {
    writeFileSync(new URL(name, here), text);
    return;
  }
  expect(JSON.parse(text)).toEqual(readJson(name));
}

async function settle<T>(work: Promise<T>) {
  try {
    return { ok: await work };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function readCalls(baseUrl: string, browse: string[]) {
  const config = { base_url: baseUrl };
  const result: Record<string, unknown> = {
    test_connection: await execution.test(moonrakerAdapter, config),
    status: await execution.probe(moonrakerAdapter, config),
    filament_used: await moonrakerAdapter.getFilamentUsed!(config),
    object_list: await moonrakerAdapter.getObjectList!(config),
    cameras: await settle(moonrakerAdapter.cameras!.list(config)),
  };
  const listings: Record<string, unknown> = {};
  for (const path of browse) {
    listings[path] = await settle(moonrakerAdapter.files!.browse(config, path));
  }
  return JSON.parse(JSON.stringify({ ...result, browse: listings })) as Record<string, unknown>;
}

describe("Moonraker driver oracle", () => {
  it("reads match node-oracle.json", async () => {
    const { routes, browse } = readJson<{ routes: Record<string, string>; browse: string[] }>(
      "routes.json",
    );
    // "recorded" serves the fixtures; the others answer every request with one status.
    const scenarios: Record<string, number | null> = {
      recorded: null,
      "http-500": 500,
      "http-404": 404,
    };
    const out: Record<string, unknown> = {};
    for (const [name, forced] of Object.entries(scenarios)) {
      const requests: string[] = [];
      const server = createServer((req, res) => {
        requests.push(`${req.method} ${req.url}`);
        const fixture = routes[req.url ?? ""];
        if (forced !== null || !fixture) {
          res.writeHead(forced ?? 404, { "content-type": "application/json" }).end("{}");
          return;
        }
        const { port } = server.address() as AddressInfo;
        const body = readFileSync(new URL(fixture, here), "utf8")
          .replaceAll("{ORIGIN}", `http://localhost:${port}`);
        res.writeHead(200, { "content-type": "application/json" }).end(body);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as AddressInfo;
      try {
        out[name] = { ...(await readCalls(`http://localhost:${port}/`, browse)), requests };
      } finally {
        server.close();
      }
    }
    checkOracle("node-oracle.json", out);
  });

  it("unusable base URLs match node-oracle-bases.json", async () => {
    const { bases } = readJson<{ bases: string[] }>("bases.json");
    const out: Record<string, unknown> = {};
    for (const base of bases) out[base] = await readCalls(base, [""]);
    checkOracle("node-oracle-bases.json", out);
  });

  it("uploads match node-oracle-upload.json", async () => {
    type Scenario = {
      name: string;
      filename: string;
      start: boolean;
      replies: Record<string, [number, string]>;
    };
    const { file, scenarios } = readJson<{ file: string; scenarios: Scenario[] }>(
      "upload-scenarios.json",
    );
    const out: Record<string, unknown> = {};
    for (const scenario of scenarios) {
      const requests: unknown[] = [];
      const server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          // Boundaries are random on both sides; everything else is compared byte for byte.
          const contentType = req.headers["content-type"] ?? null;
          const boundary = contentType?.match(/boundary=(.+)$/)?.[1];
          let body = Buffer.concat(chunks).toString("utf8");
          if (boundary) body = body.replaceAll(boundary, "<BOUNDARY>");
          requests.push({
            line: `${req.method} ${req.url}`,
            content_type: boundary ? contentType!.replace(boundary, "<BOUNDARY>") : contentType,
            body,
          });
          const path = new URL(req.url ?? "/", "http://x").pathname;
          const [status, reply] = scenario.replies[path] ?? [404, "{}"];
          const headers = status >= 300 && status < 400 ? { location: "/elsewhere" } : {};
          res.writeHead(status, headers).end(reply);
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as AddressInfo;
      try {
        const result = await moonrakerAdapter.uploadFile!(
          { base_url: `http://localhost:${port}` },
          new TextEncoder().encode(file),
          scenario.filename,
          { start: scenario.start },
        );
        out[scenario.name] = { result, requests };
      } finally {
        server.close();
      }
    }
    checkOracle("node-oracle-upload.json", out);
  });
});
