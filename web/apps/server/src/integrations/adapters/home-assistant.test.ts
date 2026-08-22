import { afterEach, describe, expect, it, vi } from "vitest";
import { homeAssistantAdapter } from "./home-assistant.js";

const BASE_URL = "http://192.168.1.10:8123";
const TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test-token";

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    base_url: BASE_URL,
    token: TOKEN,
    entity_id: "sensor.printer_state",
    ...overrides,
  };
}

describe("homeAssistantAdapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // testConnection
  // ---------------------------------------------------------------------------
  describe("testConnection", () => {
    it("returns ok with version when /api/ is reachable and entity_id is valid", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({ message: "API running.", version: "2024.1.0" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            state: "idle",
            attributes: { friendly_name: "Printer State" },
          }),
        });
      vi.stubGlobal("fetch", fetchMock);

      const result = await homeAssistantAdapter.testConnection(makeConfig());
      expect(result.ok).toBe(true);
      expect(result.message).toContain("2024.1.0");
      expect(result.message).toContain("sensor.printer_state");
      expect(result.message).toContain("idle");
    });

    it("sends Bearer token in Authorization header", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ message: "API running." }),
      });
      vi.stubGlobal("fetch", fetchMock);

      await homeAssistantAdapter.testConnection(
        makeConfig({ entity_id: undefined }),
      );

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = new Headers(init.headers);
      expect(headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
    });

    it("returns ok=false when base_url is missing", async () => {
      const result = await homeAssistantAdapter.testConnection(
        makeConfig({ base_url: "" }),
      );
      expect(result.ok).toBe(false);
      expect(result.message).toContain("base_url");
    });

    it("returns ok=false when token is missing", async () => {
      const result = await homeAssistantAdapter.testConnection(
        makeConfig({ token: undefined }),
      );
      expect(result.ok).toBe(false);
      expect(result.message).toContain("token");
    });

    it("returns ok=false when HA returns 401", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 401,
          headers: new Headers(),
        }),
      );
      const result = await homeAssistantAdapter.testConnection(makeConfig());
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/unauthorized/i);
    });

    it("returns ok=false when entity_id is not found", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({ message: "API running." }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          headers: new Headers(),
          json: async () => ({}),
        });
      vi.stubGlobal("fetch", fetchMock);

      const result = await homeAssistantAdapter.testConnection(makeConfig());
      expect(result.ok).toBe(false);
      expect(result.message).toContain("not found");
    });

    it("does not forward token on cross-origin redirect", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 302,
          headers: new Headers({ location: "http://192.168.1.99:8123/api/" }),
          arrayBuffer: async () => new ArrayBuffer(0),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({ message: "API running." }),
        });
      vi.stubGlobal("fetch", fetchMock);

      const result = await homeAssistantAdapter.testConnection(
        makeConfig({ entity_id: undefined }),
      );
      expect(result.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // First hop — token present (same origin)
      const firstHeaders = new Headers(
        (fetchMock.mock.calls[0]![1] as RequestInit).headers,
      );
      expect(firstHeaders.get("Authorization")).toBe(`Bearer ${TOKEN}`);

      // Second hop — cross-origin, token must be stripped
      const secondHeaders = new Headers(
        (fetchMock.mock.calls[1]![1] as RequestInit).headers,
      );
      expect(secondHeaders.get("Authorization")).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // getStatus / mapHaState
  // ---------------------------------------------------------------------------
  describe("getStatus", () => {
    it("maps HA 'printing' state with progress and filename", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            state: "printing",
            attributes: { progress: 42, filename: "benchy.gcode" },
          }),
        }),
      );

      const status = await homeAssistantAdapter.getStatus!(makeConfig());
      expect(status.state).toBe("printing");
      expect(status.progress).toBe(42);
      expect(status.filename).toBe("benchy.gcode");
      expect(status.message).toContain("benchy.gcode");
    });

    it("maps HA 'paused' state and keeps progress", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            state: "paused",
            attributes: { progress: 67 },
          }),
        }),
      );

      const status = await homeAssistantAdapter.getStatus!(makeConfig());
      expect(status.state).toBe("paused");
      expect(status.progress).toBe(67);
    });

    it("maps HA 'done' state to complete and clears progress", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            state: "done",
            attributes: { progress: 100, filename: "test.gcode" },
          }),
        }),
      );

      const status = await homeAssistantAdapter.getStatus!(makeConfig());
      expect(status.state).toBe("complete");
      // progress is not surfaced for complete state
      expect(status.progress).toBeUndefined();
    });

    it("maps HA 'idle' state", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({ state: "idle", attributes: {} }),
        }),
      );

      const status = await homeAssistantAdapter.getStatus!(makeConfig());
      expect(status.state).toBe("idle");
    });

    it("maps HA 'unavailable' state to offline", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({ state: "unavailable", attributes: {} }),
        }),
      );

      const status = await homeAssistantAdapter.getStatus!(makeConfig());
      expect(status.state).toBe("offline");
    });

    it("returns offline when entity_id not found (HTTP 404)", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 404,
          headers: new Headers(),
        }),
      );

      const status = await homeAssistantAdapter.getStatus!(makeConfig());
      expect(status.state).toBe("offline");
      expect(status.message).toContain("not found");
    });

    it("returns offline when entity_id is missing from config", async () => {
      const status = await homeAssistantAdapter.getStatus!(
        makeConfig({ entity_id: undefined }),
      );
      expect(status.state).toBe("offline");
      expect(status.message).toContain("entity_id");
    });

    it("returns offline when token is missing", async () => {
      const status = await homeAssistantAdapter.getStatus!(
        makeConfig({ token: undefined }),
      );
      expect(status.state).toBe("offline");
      expect(status.message).toContain("token");
    });

    it("normalises progress expressed as a string percentage", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            state: "printing",
            attributes: { progress: "75.8" },
          }),
        }),
      );

      const status = await homeAssistantAdapter.getStatus!(makeConfig());
      expect(status.state).toBe("printing");
      expect(status.progress).toBe(76);
    });

    it("catches fetch errors and returns offline", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
      );

      const status = await homeAssistantAdapter.getStatus!(makeConfig());
      expect(status.state).toBe("offline");
      expect(status.message).toContain("ECONNREFUSED");
    });
  });

  // ---------------------------------------------------------------------------
  // listDevices
  // ---------------------------------------------------------------------------
  describe("listDevices", () => {
    it("returns a single device entry when entity_id is configured", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({ state: "idle", attributes: {} }),
        }),
      );

      const devices = await homeAssistantAdapter.listDevices!(makeConfig());
      expect(devices).toHaveLength(1);
      expect(devices[0]!.id).toBe("sensor.printer_state");
      expect(devices[0]!.type).toBe("home_assistant");
      expect(devices[0]!.status).toBe("idle");
    });

    it("returns empty array when entity_id is missing", async () => {
      const devices = await homeAssistantAdapter.listDevices!(
        makeConfig({ entity_id: undefined }),
      );
      expect(devices).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // uploadFile — webhook mode
  // ---------------------------------------------------------------------------
  describe("uploadFile", () => {
    it("posts multipart form to HA webhook endpoint", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => "",
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await homeAssistantAdapter.uploadFile!(
        makeConfig({ webhook_id: "print_received" }),
        new TextEncoder().encode("; gcode"),
        "part.gcode",
      );

      expect(result.ok).toBe(true);
      expect(result.message).toContain("part.gcode");
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
        "/api/webhook/print_received",
      );
      const init = fetchMock.mock.calls[0]![1] as RequestInit;
      expect(init.method).toBe("POST");
      expect(init.body).toBeInstanceOf(FormData);
    });

    it("returns ok=false when webhook_id is not configured", async () => {
      const result = await homeAssistantAdapter.uploadFile!(
        makeConfig(),
        new TextEncoder().encode("; gcode"),
        "part.gcode",
      );
      expect(result.ok).toBe(false);
      expect(result.message).toContain("webhook_id");
    });

    it("returns ok=false when HA webhook returns a non-ok status", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          headers: new Headers(),
          text: async () => "Internal Server Error",
        }),
      );

      const result = await homeAssistantAdapter.uploadFile!(
        makeConfig({ webhook_id: "print_received" }),
        new TextEncoder().encode("; gcode"),
        "part.gcode",
      );
      expect(result.ok).toBe(false);
      expect(result.message).toContain("500");
    });

    it("accepts { path } source via openAsBlob", async () => {
      const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { tmpdir } = await import("node:os");
      const dir = mkdtempSync(join(tmpdir(), "ha-upload-"));
      const path = join(dir, "from_disk.gcode");
      writeFileSync(path, "; from disk");
      try {
        const fetchMock = vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          headers: new Headers(),
          text: async () => "",
        });
        vi.stubGlobal("fetch", fetchMock);

        const result = await homeAssistantAdapter.uploadFile!(
          makeConfig({ webhook_id: "print_received" }),
          { path },
          "from_disk.gcode",
        );
        expect(result.ok).toBe(true);
        expect(fetchMock.mock.calls[0]![1] as RequestInit).toMatchObject({
          method: "POST",
        });
        expect(
          (fetchMock.mock.calls[0]![1] as RequestInit).body,
        ).toBeInstanceOf(FormData);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
