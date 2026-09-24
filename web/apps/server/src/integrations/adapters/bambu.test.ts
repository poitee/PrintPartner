import { EventEmitter } from "node:events";
import { createServer, type LookupFunction } from "node:net";
import mqtt, { type IClientOptions } from "mqtt";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCheckedLookup } from "../../lib/outbound-url.js";
import {
  bambuAdapter,
  mapBambuGcodeState,
  setBambuMqttConnectForTests,
  shouldRejectUnauthorizedTls,
  statusFromBambuPrint,
  type BambuMqttConnect,
} from "./bambu.js";

class FakeMqttClient extends EventEmitter {
  subscribe = vi.fn((_topic: string, cb?: (err?: Error | null) => void) => {
    cb?.(null);
    return this;
  });
  publish = vi.fn(
    (
      _topic: string,
      _payload: string,
      _opts?: unknown,
      cb?: (err?: Error | null) => void,
    ) => {
      cb?.(null);
      return this;
    },
  );
  end = vi.fn((_force?: boolean) => this);
  override removeAllListeners(): this {
    super.removeAllListeners();
    return this;
  }
}

function mockMqttThatReports(print: Record<string, unknown>): BambuMqttConnect {
  return (_url, opts) => {
    expect(opts?.username).toBe("bblp");
    expect(opts?.rejectUnauthorized).toBe(false); // private LAN host
    const client = new FakeMqttClient();
    queueMicrotask(() => client.emit("connect"));
    const publish = client.publish;
    client.publish = vi.fn((topic, payload, o, cb) => {
      publish(topic, payload, o, cb);
      queueMicrotask(() => {
        const onMessage = client.listeners("message")[0] as
          | ((topic: string, payload: Buffer) => void)
          | undefined;
        onMessage?.(
          "device/report",
          Buffer.from(JSON.stringify({ print })),
        );
      });
      return client;
    }) as typeof client.publish;
    return client as unknown as ReturnType<BambuMqttConnect>;
  };
}

describe("mapBambuGcodeState", () => {
  it("maps known tokens", () => {
    expect(mapBambuGcodeState("IDLE")).toBe("idle");
    expect(mapBambuGcodeState("RUNNING")).toBe("printing");
    expect(mapBambuGcodeState("PREPARE")).toBe("printing");
    expect(mapBambuGcodeState("PAUSE")).toBe("paused");
    expect(mapBambuGcodeState("FINISH")).toBe("complete");
    expect(mapBambuGcodeState("FAILED")).toBe("error");
    expect(mapBambuGcodeState("OFFLINE")).toBe("offline");
  });
});

describe("statusFromBambuPrint", () => {
  it("maps progress, filename, and ETA minutes → seconds", () => {
    const status = statusFromBambuPrint({
      gcode_state: "RUNNING",
      mc_percent: 42,
      mc_remaining_time: 12,
      subtask_name: "frame_x.3mf",
      nozzle_temper: 218.4,
      nozzle_target_temper: 220,
      bed_temper: 59.7,
      bed_target_temper: 60,
    });
    expect(status.state).toBe("printing");
    expect(status.progress).toBe(42);
    expect(status.filename).toBe("frame_x.3mf");
    expect(status.eta_seconds).toBe(720);
    expect(status.nozzle_temperature_c).toBe(218.4);
    expect(status.nozzle_target_c).toBe(220);
    expect(status.bed_temperature_c).toBe(59.7);
    expect(status.bed_target_c).toBe(60);
  });

  it("maps FINISH to complete without progress", () => {
    const status = statusFromBambuPrint({
      gcode_state: "FINISH",
      mc_percent: 100,
      gcode_file: "done.3mf",
    });
    expect(status.state).toBe("complete");
    expect(status.progress).toBeUndefined();
    expect(status.filename).toBe("done.3mf");
  });
});

describe("shouldRejectUnauthorizedTls", () => {
  it("disables verify only for private IP literals", () => {
    expect(shouldRejectUnauthorizedTls("192.168.1.60")).toBe(false);
    expect(shouldRejectUnauthorizedTls("10.0.0.5")).toBe(false);
    expect(shouldRejectUnauthorizedTls("8.8.8.8")).toBe(true);
    expect(shouldRejectUnauthorizedTls("printer.local")).toBe(true);
  });
});

