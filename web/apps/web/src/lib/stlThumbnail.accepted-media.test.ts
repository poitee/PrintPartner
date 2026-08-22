import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  fetchWithRetry: vi.fn(),
  getCachedMeshBuffer: vi.fn(),
  cacheMeshBuffer: vi.fn(),
  uploadPartThumbnail: vi.fn(),
}));

vi.mock("./fetchWithRetry.js", () => ({
  fetchWithRetry: runtime.fetchWithRetry,
}));

vi.mock("./meshCache.js", () => ({
  getCachedMeshBuffer: runtime.getCachedMeshBuffer,
  cacheMeshBuffer: runtime.cacheMeshBuffer,
}));

vi.mock("../api/engine.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/engine.js")>()),
  uploadPartThumbnail: runtime.uploadPartThumbnail,
}));

import { generatePartThumbnail, loadAcceptedMeshBuffer } from "./stlThumbnail";

const basis = "a".repeat(64);

function meshResponse(
  status: number,
  bytes = new Uint8Array(),
  responseBasis = basis,
): Response {
  return new Response(status === 304 ? null : bytes, {
    status,
    headers: {
      ETag: `"${responseBasis}"`,
      "X-Accepted-Render-Hex": "#112233",
    },
  });
}

describe("accepted STL thumbnail mesh loading", () => {
  beforeEach(() => {
    runtime.fetchWithRetry.mockReset();
    runtime.getCachedMeshBuffer.mockReset().mockResolvedValue(null);
    runtime.cacheMeshBuffer.mockReset().mockResolvedValue(undefined);
    runtime.uploadPartThumbnail.mockReset().mockResolvedValue(undefined);
  });

  it("refetches unconditionally when a 304 basis has no local bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    runtime.fetchWithRetry
      .mockResolvedValueOnce(meshResponse(304))
      .mockResolvedValueOnce(meshResponse(200, bytes));

    const loaded = await loadAcceptedMeshBuffer(91);

    expect(runtime.fetchWithRetry).toHaveBeenCalledTimes(2);
    expect(runtime.fetchWithRetry.mock.calls[1]?.[1]).toEqual({
      retryStatuses: [502, 503, 504],
    });
    expect(new Uint8Array(loaded?.buffer ?? new ArrayBuffer(0))).toEqual(bytes);
    expect(loaded).toMatchObject({ basis, renderHex: "#112233" });
    expect(runtime.cacheMeshBuffer).toHaveBeenCalledWith(basis, loaded?.buffer);
  });

  it("reuses bytes only under the basis returned with 304", async () => {
    const secondBasis = "b".repeat(64);
    const persisted = new Uint8Array([5, 6, 7]).buffer;
    runtime.getCachedMeshBuffer.mockResolvedValueOnce(persisted);
    runtime.fetchWithRetry.mockResolvedValueOnce(meshResponse(304, new Uint8Array(), secondBasis));

    const loaded = await loadAcceptedMeshBuffer(92);

    expect(runtime.fetchWithRetry).toHaveBeenCalledTimes(1);
    expect(runtime.getCachedMeshBuffer).toHaveBeenCalledWith(secondBasis);
    expect(loaded).toEqual({ basis: secondBasis, renderHex: "#112233", buffer: persisted });
  });

  it.each([
    ["missing", undefined],
    ["weak", `W/"${basis}"`],
    ["malformed", '"not-a-basis"'],
  ])("returns null without caching or uploading for %s metadata on 200", async (_name, etag) => {
    runtime.fetchWithRetry.mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: etag == null ? {} : { ETag: etag },
      }),
    );

    await expect(generatePartThumbnail(200)).resolves.toBeNull();

    expect(runtime.getCachedMeshBuffer).not.toHaveBeenCalled();
    expect(runtime.cacheMeshBuffer).not.toHaveBeenCalled();
    expect(runtime.uploadPartThumbnail).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["weak", `W/"${basis}"`],
    ["malformed", '"not-a-basis"'],
  ])("returns null without caching or uploading for %s metadata on 304", async (_name, etag) => {
    runtime.fetchWithRetry.mockResolvedValueOnce(
      new Response(null, {
        status: 304,
        headers: etag == null ? {} : { ETag: etag },
      }),
    );

    await expect(generatePartThumbnail(300)).resolves.toBeNull();

    expect(runtime.getCachedMeshBuffer).not.toHaveBeenCalled();
    expect(runtime.cacheMeshBuffer).not.toHaveBeenCalled();
    expect(runtime.uploadPartThumbnail).not.toHaveBeenCalled();
  });

  it("evicts old Part-to-basis revalidation state through the public loader", async () => {
    for (let index = 0; index < 49; index++) {
      const responseBasis = index.toString(16).padStart(64, "0");
      runtime.fetchWithRetry.mockResolvedValueOnce(
        meshResponse(200, new Uint8Array([index + 1]), responseBasis),
      );
      await expect(loadAcceptedMeshBuffer(1_000 + index)).resolves.toMatchObject({
        basis: responseBasis,
      });
    }
    runtime.fetchWithRetry.mockResolvedValueOnce(
      meshResponse(200, new Uint8Array([99]), "f".repeat(64)),
    );

    await loadAcceptedMeshBuffer(1_000);

    expect(runtime.fetchWithRetry.mock.lastCall?.[1]).toEqual({
      init: { headers: {} },
      retryStatuses: [502, 503, 504],
    });
  });
});
