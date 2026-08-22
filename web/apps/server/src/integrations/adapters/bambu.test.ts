import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    });
    expect(status.state).toBe("printing");
    expect(status.progress).toBe(42);
    expect(status.filename).toBe("frame_x.3mf");
    expect(status.eta_seconds).toBe(720);
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
