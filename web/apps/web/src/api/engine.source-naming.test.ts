import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceNamingPutInput } from "@print-partner/contracts";
import {
  DEFAULT_STL_NAMING_PROFILE,
  fetchSourceNaming,
  isSourceNamingNotFoundError,
  saveSourceNaming,
  SourceNamingRequestError,
} from "./engine";

const responseBody = {
  use_defaults: true,
  override: {},
  effective: DEFAULT_STL_NAMING_PROFILE,
  effective_digest: "0".repeat(64),
};

const writeInputs: SourceNamingPutInput[] = [
  { use_defaults: true },
  { use_defaults: false, override: DEFAULT_STL_NAMING_PROFILE },
];

describe("Source naming API boundary", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects malformed successful JSON before feature code receives it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            use_defaults: false,
            override: {},
            effective: { quantity: { regex: "x([0-9]+)", default: 0 } },
            effective_digest: 7,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    await expect(fetchSourceNaming(7)).rejects.toThrow(/invalid response/i);
  });

  it("parses a valid response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(fetchSourceNaming(7)).resolves.toEqual(responseBody);
  });

  it("rejects an invalid Source id before fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSourceNaming(0)).rejects.toMatchObject({
      failure: {
        kind: "invalid_request",
        method: "GET",
        route: "/sources/:sourceId/naming",
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(writeInputs)("serializes exactly one valid write variant", async (input) => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(String(init?.body))).toEqual(input);
      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await saveSourceNaming(7, input);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("exposes a coded missing-Source error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ code: "source_not_found", detail: "Source not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const request = fetchSourceNaming(7);
    await expect(request).rejects.toBeInstanceOf(SourceNamingRequestError);
    await expect(request).rejects.toSatisfy(isSourceNamingNotFoundError);
    const error = await request.catch((value: unknown) => value);
    expect(JSON.stringify(error)).not.toContain("Source not found");
  });

  it("rejects an endpoint error whose code does not match its HTTP status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ code: "source_not_found", detail: "Source not found" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(fetchSourceNaming(7)).rejects.toMatchObject({
      failure: { kind: "malformed_error", method: "GET", status: 400 },
    });
  });
});
