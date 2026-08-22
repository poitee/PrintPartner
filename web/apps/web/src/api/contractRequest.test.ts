import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ContractRequestError,
  defineJsonReadEndpoint,
  defineJsonWriteEndpoint,
  requestJsonRead,
  requestJsonWrite,
  setEngineUnauthorizedHandler,
} from "./contractRequest";

function parseSuccess(value: unknown): { ok: true } {
  if (
    typeof value !== "object" ||
    value === null ||
    !("ok" in value) ||
    value.ok !== true
  ) {
    throw new Error("invalid success");
  }
  return { ok: true };
}

function parseFailure(value: unknown): { code: "missing" } {
  if (
    typeof value !== "object" ||
    value === null ||
    !("code" in value) ||
    value.code !== "missing"
  ) {
    throw new Error("invalid failure");
  }
  return { code: "missing" };
}

const readEndpoint = defineJsonReadEndpoint({
  method: "GET",
  route: "/fixtures/:id",
  path: ({ path, query }: { path: string; query: string }) =>
    `/fixtures/${path}?query=${encodeURIComponent(query)}`,
  parseSuccess,
  parseFailure,
});

const writeEndpoint = defineJsonWriteEndpoint({
  method: "PUT",
  route: "/fixtures/:id",
  path: ({ path }: { path: string }) => `/fixtures/${path}`,
  encodeBody: (input: { secret: string }) => input,
  parseSuccess,
  parseFailure,
});

describe("contract request boundary", () => {
  afterEach(() => {
    setEngineUnauthorizedHandler(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("parses a valid success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(
      requestJsonRead(readEndpoint, { path: "short", query: "private" }),
    ).resolves.toEqual({ ok: true });
  });

  it("rejects valid JSON with the wrong success shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: false, provider: "response-secret" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const request = requestJsonRead(readEndpoint, {
      path: "short-path-secret",
      query: "query-secret",
    });

    await expect(request).rejects.toMatchObject({
      failure: {
        kind: "malformed_success",
        method: "GET",
        route: "/fixtures/:id",
        status: 200,
      },
    });
    await expect(request).rejects.not.toThrow(/short-path-secret|query-secret|response-secret/);
  });

  it("rejects a non-JSON media type that mentions application/json in a parameter", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "text/plain; note=application/json" },
        }),
      ),
    );

    await expect(
      requestJsonRead(readEndpoint, { path: "short", query: "private" }),
    ).rejects.toMatchObject({
      failure: { kind: "malformed_success", status: 200 },
    });
  });

  it("accepts a structured JSON media type", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/problem+json; charset=utf-8" },
        }),
      ),
    );

    await expect(
      requestJsonRead(readEndpoint, { path: "short", query: "private" }),
    ).resolves.toEqual({ ok: true });
  });

  it("keeps only a parsed error code and allowlisted trace IDs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            code: "missing",
            detail: "provider-response-secret",
            provider_payload: "provider-payload-secret",
          }),
          {
            status: 404,
            headers: {
              "Content-Type": "application/json",
              "X-Request-Id": "request_123",
              "X-Correlation-Id": "correlation:456",
              "X-Provider-Token": "response-header-secret",
            },
          },
        ),
      ),
    );

    const request = requestJsonWrite(
      writeEndpoint,
      { path: "path-secret" },
      { secret: "request-body-secret" },
    );

    await expect(request).rejects.toMatchObject({
      failure: {
        kind: "endpoint",
        method: "PUT",
        route: "/fixtures/:id",
        status: 404,
        requestId: "request_123",
        correlationId: "correlation:456",
        error: { code: "missing" },
      },
    });
    const error = await request.catch((value: unknown) => value);
    const serialized = JSON.stringify(error);
    expect(serialized).not.toMatch(
      /path-secret|request-body-secret|provider-response-secret|provider-payload-secret|response-header-secret/,
    );
  });

  it("rejects malformed error JSON without retaining the payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: "malformed-error-secret" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const request = requestJsonRead(readEndpoint, { path: "path-secret", query: "query-secret" });

    await expect(request).rejects.toMatchObject({
      failure: {
        kind: "malformed_error",
        method: "GET",
        route: "/fixtures/:id",
        status: 500,
      },
    });
    await expect(request).rejects.not.toThrow(/malformed-error-secret|path-secret|query-secret/);
  });

  it("discards network errors and invalid trace identifiers", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network-secret")));

    const request = requestJsonRead(readEndpoint, { path: "path-secret", query: "query-secret" });

    await expect(request).rejects.toBeInstanceOf(ContractRequestError);
    await expect(request).rejects.toMatchObject({
      failure: { kind: "transport", method: "GET", route: "/fixtures/:id" },
    });
    await expect(request).rejects.not.toThrow(/network-secret|path-secret|query-secret/);
  });

  it("invokes the unauthorized handler without retaining its response", async () => {
    const unauthorized = vi.fn(() => {
      throw new Error("handler-secret");
    });
    setEngineUnauthorizedHandler(unauthorized);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: "unauthorized-secret" }), {
          status: 401,
          headers: {
            "Content-Type": "application/json",
            "X-Request-Id": "request_unauthorized",
          },
        }),
      ),
    );

    const request = requestJsonRead(readEndpoint, { path: "path-secret", query: "query-secret" });

    await expect(request).rejects.toMatchObject({
      failure: {
        kind: "unauthorized",
        method: "GET",
        route: "/fixtures/:id",
        status: 401,
        requestId: "request_unauthorized",
      },
    });
    await expect(request).rejects.not.toThrow(
      /unauthorized-secret|handler-secret|path-secret|query-secret/,
    );
    expect(unauthorized).toHaveBeenCalledOnce();
  });

  it.each(["", "relative", "https://example.com/path", "/path?secret=1", "/path#secret"])(
    "rejects unsafe route template %s",
    (route) => {
      expect(() =>
        defineJsonReadEndpoint({
          method: "GET",
          route,
          path: () => "/path",
          parseSuccess,
          parseFailure,
        }),
      ).toThrow(/route template/i);
    },
  );
});
