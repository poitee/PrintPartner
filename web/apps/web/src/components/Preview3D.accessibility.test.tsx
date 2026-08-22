// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Preview3D from "./Preview3D";

const previewRuntime = vi.hoisted(() => ({
  camera: null as {
    position: {
      clone: () => {
        distanceTo: (target: { x: number; y: number; z: number }) => number;
        toArray: () => number[];
      };
    };
  } | null,
  fetchWithRetry: vi.fn(),
  uploadPartThumbnail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal<typeof import("three")>();

  class TestWebGLRenderer {
    domElement = document.createElement("canvas");

    constructor() {
      this.domElement.toBlob = (callback) => callback(new Blob(["png"], { type: "image/png" }));
    }

    setPixelRatio() {}
    setSize() {}
    dispose() {}
    render(_scene: unknown, camera: NonNullable<typeof previewRuntime.camera>) {
      previewRuntime.camera = camera;
    }
  }

  return {
    ...actual,
    WebGLRenderer: TestWebGLRenderer,
  };
});

const STL = `solid test
facet normal 0 0 1
  outer loop
    vertex 0 0 0
    vertex 1 0 0
    vertex 0 1 0
  endloop
endfacet
endsolid test`;

vi.mock("../lib/fetchWithRetry", () => ({
  fetchWithRetry: previewRuntime.fetchWithRetry,
}));
vi.mock("../api/engine", () => ({
  acceptedPartMediaMetadata: (response: Response) => {
    const match = /^"([0-9a-f]{64})"$/.exec(response.headers.get("ETag") ?? "");
    if (!match?.[1]) throw new Error("Response is missing a strong accepted media ETag");
    return {
      basis: match[1],
      renderHex: response.headers.get("X-Accepted-Render-Hex"),
    };
  },
  partMeshUrl: (partId: number) => `/parts/${partId}/mesh`,
  partPreviewUrl: (partId: number) => `/parts/${partId}/preview`,
  sourceStlMeshUrl: () => "/source/mesh",
  sourceStlPreviewUrl: () => "/source/preview",
  uploadPartThumbnail: previewRuntime.uploadPartThumbnail,
}));

describe("Preview3D accessibility", () => {
  beforeEach(() => {
    previewRuntime.camera = null;
    previewRuntime.fetchWithRetry.mockReset().mockResolvedValue(
      new Response(STL, {
        status: 200,
        headers: {
          ETag: `"${"a".repeat(64)}"`,
          "X-Accepted-Render-Hex": "#112233",
        },
      }),
    );
    previewRuntime.uploadPartThumbnail.mockClear();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("offers concise operating instructions when the interactive mesh is ready", async () => {
    render(<Preview3D partId={7} filename="gantry.stl" />);

    const preview = await screen.findByRole("application", {
      name: "Interactive 3D preview of gantry.stl",
    });

    const descriptionId = preview.getAttribute("aria-describedby");
    const instructions = descriptionId ? document.getElementById(descriptionId) : null;

    expect(preview.tabIndex).toBe(0);
    expect(instructions?.textContent).toMatch(/arrow keys/i);
    expect(instructions?.textContent.length).toBeLessThan(180);
  });

  it("keeps instructions available to assistive tech without persistent compact help", async () => {
    render(
      <Preview3D
        partId={7}
        filename="gantry.stl"
        instructions="sr-only"
      />,
    );

    const preview = await screen.findByRole("application");
    const descriptionId = preview.getAttribute("aria-describedby");
    const instructions = descriptionId ? document.getElementById(descriptionId) : null;

    expect(instructions?.classList.contains("sr-only")).toBe(true);
    expect(instructions?.textContent).toMatch(/arrow keys/i);
  });

  it("rotates the real preview camera with arrow keys", async () => {
    render(<Preview3D partId={7} filename="gantry.stl" />);
    const preview = await screen.findByRole("application");

    await waitFor(() => expect(previewRuntime.camera).not.toBeNull());
    const before = previewRuntime.camera!.position.clone().toArray();
    const dispatched = fireEvent.keyDown(preview, { key: "ArrowLeft" });
    const after = previewRuntime.camera!.position.clone().toArray();

    expect(dispatched).toBe(false);
    expect(after).not.toEqual(before);
  });

  it("clamps keyboard zoom to the OrbitControls distance limits", async () => {
    render(<Preview3D partId={7} filename="gantry.stl" />);
    const preview = await screen.findByRole("application");

    await waitFor(() => expect(previewRuntime.camera).not.toBeNull());
    for (let index = 0; index < 100; index += 1) {
      fireEvent.keyDown(preview, { key: "+" });
    }
    const minimumDistance = previewRuntime.camera!.position
      .clone()
      .distanceTo({ x: 0, y: 0, z: 0 });
    expect(minimumDistance).toBeCloseTo(0.25, 5);

    for (let index = 0; index < 200; index += 1) {
      fireEvent.keyDown(preview, { key: "-" });
    }
    const maximumDistance = previewRuntime.camera!.position
      .clone()
      .distanceTo({ x: 0, y: 0, z: 0 });
    expect(maximumDistance).toBeCloseTo(8, 5);
  });

  it("does not upload a render whose display tint differs from the accepted color", async () => {
    render(<Preview3D partId={7} filename="gantry.stl" meshColor="#445566" />);

    await screen.findByRole("application");
    await new Promise((resolve) => setTimeout(resolve, 950));

    expect(previewRuntime.uploadPartThumbnail).not.toHaveBeenCalled();
  });

  it("uploads a matching accepted-color render with its mesh basis", async () => {
    render(<Preview3D partId={7} filename="gantry.stl" meshColor="#112233" />);

    await screen.findByRole("application");
    await new Promise((resolve) => setTimeout(resolve, 950));

    expect(previewRuntime.uploadPartThumbnail).toHaveBeenCalledWith(
      7,
      expect.any(Blob),
      "a".repeat(64),
    );
  });

  it.each([
    ["missing", undefined],
    ["weak", `W/"${"a".repeat(64)}"`],
  ])("renders a Part mesh with a %s ETag without uploading", async (_label, etag) => {
    previewRuntime.fetchWithRetry.mockResolvedValueOnce(
      new Response(STL, {
        status: 200,
        headers: etag ? { ETag: etag, "X-Accepted-Render-Hex": "#112233" } : {},
      }),
    );

    render(<Preview3D partId={7} filename="gantry.stl" meshColor="#112233" />);

    await screen.findByRole("application");
    await new Promise((resolve) => setTimeout(resolve, 950));
    expect(previewRuntime.uploadPartThumbnail).not.toHaveBeenCalled();
  });
});