describe("bambuAdapter", () => {
  afterEach(() => {
    setBambuMqttConnectForTests(null);
    vi.restoreAllMocks();
  });

  it("passes the checked lookup through MQTT.js to a TLS socket", async () => {
    const previous = process.env.MQTTJS_SOCKS_PROXY;
    delete process.env.MQTTJS_SOCKS_PROXY;
    const server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP server");
    let lookups = 0;
    const options = {
      protocol: "mqtts",
      reconnectPeriod: 0,
      connectTimeout: 1_000,
      lookup: createCheckedLookup({
        allowPrivate: true,
        lookupFn: async () => {
          lookups++;
          return [{ address: "127.0.0.1", family: 4 }];
        },
      }),
    } satisfies IClientOptions & { lookup: LookupFunction };
    const connectedSocket = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("MQTT did not use checked DNS")), 1_500);
      server.once("connection", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    const client = mqtt.connect(`mqtts://checked.invalid:${address.port}`, options);
    client.on("error", () => {});

    try {
      await connectedSocket;
      expect(lookups).toBeGreaterThan(0);
    } finally {
      client.end(true);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (previous !== undefined) process.env.MQTTJS_SOCKS_PROXY = previous;
    }
  });

  it("requires host, access_code, and serial", async () => {
    expect((await bambuAdapter.testConnection({})).ok).toBe(false);
    expect(
      (await bambuAdapter.testConnection({ host: "192.168.1.80" })).message,
    ).toMatch(/access_code/i);
    expect(
      (
        await bambuAdapter.testConnection({
          host: "192.168.1.80",
          access_code: "12345678",
        })
      ).message,
    ).toMatch(/serial/i);
  });

  it("rejects serial values with MQTT topic metacharacters", async () => {
    const result = await bambuAdapter.testConnection({
      host: "192.168.1.80",
      access_code: "12345678",
      serial: "01P00/#",
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/serial/i);
  });

  it("rejects redacted access_code placeholder", async () => {
    const result = await bambuAdapter.testConnection({
      host: "192.168.1.80",
      access_code: "****",
      serial: "01P00A000000001",
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/access_code/i);
  });

  it("testConnection uses MQTT pushall and maps idle report", async () => {
    const connect = vi.fn(mockMqttThatReports({ gcode_state: "IDLE", mc_percent: 0 }));
    setBambuMqttConnectForTests(connect);

    const result = await bambuAdapter.testConnection({
      host: "192.168.1.80",
      access_code: "lan-code",
      serial: "01P00A000000001",
    });
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/Connected/i);
    expect(result.message).toMatch(/Idle/i);

    expect(connect).toHaveBeenCalledWith(
      "mqtts://192.168.1.80:8883",
      expect.objectContaining({ password: "lan-code" }),
    );
    const mqttOptions = connect.mock.calls[0]?.[1];
    if (!mqttOptions || !("lookup" in mqttOptions) || typeof mqttOptions.lookup !== "function") {
      throw new Error("Bambu MQTT must validate DNS at socket connection");
    }
    expect(Object.keys(mqttOptions)).toContain("lookup");
    const client = connect.mock.results[0]!.value as FakeMqttClient;
    expect(client.subscribe).toHaveBeenCalledWith(
      "device/01P00A000000001/report",
      expect.any(Function),
    );
    expect(client.publish).toHaveBeenCalledWith(
      "device/01P00A000000001/request",
      expect.stringContaining("pushall"),
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("refuses MQTT proxy routing that would skip the checked DNS lookup", async () => {
    const previous = process.env.MQTTJS_SOCKS_PROXY;
    process.env.MQTTJS_SOCKS_PROXY = "socks5://127.0.0.1:1080";
    const connect = vi.fn(mockMqttThatReports({ gcode_state: "IDLE" }));
    setBambuMqttConnectForTests(connect);

    try {
      const result = await bambuAdapter.testConnection({
        host: "192.168.1.80",
        access_code: "lan-code",
        serial: "01P00A000000001",
      });
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/proxy routing/);
      expect(connect).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.MQTTJS_SOCKS_PROXY;
      else process.env.MQTTJS_SOCKS_PROXY = previous;
    }
  });

  it("getStatus maps RUNNING progress from MQTT report", async () => {
    setBambuMqttConnectForTests(
      mockMqttThatReports({
        gcode_state: "RUNNING",
        mc_percent: "67",
        subtask_name: "kit_plate.3mf",
        mc_remaining_time: "5",
      }),
    );

    const status = await bambuAdapter.getStatus!({
      host: "10.0.0.20",
      access_code: "87654321",
      serial: "01P00A000000099",
    });
    expect(status.state).toBe("printing");
    expect(status.progress).toBe(67);
    expect(status.filename).toBe("kit_plate.3mf");
    expect(status.eta_seconds).toBe(300);
  });

  it("does not crash when the mqtt client emits a late error after settling", async () => {
    let client!: FakeMqttClient;
    setBambuMqttConnectForTests((_url) => {
      client = new FakeMqttClient();
      return client as unknown as ReturnType<BambuMqttConnect>;
    });

    const statusPromise = bambuAdapter.getStatus!({
      host: "192.168.1.90",
      access_code: "lan-code",
      serial: "01P00A000000002",
    });

    // Let resolveConnection's async validation run before the mqtt client exists.
    await new Promise((r) => setTimeout(r, 0));

    // Connection refused: "close" fires immediately, before any "connect".
    client.emit("close");
    const status = await statusPromise;
    expect(status.state).toBe("offline");

    // The real mqtt client's internal connack-timeout can still fire an
    // "error" after we've already resolved via "close" above. With zero
    // listeners left, Node would throw synchronously and crash the process.
    expect(() => client.emit("error", new Error("connack timeout"))).not.toThrow();
  });

  it("listDevices returns configured serial without MQTT", async () => {
    const devices = await bambuAdapter.listDevices!({
      host: "192.168.1.80",
      serial: "01P00A000000001",
      access_code: "x",
    });
    expect(devices).toEqual([
      {
        id: "01P00A000000001",
        name: "Bambu @ 192.168.1.80",
        type: "bambu",
        status: "configured",
      },
    ]);
  });

  it("does not implement uploadFile (status-only Phase E)", () => {
    expect(bambuAdapter.uploadFile).toBeUndefined();
  });
});
