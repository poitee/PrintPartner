import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  slicerSidecarAdapter,
} from "./slicer-sidecar.js";

type Handler = (req: IncomingMessage, res: ServerResponse, body: Buffer) => void;

let server: Server;
let baseUrl: string;
let handler: Handler;
/** Requests the fake sidecar saw, for asserting what PP actually sent. */
let seen: Array<{ url: string; body: string }> = [];

function json(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      seen.push({ url: req.url ?? "", body: body.toString("latin1") });
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function reset(): void {
  seen = [];
}

describe("slicerSidecarSlice — legacy fallback", () => {

  it("retries a dropped GET health probe once (idempotent)", async () => {
    reset();
    let healthHits = 0;
    handler = (req, res) => {
      if (req.url === "/health") {
        healthHits += 1;
        if (healthHits === 1) {
          req.socket.destroy();
          return;
        }
        return json(res, 200, { status: "ok" });
      }
      res.writeHead(404).end();
    };
    const result = await slicerSidecarAdapter.testConnection({ url: baseUrl, slicer: "orca" });
    expect(result.ok).toBe(true);
    expect(healthHits).toBeGreaterThanOrEqual(2);
  });
});

describe("slicerSidecarAdapter.testConnection", () => {
  it("passes against a v1 sidecar (/healthz)", async () => {
    reset();
    handler = (req, res) => {
      if (req.url === "/healthz") return json(res, 200, { ok: true });
      res.writeHead(404).end();
    };
    const result = await slicerSidecarAdapter.testConnection({ url: baseUrl, slicer: "prusa" });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("prusa");
    expect(result.message).toContain("v1");
  });

  it("passes against a legacy sidecar (/health only)", async () => {
    reset();
    handler = (req, res) => {
      if (req.url === "/health") return json(res, 200, { status: "ok" });
      res.writeHead(404).end();
    };
    const result = await slicerSidecarAdapter.testConnection({ url: baseUrl, slicer: "orca" });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("legacy");
  });

  it("fails when legacy health reports a missing slicer binary", async () => {
    reset();
    handler = (req, res) => {
      if (req.url === "/health") {
        return json(res, 200, {
          status: "ok",
          slicer: "orca",
          bin: "/missing/orca-slicer",
          exists: false,
        });
      }
      res.writeHead(404).end();
    };

    const result = await slicerSidecarAdapter.testConnection({ url: baseUrl, slicer: "orca" });
    expect(result.ok).toBe(false);
  });

  it("fails when a health endpoint explicitly reports an unhealthy status", async () => {
    reset();
    handler = (req, res) => {
      if (req.url === "/healthz") return json(res, 200, { ok: false });
      if (req.url === "/health") return json(res, 200, { status: "unhealthy" });
      res.writeHead(404).end();
    };

    const result = await slicerSidecarAdapter.testConnection({ url: baseUrl, slicer: "orca" });
    expect(result.ok).toBe(false);
  });

  it("fails when a JSON health response is malformed", async () => {
    reset();
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{not-json");
    };

    const result = await slicerSidecarAdapter.testConnection({ url: baseUrl, slicer: "orca" });
    expect(result.ok).toBe(false);
  });

  it("fails when a JSON health response has no positive health signal", async () => {
    reset();
    handler = (_req, res) => json(res, 200, {});

    const result = await slicerSidecarAdapter.testConnection({ url: baseUrl, slicer: "orca" });
    expect(result.ok).toBe(false);
  });

  it("accepts a successful plain-text health response for legacy compatibility", async () => {
    reset();
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    };

    const result = await slicerSidecarAdapter.testConnection({ url: baseUrl, slicer: "orca" });
    expect(result.ok).toBe(true);
  });

  it("cancels health bodies that it does not parse", async () => {
    const nonOkCancel = vi.fn();
    const plainTextCancel = vi.fn();
    const responseWithOpenBody = (
      status: number,
      contentType: string,
      cancel: () => void,
    ) => new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("unused"));
        },
        cancel,
      }),
      { status, headers: { "content-type": contentType } },
    );
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith("/healthz")
        ? responseWithOpenBody(503, "text/plain", nonOkCancel)
        : responseWithOpenBody(200, "text/plain", plainTextCancel),
    ));

    try {
      await expect(
        slicerSidecarAdapter.testConnection({ url: "http://127.0.0.1:2814" }),
      ).resolves.toMatchObject({ ok: true });
      expect(nonOkCancel).toHaveBeenCalledOnce();
      expect(plainTextCancel).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fails when neither health endpoint answers", async () => {
    reset();
    handler = (_req, res) => {
      res.writeHead(500).end();
    };
    const result = await slicerSidecarAdapter.testConnection({ url: baseUrl });
    expect(result.ok).toBe(false);
  });

  it("fails cleanly with no url", async () => {
    const result = await slicerSidecarAdapter.testConnection({});
    expect(result.ok).toBe(false);
    expect(result.message).toContain("url is required");
  });
});
