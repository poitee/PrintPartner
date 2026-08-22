import { afterEach, describe, expect, it, vi } from "vitest";
import { prusalinkAdapter } from "./prusalink.js";

function digest401() {
  return {
    ok: false,
    status: 401,
    headers: new Headers({
      "www-authenticate":
        'Digest realm="Printer API", nonce="abc", qop="auth", algorithm=MD5',
    }),
    arrayBuffer: async () => new ArrayBuffer(0),
    json: async () => ({}),
    text: async () => "",
  };
}

describe("prusalinkAdapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        arrayBuffer: async () => new ArrayBuffer(0),
        json: async () => ({ name: "Prusa MK4" }),
      })
      // readStatus: challenge GET /status
      .mockResolvedValueOnce(digest401())
      // readStatus: GET /status with Authorization
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        arrayBuffer: async () => new ArrayBuffer(0),
        json: async () => ({ printer: { state: "IDLE" } }),
      });
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
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        arrayBuffer: async () => new ArrayBuffer(0),
        json: async () => ({
          printer: { state: "PRINTING" },
          job: {
            progress: 33.3,
            time_remaining: 1200,
          },
        }),
      })
      // job challenge + job (file lives here)
      .mockResolvedValueOnce(digest401())
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        arrayBuffer: async () => new ArrayBuffer(0),
        json: async () => ({
          file: { display_name: "benchy.bgcode" },
        }),
      });
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
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        arrayBuffer: async () => new ArrayBuffer(0),
        json: async () => ({ printer: { state: "READY" } }),
      });
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
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        arrayBuffer: async () => new ArrayBuffer(0),
        json: async () => ({
          printer: { state: "FINISHED" },
          job: { file: { name: "done.bgcode" }, progress: 100 },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const status = await prusalinkAdapter.getStatus!({
      base_url: "http://127.0.0.1",
      password: "printer-key",
    });
    expect(status.state).toBe("complete");
    expect(status.filename).toBe("done.bgcode");
  });
});
