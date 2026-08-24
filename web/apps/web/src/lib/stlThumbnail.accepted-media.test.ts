// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";

const runtime = vi.hoisted(() => ({
  fetchWithRetry: vi.fn(),
  getCachedMeshBuffer: vi.fn(),
  cacheMeshBuffer: vi.fn(),
  uploadPartThumbnail: vi.fn(),
  render: vi.fn(),
  deferBlob: false,
  blobCallbacks: [] as BlobCallback[],
}));

vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal<typeof import("three")>();
  class TestWebGLRenderer {
    readonly domElement: HTMLCanvasElement;

    constructor(options: { canvas: HTMLCanvasElement }) {
      this.domElement = options.canvas;
      Object.defineProperty(this.domElement, "toBlob", {
        configurable: true,
        value: (callback: BlobCallback) => {
          if (runtime.deferBlob) {
            runtime.blobCallbacks.push(callback);
            return;
          }
          callback(new Blob(["png"], { type: "image/png" }));
        },
      });
    }

    setPixelRatio() {}
    setSize() {}
    render() {
      runtime.render();
    }
  }

  return { ...actual, WebGLRenderer: TestWebGLRenderer };
});

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

import {
  decimateGeometryForThumbnail,
  generatePartThumbnail,
  loadAcceptedMeshBuffer,
} from "./stlThumbnail";

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
    runtime.render.mockReset();
    runtime.deferBlob = false;
    runtime.blobCallbacks.length = 0;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:thumbnail"),
    });
  });

  it("keeps decimated STL positions grouped into complete triangles", () => {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(80_001 * 3);
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));

    const decimated = decimateGeometryForThumbnail(geometry);

    expect(decimated.getAttribute("position")?.count % 3).toBe(0);
  });

  it("loads different Part meshes concurrently before serialized rendering", async () => {
    function deferredResponse() {
      let settle!: (response: Response) => void;
      const promise = new Promise<Response>((resolve) => {
        settle = resolve;
      });
      return { promise, settle };
    }

    const firstResponse = deferredResponse();
    const secondResponse = deferredResponse();
    runtime.fetchWithRetry
      .mockImplementationOnce(() => firstResponse.promise)
      .mockImplementationOnce(() => secondResponse.promise);

    const first = generatePartThumbnail(401);
    const second = generatePartThumbnail(402);

    let concurrencyError: unknown;
    try {
      await vi.waitFor(() => expect(runtime.fetchWithRetry).toHaveBeenCalledTimes(2));
    } catch (error) {
      concurrencyError = error;
    }
    firstResponse.settle(new Response(null, { status: 404 }));
    secondResponse.settle(new Response(null, { status: 404 }));

    await expect(Promise.all([first, second])).resolves.toEqual([null, null]);
    if (concurrencyError !== undefined) throw concurrencyError;
  });

  it("does not join an obsolete in-flight render after the thumbnail version changes", async () => {
    let settleFirst!: (response: Response) => void;
    let settleSecond!: (response: Response) => void;
    runtime.fetchWithRetry
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            settleFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            settleSecond = resolve;
          }),
      );

    const oldRender = generatePartThumbnail(601, { cacheVersion: 0 });
    const newRender = generatePartThumbnail(601, { cacheVersion: 1 });

    let concurrencyError: unknown;
    try {
      await vi.waitFor(() => expect(runtime.fetchWithRetry).toHaveBeenCalledTimes(2));
    } catch (error) {
      concurrencyError = error;
    }
    settleFirst(new Response(null, { status: 404 }));
    settleSecond?.(new Response(null, { status: 404 }));
    await expect(Promise.all([oldRender, newRender])).resolves.toEqual([null, null]);
    if (concurrencyError !== undefined) throw concurrencyError;
  });

  it("renders a shared mesh basis once for concurrent different Parts", async () => {
    const sharedBasis = "c".repeat(64);

    function binaryStl(): Uint8Array<ArrayBuffer> {
      const bytes = new Uint8Array(84 + 50);
      const view = new DataView(bytes.buffer);
      view.setUint32(80, 1, true);
      const vertices = [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
      ];
      let offset = 96;
      for (const vertex of vertices) {
        for (const coordinate of vertex) {
          view.setFloat32(offset, coordinate, true);
          offset += 4;
        }
      }
      return bytes;
    }

    runtime.deferBlob = true;
    runtime.fetchWithRetry
      .mockResolvedValueOnce(meshResponse(200, binaryStl(), sharedBasis))
      .mockResolvedValueOnce(meshResponse(200, binaryStl(), sharedBasis));

    const first = generatePartThumbnail(501);
    const second = generatePartThumbnail(502);

    await vi.waitFor(() => expect(runtime.fetchWithRetry).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(runtime.render).toHaveBeenCalledTimes(1));
    runtime.deferBlob = false;
    for (const callback of runtime.blobCallbacks.splice(0)) {
      callback(new Blob(["png"], { type: "image/png" }));
    }

    await expect(Promise.all([first, second])).resolves.toEqual([
      "blob:thumbnail",
      "blob:thumbnail",
    ]);
    expect(runtime.render).toHaveBeenCalledTimes(1);
    expect(runtime.uploadPartThumbnail).toHaveBeenCalledTimes(2);
    expect(runtime.uploadPartThumbnail.mock.calls.map(([partId]) => partId)).toEqual([501, 502]);
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
