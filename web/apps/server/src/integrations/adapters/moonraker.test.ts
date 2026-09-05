import { afterEach, describe, expect, it, vi } from "vitest";
import { moonrakerAdapter } from "./moonraker.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

describe("moonrakerAdapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("testConnection reports klippy state and sends API key headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ result: { klippy_state: "ready" } }),
    );
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
      vi.fn().mockResolvedValue(jsonResponse({
          result: {
            status: {
              print_stats: { state: "printing", filename: "frame_x.gcode" },
              virtual_sdcard: { progress: 0.42 },
            },
          },
        })),
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
      vi.fn().mockResolvedValue(jsonResponse({
          result: {
            status: {
              print_stats: { state: "complete", filename: "frame_x.gcode" },
              virtual_sdcard: { progress: 1 },
            },
          },
        })),
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
      vi.fn().mockResolvedValue(jsonResponse({
          result: {
            status: {
              print_stats: { state: "cancelled", filename: "frame_x.gcode" },
            },
          },
        })),
    );

    const status = await moonrakerAdapter.getStatus!({
      base_url: "http://127.0.0.1:7125",
    });
    expect(status.state).toBe("idle");
  });

  it("getStatus maps unrecognized print states to unknown (not idle)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({
          result: {
            status: {
              print_stats: { state: "klippy_shutdown", filename: "x.gcode" },
            },
          },
        })),
    );

    const status = await moonrakerAdapter.getStatus!({
      base_url: "http://127.0.0.1:7125",
    });
    expect(status.state).toBe("unknown");
  });

  it("does not forward API key across cross-origin redirects", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: "http://192.168.1.50:7125/server/info" },
      }))
      .mockResolvedValueOnce(jsonResponse({ result: { klippy_state: "ready" } }));
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
      .mockResolvedValueOnce(jsonResponse({ result: { item: { path: "frame_x.gcode" } } }))
      .mockResolvedValueOnce(jsonResponse({ result: "ok" }));
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
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
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
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
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

  it("browses the storage root through the directory endpoint", async () => {
    // Moonraker's HTTP API wraps success payloads in `result`.
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      result: {
        dirs: [{ dirname: "jobs", modified: 1_725_000_000, size: 4096, permissions: "rw" }],
        files: [{ filename: "bracket.gcode", modified: 1_725_000_100, size: 8192, permissions: "rw" }],
        disk_usage: { total: 1, used: 1, free: 0 },
        root_info: { name: "gcodes", permissions: "rw" },
      },
    }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const listing = await moonrakerAdapter.files!.browse({ base_url: "http://127.0.0.1:7125" }, "");
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "http://127.0.0.1:7125/server/files/directory?path=gcodes&extended=true",
    );
    expect(listing).toEqual({
      path: "",
      entries: [
        {
          kind: "directory",
          path: "jobs",
          name: "jobs",
          modified_at: new Date(1_725_000_000_000).toISOString(),
        },
        {
          kind: "file",
          path: "bracket.gcode",
          name: "bracket.gcode",
          size_bytes: 8192,
          modified_at: new Date(1_725_000_100_000).toISOString(),
        },
      ],
    });
  });

  it("browses a nested directory and opens a child by its relative path", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        result: {
          dirs: [],
          files: [{ filename: "frame x.bgcode", modified: 1_725_000_000, size: 4096 }],
        },
      }), { headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response("; gcode", {
        headers: { "content-type": "application/octet-stream" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const config = { base_url: "http://127.0.0.1:7125" };
    const listing = await moonrakerAdapter.files!.browse(config, "jobs");
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "http://127.0.0.1:7125/server/files/directory?path=gcodes/jobs&extended=true",
    );
    expect(listing.path).toBe("jobs");
    expect(listing.entries).toEqual([expect.objectContaining({
      kind: "file",
      path: "jobs/frame x.bgcode",
      name: "frame x.bgcode",
      size_bytes: 4096,
    })]);

    const opened = await moonrakerAdapter.files!.open(config, listing.entries[0]!.path);
    expect(await opened.text()).toBe("; gcode");
    expect(String(fetchMock.mock.calls[1]![0])).toContain(
      "/server/files/gcodes/jobs/frame%20x.bgcode",
    );
  });

  it("leaves missing provider metadata absent instead of reporting zero", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      result: {
        dirs: [{ dirname: "empty", modified: 0, size: 0 }],
        files: [{ filename: "unknown.gcode", modified: 0 }],
      },
    }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const listing = await moonrakerAdapter.files!.browse({ base_url: "http://127.0.0.1:7125" }, "");
    expect(listing.entries.map((entry) => Object.keys(entry).sort())).toEqual([
      ["kind", "name", "path"],
      ["kind", "name", "path"],
    ]);
    expect(listing.entries).toEqual([
      { kind: "directory", path: "empty", name: "empty" },
      { kind: "file", path: "unknown.gcode", name: "unknown.gcode" },
    ]);
  });

  it("refuses a traversal path instead of asking the host for it", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      moonrakerAdapter.files!.browse({ base_url: "http://127.0.0.1:7125" }, "jobs/../../etc"),
    ).rejects.toThrow("Invalid Moonraker print-file path");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serves an MJPEG camera resolved against the Moonraker origin", async () => {
    const webcams = {
      result: {
        webcams: [{
          uid: "cam-one",
          name: "Toolhead",
          service: "mjpegstreamer",
          enabled: true,
          stream_url: "/webcam/?action=stream",
          snapshot_url: "/webcam/?action=snapshot",
          aspect_ratio: "16:9",
        }],
      },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(webcams), {
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(webcams), {
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response("frame", {
        headers: { "content-type": "multipart/x-mixed-replace" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const config = {
      base_url: "http://127.0.0.1:7125",
      api_key: "moonraker-secret",
    };
    expect(await moonrakerAdapter.cameras!.list(config)).toEqual([{
      id: "cam-one",
      name: "Toolhead",
      view: "mjpeg",
      service: "mjpegstreamer",
      aspect_ratio: "16:9",
    }]);
    await moonrakerAdapter.cameras!.open(config, "cam-one");
    expect(String(fetchMock.mock.calls[2]![0])).toBe(
      "http://127.0.0.1:7125/webcam/?action=stream",
    );
  });

  it("drops a cross-origin camera from the list and refuses to open it", async () => {
    const webcams = {
      result: {
        webcams: [{
          uid: "cam-elsewhere",
          name: "Elsewhere",
          service: "mjpegstreamer",
          enabled: true,
          stream_url: "http://camera.lan/stream",
          snapshot_url: "http://camera.lan/snapshot",
        }],
      },
    };
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify(webcams), {
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const config = { base_url: "http://127.0.0.1:7125", api_key: "moonraker-secret" };
    expect(await moonrakerAdapter.cameras!.list(config)).toEqual([]);
    await expect(moonrakerAdapter.cameras!.open(config, "cam-elsewhere")).rejects.toThrow(
      "Moonraker advertised a cross-origin camera URL",
    );
    // Only the two webcam-list reads. The advertised host is never contacted.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
