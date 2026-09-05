import { afterEach, describe, expect, it, vi } from "vitest";
import { prusalinkAdapter } from "./prusalink.js";

function digest401() {
  return new Response(null, {
    status: 401,
    headers: {
      "www-authenticate":
        'Digest realm="Printer API", nonce="abc", qop="auth", algorithm=MD5',
    },
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

const prusaConfig = {
  base_url: "http://127.0.0.1",
  username: "maker",
  password: "printer-key",
};

/**
 * A PrusaLink with one available `local` storage holding a `jobs` subfolder, a
 * print file with no size or timestamp, and a firmware blob. No storage root is
 * configured, so browsing has to discover `local` from /api/v1/storage.
 */
function storageFetchMock({ downloadRef = "/api/files/local/jobs/BRACK~1.BGC/raw" } = {}) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/api/v1/status")) return digest401();
    if (url.endsWith("/api/v1/storage")) {
      return new Response(JSON.stringify({
        storage_list: [{ path: "/local", available: true }],
      }), { headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/api/v1/files/local/")) {
      return new Response(JSON.stringify({
        type: "FOLDER",
        children: [
          { name: "jobs", type: "FOLDER", m_timestamp: 1_724_000_000 },
          { name: "SPOOL~1.GCO", display_name: "spool-holder.gcode", type: "PRINT_FILE" },
          { name: "firmware.bbf", type: "FIRMWARE", size: 4096 },
        ],
      }), { headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/api/v1/files/local/jobs")) {
      return new Response(JSON.stringify({
        type: "FOLDER",
        children: [{
          name: "BRACK~1.BGC",
          display_name: "bracket.bgcode",
          type: "PRINT_FILE",
          size: 8192,
          m_timestamp: 1_725_000_000,
        }],
      }), { headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/api/v1/files/local/jobs/BRACK~1.BGC")) {
      return new Response(JSON.stringify({
        type: "PRINT_FILE",
        refs: { download: downloadRef },
      }), { headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/api/files/local/jobs/BRACK~1.BGC/raw")) {
      return new Response("binary-gcode");
    }
    return new Response(null, { status: 404 });
  });
}

function useFakeDownloadClock() {
  vi.useFakeTimers();
  const nativeTimeout = AbortSignal.timeout;
  vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
    if (milliseconds !== 120_000) return nativeTimeout(milliseconds);
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort(new DOMException("The operation timed out", "TimeoutError"));
    }, milliseconds);
    return controller.signal;
  });
}

function stubDownloadResponse(response: (signal: AbortSignal) => Response) {
  const fallback = storageFetchMock();
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
    if (!String(input).endsWith("/api/files/local/jobs/BRACK~1.BGC/raw")) {
      return fallback(input);
    }
    const signal = init?.signal;
    if (!signal) throw new Error("The download request must have an abort signal");
    return response(signal);
  }));
}

describe("prusalinkAdapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([false, true])("reads slow directory streams, stalled=%s", async (stalled) => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
      return controller.signal;
    });
    const chunks = ['{"type":"FOLDER",', '"children":[', '{"name":"part.bgcode",',
      '"type":"PRINT_FILE"}', ']}'];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith("/api/v1/status")) return digest401();
      const signal = init?.signal;
      if (!signal) throw new Error("Expected bounded directory request");
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          let index = 0;
          const timer = setInterval(() => {
            if (stalled) {
              controller.enqueue(new Uint8Array());
              return;
            }
            controller.enqueue(new TextEncoder().encode(chunks[index++]));
            if (index === chunks.length) {
              clearInterval(timer);
              controller.close();
            }
          }, 5_000);
          signal.addEventListener("abort", () => {
            clearInterval(timer);
            controller.error(signal.reason);
          }, { once: true });
        },
      }));
    }));
    try {
      const result = prusalinkAdapter.files!.browse({ ...prusaConfig, storage: "usb" }, "")
        .then((listing) => ({ kind: "complete", listing }), (error: unknown) => ({ kind: "failed", error }));
      await vi.advanceTimersByTimeAsync(25_000);
      if (stalled) {
        expect(await result).toMatchObject({ kind: "failed", error: { name: "TimeoutError" } });
      } else {
        expect(await result).toMatchObject({ kind: "complete", listing: {
          entries: [{ name: "part.bgcode" }],
        } });
      }
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("requires password for testConnection", async () => {
    const result = await prusalinkAdapter.testConnection({
      base_url: "http://127.0.0.1",
      username: "maker",
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/password/i);
  });

  it("testConnection follows Digest challenge then reads /info", async () => {
    const fetchMock = vi
      .fn()
      // obtainDigestChallenge GET /status
      .mockResolvedValueOnce(digest401())
      // GET /info with Authorization
      .mockResolvedValueOnce(jsonResponse({ name: "Prusa MK4" }))
      // readStatus: challenge GET /status
      .mockResolvedValueOnce(digest401())
      // readStatus: GET /status with Authorization
      .mockResolvedValueOnce(jsonResponse({ printer: { state: "IDLE" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await prusalinkAdapter.testConnection({
      base_url: "http://127.0.0.1",
      username: "maker",
      password: "printer-key",
    });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Prusa MK4");

    const probe = fetchMock.mock.calls[0];
    expect(String(probe![0])).toContain("/api/v1/status");
    expect((probe![1] as RequestInit).method).toBe("GET");

    const authCall = fetchMock.mock.calls.find(
      (call) =>
        String(call[0]).includes("/api/v1/info") &&
        new Headers((call[1] as RequestInit | undefined)?.headers).has("Authorization"),
    );
    expect(authCall).toBeTruthy();
    const headers = new Headers((authCall![1] as RequestInit).headers);
    expect(headers.get("Authorization")).toMatch(/^Digest /);
  });

  it("uploadFile probes via GET /status then PUTs with body (never bodyless PUT)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(digest401())
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        headers: new Headers(),
        arrayBuffer: async () => new ArrayBuffer(0),
        text: async () => "",
      });
    vi.stubGlobal("fetch", fetchMock);

    const body = new TextEncoder().encode("; bgcode");
    const result = await prusalinkAdapter.uploadFile!(
      {
        base_url: "http://127.0.0.1",
        username: "",
        password: "printer-key",
      },
      body,
      "part.bgcode",
      { start: true },
    );
    expect(result.ok).toBe(true);
    expect(result.started).toBe(true);

    expect(String(fetchMock.mock.calls[0]![0])).toContain("/api/v1/status");
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe("GET");
    expect((fetchMock.mock.calls[0]![1] as RequestInit).body).toBeUndefined();

    const putAuthed = fetchMock.mock.calls.find(
      (call) =>
        (call[1] as RequestInit | undefined)?.method === "PUT" &&
        new Headers((call[1] as RequestInit).headers).has("Authorization"),
    );
    expect(putAuthed).toBeTruthy();
    expect(Buffer.isBuffer(putAuthed![1]!.body) || putAuthed![1]!.body instanceof Uint8Array).toBe(
      true,
    );
    expect(Buffer.from(putAuthed![1]!.body as Uint8Array).equals(Buffer.from(body))).toBe(true);
    const headers = new Headers((putAuthed![1] as RequestInit).headers);
    expect(headers.get("Print-After-Upload")).toBe("?1");
    expect(headers.get("Overwrite")).toBe("?1");
    expect(headers.get("Authorization")).toMatch(/^Digest /);
    expect(String(putAuthed![0])).toContain("/api/v1/files/usb/part.bgcode");

    // No bodyless PUT probes
    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit | undefined;
      if (init?.method === "PUT") {
        expect(init.body).toBeTruthy();
      }
    }
  });

  it("uploadFile accepts { path } via createReadStream", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "pl-upload-"));
    const path = join(dir, "disk.gcode");
    writeFileSync(path, "; streamed");
    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(digest401())
        .mockResolvedValueOnce({
          ok: true,
          status: 201,
          headers: new Headers(),
          arrayBuffer: async () => new ArrayBuffer(0),
          text: async () => "",
        });
      vi.stubGlobal("fetch", fetchMock);

      const result = await prusalinkAdapter.uploadFile!(
        {
          base_url: "http://127.0.0.1",
          username: "",
          password: "printer-key",
        },
        { path },
        "disk.gcode",
        { start: false },
      );
      expect(result.ok).toBe(true);

      const putAuthed = fetchMock.mock.calls.find(
        (call) =>
          (call[1] as RequestInit | undefined)?.method === "PUT" &&
          new Headers((call[1] as RequestInit).headers).has("Authorization"),
      );
      expect(putAuthed).toBeTruthy();
      const stream = putAuthed![1]!.body as import("node:fs").ReadStream;
      expect(typeof stream.pipe).toBe("function");
      // createReadStream opens lazily; wait so finally can delete without ENOENT.
      await new Promise<void>((resolve, reject) => {
        stream.once("open", () => {
          stream.destroy();
          resolve();
        });
        stream.once("error", reject);
      });
      const headers = new Headers((putAuthed![1] as RequestInit).headers);
      expect(headers.get("Content-Length")).toBe(String(Buffer.byteLength("; streamed")));
      expect(headers.get("Print-After-Upload")).toBe("?0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("getStatus maps PRINTING progress and prefers /job filename", async () => {
    const fetchMock = vi
      .fn()
      // status challenge + status
      .mockResolvedValueOnce(digest401())
      .mockResolvedValueOnce(jsonResponse({
          printer: { state: "PRINTING" },
          job: {
            progress: 33.3,
            time_remaining: 1200,
          },
        }))
      // job challenge + job (file lives here)
      .mockResolvedValueOnce(digest401())
      .mockResolvedValueOnce(jsonResponse({
          file: { display_name: "benchy.bgcode" },
        }));
    vi.stubGlobal("fetch", fetchMock);

    const status = await prusalinkAdapter.getStatus!({
      base_url: "http://127.0.0.1",
      password: "printer-key",
    });
    expect(status.state).toBe("printing");
    expect(status.progress).toBe(33);
    expect(status.filename).toBe("benchy.bgcode");
    expect(status.eta_seconds).toBe(1200);
    expect(
      fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/v1/job")),
    ).toBe(true);
  });

  it("getStatus maps READY to idle", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(digest401())
      .mockResolvedValueOnce(jsonResponse({ printer: { state: "READY" } }));
    vi.stubGlobal("fetch", fetchMock);

    const status = await prusalinkAdapter.getStatus!({
      base_url: "http://127.0.0.1",
      password: "printer-key",
    });
    expect(status.state).toBe("idle");
    expect(status.message).toBe("Idle");
    expect(
      fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/v1/job")),
    ).toBe(false);
  });

  it("getStatus maps FINISHED to complete", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(digest401())
      .mockResolvedValueOnce(jsonResponse({
          printer: { state: "FINISHED" },
          job: { file: { name: "done.bgcode" }, progress: 100 },
        }));
    vi.stubGlobal("fetch", fetchMock);

    const status = await prusalinkAdapter.getStatus!({
      base_url: "http://127.0.0.1",
      password: "printer-key",
    });
    expect(status.state).toBe("complete");
    expect(status.filename).toBe("done.bgcode");
  });

  it("reads object metadata when PrusaLink ignores the range request", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(digest401())
      .mockResolvedValueOnce(jsonResponse({
        state: "PRINTING",
        refs: { download: "/api/files/local/active.bgcode" },
      }))
      .mockResolvedValueOnce(digest401())
      .mockResolvedValueOnce(new Response(
        'objects_info={"objects":[{"name":"bracket.stl"}]} trailing gcode',
        {
          status: 200,
          headers: { "content-length": String(8 * 1024 * 1024) },
        },
      ));
    vi.stubGlobal("fetch", fetchMock);

    await expect(prusalinkAdapter.getObjectList!(prusaConfig)).resolves.toEqual([
      "bracket.stl",
    ]);
    const downloadRequest = fetchMock.mock.calls[3]?.[1] as RequestInit;
    expect(new Headers(downloadRequest.headers).get("Range")).toBe("bytes=0-65535");
  });

  it("browses one directory, surfacing subfolders as directory entries", async () => {
    vi.stubGlobal("fetch", storageFetchMock());

    const listing = await prusalinkAdapter.files!.browse(prusaConfig, "");

    expect(listing.path).toBe("");
    expect(listing.entries).toEqual([
      {
        kind: "directory",
        path: "jobs",
        name: "jobs",
        modified_at: new Date(1_724_000_000 * 1_000).toISOString(),
      },
      { kind: "file", path: "SPOOL~1.GCO", name: "spool-holder.gcode" },
    ]);
    // Unknown size and timestamp are absent keys, not zeroes or guesses.
    expect(Object.keys(listing.entries[1]!)).toEqual(["kind", "path", "name"]);
  });

  it("browses a nested path and follows the advertised download ref", async () => {
    const fetchMock = storageFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const listing = await prusalinkAdapter.files!.browse(prusaConfig, "jobs");

    expect(listing.path).toBe("jobs");
    expect(listing.entries).toEqual([{
      kind: "file",
      path: "jobs/BRACK~1.BGC",
      name: "bracket.bgcode",
      size_bytes: 8192,
      modified_at: new Date(1_725_000_000 * 1_000).toISOString(),
    }]);

    const opened = await prusalinkAdapter.files!.open(prusaConfig, "jobs/BRACK~1.BGC");
    expect(await opened.text()).toBe("binary-gcode");
    expect(fetchMock.mock.calls.some((call) =>
      String(call[0]).endsWith("/api/files/local/jobs/BRACK~1.BGC/raw"),
    )).toBe(true);
  });

  it("keeps a progressing file download alive beyond two minutes", async () => {
    useFakeDownloadClock();
    stubDownloadResponse((signal) => {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          let sent = 0;
          const timer = setInterval(() => {
            controller.enqueue(new TextEncoder().encode("gcode-chunk\n"));
            sent += 1;
            if (sent === 13) {
              clearInterval(timer);
              controller.close();
            }
          }, 10_000);
          signal.addEventListener("abort", () => {
            clearInterval(timer);
            controller.error(signal.reason);
          }, { once: true });
        },
      }));
    });

    try {
      const response = await prusalinkAdapter.files!.open(prusaConfig, "jobs/BRACK~1.BGC");
      if (!response.body) throw new Error("The download must contain a response body");
      const reader = response.body.getReader();
      const chunks: string[] = [];
      const finished = (async () => {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) return chunks.join("");
          chunks.push(new TextDecoder().decode(chunk.value));
        }
      })().then(
        (body) => ({ kind: "complete", body }),
        (error: unknown) => ({ kind: "failed", error }),
      );

      await vi.advanceTimersByTimeAsync(119_000);
      expect(chunks).toHaveLength(11);
      await vi.advanceTimersByTimeAsync(11_000);

      expect(await finished).toEqual({
        kind: "complete",
        body: "gcode-chunk\n".repeat(13),
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("times out a stalled file body even when it emits empty chunks", async () => {
    useFakeDownloadClock();
    stubDownloadResponse((signal) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        const timer = setInterval(() => controller.enqueue(new Uint8Array()), 10_000);
        signal.addEventListener("abort", () => {
          clearInterval(timer);
          controller.error(signal.reason);
        }, { once: true });
      },
    })));
    try {
      const response = await prusalinkAdapter.files!.open(prusaConfig, "jobs/BRACK~1.BGC");
      const result = response.arrayBuffer().then(
        () => ({ kind: "complete" }),
        (error: unknown) => ({ kind: "failed", error }),
      );
      await vi.advanceTimersByTimeAsync(120_000);
      expect(await result).toEqual({
        kind: "failed",
        error: expect.objectContaining({ name: "TimeoutError" }),
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("aborts the download and clears its idle timer when the caller cancels", async () => {
    useFakeDownloadClock();
    const cancelled = vi.fn();
    let downloadSignal: AbortSignal | undefined;
    stubDownloadResponse((signal) => {
      downloadSignal = signal;
      return new Response(new ReadableStream<Uint8Array>({ cancel: cancelled }));
    });
    try {
      const response = await prusalinkAdapter.files!.open(prusaConfig, "jobs/BRACK~1.BGC");
      await response.body!.cancel("User stopped");
      expect(cancelled).toHaveBeenCalledWith("User stopped");
      expect(downloadSignal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(cancelled).toHaveBeenCalledOnce();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("keeps a recent print file and navigable folders after 500 older directory entries", async () => {
    const latestName = "idler_housing_x2_0.4n_0.2mm_ASA_COREONE_6h33m.bgcode";
    const fallback = storageFetchMock();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/api/v1/files/local/")) {
        return jsonResponse({
          type: "FOLDER",
          children: [
            { name: "jobs", type: "FOLDER" },
            { name: "archive", type: "FOLDER" },
            ...Array.from({ length: 498 }, (_, index) => ({
              name: `OLD${index}.BGC`,
              display_name: `older-print-${index}.bgcode`,
              type: "PRINT_FILE",
              m_timestamp: Date.parse("2026-05-26T00:00:00.000Z") / 1_000,
            })),
            {
              name: "IDLER~1.BGC",
              display_name: latestName,
              type: "PRINT_FILE",
              m_timestamp: Date.parse("2026-09-06T00:00:00.000Z") / 1_000,
            },
            { name: "new-jobs", type: "FOLDER" },
          ],
        });
      }
      if (String(input).endsWith("/api/v1/files/local/new-jobs")) {
        return jsonResponse({
          type: "FOLDER",
          children: [{ name: "BRACKET.GCO", display_name: "bracket.gcode", type: "PRINT_FILE" }],
        });
      }
      return fallback(input);
    });
    vi.stubGlobal("fetch", fetchMock);

    const listing = await prusalinkAdapter.files!.browse(prusaConfig, "");

    expect(listing.entries.find((entry) => entry.path === "IDLER~1.BGC")).toEqual({
      kind: "file",
      path: "IDLER~1.BGC",
      name: latestName,
      modified_at: "2026-09-06T00:00:00.000Z",
    });
    expect(listing.entries.find((entry) => entry.path === "new-jobs")).toEqual({
      kind: "directory",
      path: "new-jobs",
      name: "new-jobs",
    });
    expect(listing.entries).toHaveLength(502);
    expect(await prusalinkAdapter.files!.browse(prusaConfig, "new-jobs")).toEqual({
      path: "new-jobs",
      entries: [{ kind: "file", path: "new-jobs/BRACKET.GCO", name: "bracket.gcode" }],
    });
  });

  it("rejects traversal, backslash, and NUL paths before any request", async () => {
    const fetchMock = storageFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    for (
      const unsafe of [
        "../secrets",
        "jobs/../../etc",
        "jobs\\bracket.bgcode",
        "jobs/brack\u0000et.bgcode",
      ]
    ) {
      await expect(prusalinkAdapter.files!.browse(prusaConfig, unsafe)).rejects.toThrow(
        /Invalid PrusaLink storage path/,
      );
      await expect(prusalinkAdapter.files!.open(prusaConfig, unsafe)).rejects.toThrow(
        /Invalid PrusaLink/,
      );
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a download ref that points off the configured PrusaLink origin", async () => {
    vi.stubGlobal("fetch", storageFetchMock({ downloadRef: "http://attacker.example/raw" }));

    await expect(prusalinkAdapter.files!.open(prusaConfig, "jobs/BRACK~1.BGC")).rejects.toThrow(
      /cross-origin/,
    );
  });

  it("exposes connected PrusaLink cameras as snapshots", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/v1/status")) return digest401();
      if (url.endsWith("/api/v1/cameras")) {
        return new Response(JSON.stringify([{
          camera_id: "camera-one",
          connected: true,
          config: { name: "Enclosure" },
        }]), { headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/api/v1/cameras/camera-one/snap")) {
        return new Response("png", { headers: { "content-type": "image/png" } });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const config = {
      base_url: "http://127.0.0.1",
      username: "maker",
      password: "printer-key",
    };

    expect(await prusalinkAdapter.cameras!.list(config)).toEqual([{
      id: "camera-one",
      name: "Enclosure",
      view: "snapshot",
      service: "prusalink",
    }]);
    const snapshot = await prusalinkAdapter.cameras!.open(config, "camera-one");
    expect(snapshot.headers.get("content-type")).toBe("image/png");
  });
});
