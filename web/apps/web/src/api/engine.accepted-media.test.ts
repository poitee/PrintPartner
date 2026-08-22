import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acceptedPartMediaMetadata,
  acceptedPartMediaRevalidationHeaders,
  uploadPartThumbnail,
} from "./engine";

const basis = "a".repeat(64);

describe("accepted Part media API boundary", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses a strong accepted basis and accepted render color", () => {
    const response = new Response("mesh", {
      headers: {
        ETag: `"${basis}"`,
        "X-Accepted-Render-Hex": "#112233",
      },
    });

    expect(acceptedPartMediaMetadata(response)).toEqual({
      basis,
      renderHex: "#112233",
    });
    expect(acceptedPartMediaRevalidationHeaders(basis)).toEqual({
      "If-None-Match": `"${basis}"`,
    });
  });

  it("rejects weak or malformed media metadata", () => {
    expect(() =>
      acceptedPartMediaMetadata(new Response("mesh", { headers: { ETag: `W/"${basis}"` } })),
    ).toThrow("strong accepted media ETag");
    expect(() => acceptedPartMediaRevalidationHeaders("7")).toThrow("accepted media basis");
  });

  it("uploads with the exact strong mesh basis precondition", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.headers).toEqual({ "If-Match": `"${basis}"` });
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const blob = new Blob(["png"], { type: "image/png" });

    await uploadPartThumbnail(7, blob, basis);

    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
