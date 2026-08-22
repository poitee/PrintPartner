import { afterEach, describe, expect, it, vi } from "vitest";
import { moonrakerAdapter } from "./moonraker.js";

describe("moonrakerAdapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("testConnection reports klippy state and sends API key headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: { klippy_state: "ready" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await moonrakerAdapter.testConnection({
      base_url: "http://127.0.0.1:7125",
      api_key: "test-api-key",
    });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("klippy: ready");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("X-Api-Key")).toBe("test-api-key");
    expect(headers.get("Authorization")).toBeNull();
  });

  it("getStatus maps print_stats and virtual_sdcard progress", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          result: {
            status: {
              print_stats: { state: "printing", filename: "frame_x.gcode" },
              virtual_sdcard: { progress: 0.42 },
            },
          },
        }),
      }),
    );

    const status = await moonrakerAdapter.getStatus!({
      base_url: "http://127.0.0.1:7125",
    });
    expect(status.state).toBe("printing");
    expect(status.progress).toBe(42);
    expect(status.filename).toBe("frame_x.gcode");
  });

  it("getStatus maps print_stats complete distinctly from idle", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          result: {
            status: {
              print_stats: { state: "complete", filename: "frame_x.gcode" },
              virtual_sdcard: { progress: 1 },
            },
          },
        }),
      }),
    );

    const status = await moonrakerAdapter.getStatus!({
      base_url: "http://127.0.0.1:7125",
    });
    expect(status.state).toBe("complete");
    expect(status.filename).toBe("frame_x.gcode");
  });

  it("getStatus maps cancelled to idle (no auto-checkoff)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          result: {
            status: {
              print_stats: { state: "cancelled", filename: "frame_x.gcode" },
            },
          },
        }),
      }),
    );

    const status = await moonrakerAdapter.getStatus!({
      base_url: "http://127.0.0.1:7125",
    });
    expect(status.state).toBe("idle");
  });

  it("getStatus maps unrecognized print states to unknown (not idle)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          result: {
            status: {
              print_stats: { state: "klippy_shutdown", filename: "x.gcode" },
            },
          },
        }),
      }),
    );

    const status = await moonrakerAdapter.getStatus!({
      base_url: "http://127.0.0.1:7125",
    });
    expect(status.state).toBe("unknown");
  });

  it("does not forward API key across cross-origin redirects", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 302,
        headers: new Headers({ location: "http://192.168.1.50:7125/server/info" }),
        arrayBuffer: async () => new ArrayBuffer(0),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ result: { klippy_state: "ready" } }),
        arrayBuffer: async () => new ArrayBuffer(0),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await moonrakerAdapter.testConnection({
      base_url: "http://127.0.0.1:7125",
      api_key: "secret-key",
    });
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const firstHeaders = new Headers((fetchMock.mock.calls[0]![1] as RequestInit).headers);
    expect(firstHeaders.get("X-Api-Key")).toBe("secret-key");

    expect(String(fetchMock.mock.calls[1]![0])).toBe("http://192.168.1.50:7125/server/info");
    const secondHeaders = new Headers((fetchMock.mock.calls[1]![1] as RequestInit).headers);
    expect(secondHeaders.get("X-Api-Key")).toBeNull();
    expect(secondHeaders.get("Authorization")).toBeNull();
  });

  it("uploadFile posts multipart then starts print when requested", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: { item: { path: "frame_x.gcode" } } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: "ok" }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await moonrakerAdapter.uploadFile!(
      { base_url: "http://127.0.0.1:7125" },
      new TextEncoder().encode("; gcode"),
      "frame_x.gcode",
      { start: true },
    );
    expect(result.ok).toBe(true);
    expect(result.started).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/server/files/upload");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/printer/print/start");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("frame_x.gcode");
  });

  it("uploadFile without start does not call print/start", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await moonrakerAdapter.uploadFile!(
      { base_url: "http://127.0.0.1:7125" },
      new TextEncoder().encode("; gcode"),
      "only_upload.gcode",
      { start: false },
    );
    expect(result.ok).toBe(true);
    expect(result.started).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uploadFile accepts { path } via openAsBlob", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "mr-upload-"));
    const path = join(dir, "from_disk.gcode");
    writeFileSync(path, "; from disk");
    try {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await moonrakerAdapter.uploadFile!(
        { base_url: "http://127.0.0.1:7125" },
        { path },
        "from_disk.gcode",
        { start: false },
      );
      expect(result.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const init = fetchMock.mock.calls[0]![1] as RequestInit;
      expect(init.body).toBeInstanceOf(FormData);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
