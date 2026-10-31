import { createServer, type ServerResponse } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { expect, it } from "vitest";
import type { IntegrationAdapter } from "./store.js";
import { StatusExecution } from "./status-execution.js";
import { moonrakerAdapter } from "./adapters/moonraker.js";
import { prusalinkAdapter } from "./adapters/prusalink.js";
import { homeAssistantAdapter } from "./adapters/home-assistant.js";
import { bambuAdapter } from "./adapters/bambu.js";

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function httpHost(
  handle: (path: string, response: ServerResponse, authorization?: string) => void,
) {
  const host = createServer((request, response) =>
    handle(request.url ?? "", response, request.headers.authorization),
  );
  await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
  const address = host.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      host.closeAllConnections();
      await new Promise<void>((resolve) => host.close(() => resolve()));
    },
  };
}

it("joins a redirected Moonraker body and does not start uptime work after cancellation", async () => {
  const entered = barrier();
  const disconnected = barrier();
  const paths: string[] = [];
  const host = await httpHost((path, response) => {
    paths.push(path);
    if (path.startsWith("/printer/objects/query")) {
      response.writeHead(302, { location: "/held" }).end();
    } else {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"result":');
      response.on("close", disconnected.resolve);
      entered.resolve();
    }
  });
  const execution = new StatusExecution();
  try {
    const result = execution.probe(moonrakerAdapter, { base_url: host.url });
    const rejected = expect(result).rejects.toThrow("Printer status execution stopped");
    await entered.promise;
    expect(execution.snapshot()).toEqual({
      state: "running",
      tasks: [{ id: 1, provider: "moonraker", operation: "probe" }],
    });
    await execution.stop();
    await rejected;
    await disconnected.promise;
    expect(execution.snapshot()).toEqual({ state: "stopped", tasks: [] });
    expect(paths).toEqual([
      "/printer/objects/query?print_stats&virtual_sdcard&display_status&extruder&heater_bed",
      "/held",
    ]);
    await expect(execution.probe(moonrakerAdapter, { base_url: host.url })).rejects.toThrow(
      "Printer status execution stopped",
    );
  } finally {
    await execution.stop();
    await host.close();
  }
});

it("cancels PrusaLink during its real Digest challenge without sending an authenticated retry", async () => {
  const entered = barrier();
  const disconnected = barrier();
  const requests: Array<{ path: string; authenticated: boolean }> = [];
  const host = await httpHost((path, response, authorization) => {
    requests.push({ path, authenticated: authorization !== undefined });
    response.on("close", disconnected.resolve);
    entered.resolve();
  });
  const execution = new StatusExecution();
  try {
    const rejected = expect(
      execution.probe(prusalinkAdapter, {
        base_url: host.url,
        username: "maker",
        password: "secret",
      }),
    ).rejects.toThrow("Printer status execution stopped");
    await entered.promise;
    await execution.stop();
    await rejected;
    await disconnected.promise;
    expect(requests).toEqual([{ path: "/api/v1/status", authenticated: false }]);
    expect(execution.snapshot()).toEqual({ state: "stopped", tasks: [] });
  } finally {
    await execution.stop();
    await host.close();
  }
});

it("keeps raw Home Assistant entity text and cancels an in-flight entity inspection", async () => {
  const entered = barrier();
  const disconnected = barrier();
  let hold = false;
  const requests: string[] = [];
  const host = await httpHost((path, response) => {
    requests.push(path);
    if (path === "/api/") response.end('{"version":"2026.10"}');
    else if (!hold) response.end('{"state":"Warming bed","attributes":{}}');
    else {
      response.on("close", disconnected.resolve);
      entered.resolve();
    }
  });
  const execution = new StatusExecution();
  const config = { base_url: host.url, token: "fixture", entity_id: "sensor.printer" };
  try {
    expect(await execution.test(homeAssistantAdapter, config)).toEqual({
      ok: true,
      message: "Connected (HA 2026.10) · sensor.printer: Warming bed",
    });
    hold = true;
    const rejected = expect(execution.test(homeAssistantAdapter, config)).rejects.toThrow(
      "Printer status execution stopped",
    );
    await entered.promise;
    await execution.stop();
    await rejected;
    await disconnected.promise;
    expect(requests).toEqual([
      "/api/",
      "/api/states/sensor.printer",
      "/api/",
      "/api/states/sensor.printer",
    ]);
    expect(execution.snapshot()).toEqual({ state: "stopped", tasks: [] });
  } finally {
    await execution.stop();
    await host.close();
  }
});

it("joins a real MQTT TLS connection cancelled before the handshake completes", async () => {
  const entered = barrier();
  const disconnected = barrier();
  const host = createTcpServer((socket) => {
    socket.once("data", entered.resolve);
    socket.on("close", disconnected.resolve);
  });
  await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
  const address = host.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const execution = new StatusExecution();
  try {
    const rejected = expect(
      execution.probe(bambuAdapter, {
        host: "127.0.0.1",
        port: address.port,
        serial: "ABC123456",
        access_code: "12345678",
      }),
    ).rejects.toThrow("Printer status execution stopped");
    await entered.promise;
    expect(execution.snapshot()).toEqual({
      state: "running",
      tasks: [{ id: 1, provider: "bambu", operation: "probe" }],
    });
    await execution.stop();
    await rejected;
    await disconnected.promise;
    expect(execution.snapshot()).toEqual({ state: "stopped", tasks: [] });
  } finally {
    await execution.stop();
    await new Promise<void>((resolve) => host.close(() => resolve()));
  }
});

it("retains work until cleanup joins, rejects late results, and isolates another runtime", async () => {
  const cleanup = barrier();
  const entered = barrier();
  const adapter: IntegrationAdapter = {
    type: "moonraker",
    testConnection: async () => ({ ok: true, message: "Connected" }),
    getStatus: async (_config, permit) => {
      permit.joinTransport(cleanup.promise);
      entered.resolve();
      return { state: "idle", message: "Idle" };
    },
  };
  const execution = new StatusExecution(1);
  const other = new StatusExecution();
  const rejected = expect(execution.probe(adapter, {})).rejects.toThrow(
    "Printer status execution stopped",
  );
  await entered.promise;
  await expect(execution.probe(adapter, {})).rejects.toThrow(
    "Printer status execution capacity reached",
  );
  const joined = execution.stop();
  expect(execution.snapshot()).toEqual({
    state: "stopping",
    tasks: [{ id: 1, provider: "moonraker", operation: "probe" }],
  });
  expect(await other.test(adapter, {})).toEqual({ ok: true, message: "Connected" });
  cleanup.resolve();
  await joined;
  await rejected;
  expect(execution.snapshot()).toEqual({ state: "stopped", tasks: [] });
  expect(other.snapshot()).toEqual({ state: "running", tasks: [] });
  await other.stop();
});
