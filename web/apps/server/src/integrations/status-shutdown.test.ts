import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { createSelfHostPorts } from "../adapters/self-host/index.js";

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

it("refuses a real printer response released after application shutdown begins", async () => {
  const entered = barrier();
  const release = barrier();
  const closing = barrier();
  const host = createServer(async (request, response) => {
    if (request.url?.startsWith("/printer/objects/query")) {
      entered.resolve();
      await release.promise;
      response.end(JSON.stringify({ result: { status: { print_stats: { state: "standby" } } } }));
    } else {
      response.end(JSON.stringify({ result: { system_uptime: 42 } }));
    }
  });
  await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
  const address = host.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const dir = mkdtempSync(join(tmpdir(), "pp-status-shutdown-"));
  vi.stubEnv("PRINT_PARTNER_DATA_DIR", dir);
  vi.stubEnv("PRINT_PARTNER_API_KEY", "");
  const ports = createSelfHostPorts(dir);
  await ports.db.connect();
  ports.repository.setSetting("integrations", JSON.stringify([{
    id: "host", type: "moonraker", name: "Host",
    config: { base_url: `http://127.0.0.1:${address.port}` },
  }]));
  const app = await buildApp(loadConfig(), ports);
  app.addHook("preClose", async () => { closing.resolve(); });
  try {
    const response = app.inject({ method: "GET", url: "/api/v1/integrations/host/status" });
    await entered.promise;
    const stopped = app.close();
    await closing.promise;
    release.resolve();
    const result = await response;
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ state: "offline", message: "Printer status execution stopped" });
    await stopped;
  } finally {
    release.resolve();
    await app.close();
    await ports.db.close();
    host.closeAllConnections();
    await new Promise<void>((resolve) => host.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
});
