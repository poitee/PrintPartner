// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  fetchWithRetry: vi.fn(),
  generatePartThumbnail: vi.fn(),
  revokeObjectURL: vi.fn(),
  probeResult: "invalid" as "invalid" | "error",
}));

vi.mock("../../api/endpoints/media", () => ({
  acceptedPartMediaMetadata: () => ({ basis: "a".repeat(64), renderHex: "#112233" }),
  acceptedPartMediaRevalidationHeaders: () => ({}),
  partThumbnailUrl: () => "/parts/7/thumbnail",
}));

vi.mock("../../lib/fetchWithRetry", () => ({
  fetchWithRetry: runtime.fetchWithRetry,
}));

vi.mock("../../lib/stlThumbnail", () => ({
  generatePartThumbnail: runtime.generatePartThumbnail,
}));

vi.mock("../../lib/acceptedThumbnailBlobCache", () => ({
  acceptedThumbnailBlobCache: { get: vi.fn(() => null), set: vi.fn() },
}));

vi.mock("../../lib/thumbnailCache", () => ({
  getThumbnailCacheVersion: () => 0,
  subscribeThumbnailCache: () => () => undefined,
}));

import PartThumb from "./PartThumb";

describe("PartThumb accepted server object URL lifecycle", () => {
  beforeEach(() => {
    runtime.fetchWithRetry.mockReset().mockResolvedValue(
      new Response("png", { status: 200, headers: { "Content-Type": "image/png" } }),
    );
    runtime.generatePartThumbnail.mockReset().mockResolvedValue("blob:client");
    runtime.revokeObjectURL.mockReset();
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:server"),
      revokeObjectURL: runtime.revokeObjectURL,
    });
    vi.stubGlobal(
      "Image",
      class {
        naturalWidth = runtime.probeResult === "invalid" ? 1 : 96;
        naturalHeight = runtime.probeResult === "invalid" ? 1 : 96;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;

        set src(_value: string) {
          queueMicrotask(() => {
            if (runtime.probeResult === "error") this.onerror?.();
            else this.onload?.();
          });
        }
      },
    );
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(["invalid", "error"] as const)(
    "revokes the server URL before the %s fallback render",
    async (probeResult) => {
      runtime.probeResult = probeResult;

      render(<PartThumb partId={7} eager />);

      await waitFor(() => expect(runtime.generatePartThumbnail).toHaveBeenCalledOnce());
      expect(runtime.revokeObjectURL).toHaveBeenCalledWith("blob:server");
      expect(runtime.revokeObjectURL.mock.invocationCallOrder[0]).toBeLessThan(
        runtime.generatePartThumbnail.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
    },
  );

  it("renders locally without decoding an explicit server placeholder", async () => {
    runtime.fetchWithRetry.mockResolvedValueOnce(
      new Response("png", {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          "X-Thumbnail-Placeholder": "1",
        },
      }),
    );

    render(<PartThumb partId={7} eager />);

    await waitFor(() => expect(runtime.generatePartThumbnail).toHaveBeenCalledOnce());
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it.each(["empty", "rejected"])("retries a %s client render without requiring a page reload", async (failure) => {
    runtime.fetchWithRetry.mockResolvedValue(new Response(null, { status: 404 }));
    if (failure === "empty") runtime.generatePartThumbnail.mockResolvedValueOnce(null);
    else runtime.generatePartThumbnail.mockRejectedValueOnce(new Error("WebGL context lost"));
    runtime.generatePartThumbnail.mockResolvedValueOnce("blob:recovered");

    const { container } = render(<PartThumb partId={7} eager fallbackLabel="ABC" />);

    await waitFor(() => {
      expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:recovered");
    }, { timeout: 2500 });
    expect(runtime.generatePartThumbnail).toHaveBeenCalledTimes(2);
  });

  it("cancels a pending render retry when the card unmounts", async () => {
    runtime.fetchWithRetry.mockResolvedValue(new Response(null, { status: 404 }));
    runtime.generatePartThumbnail.mockResolvedValue(null);
    const { unmount } = render(<PartThumb partId={7} eager />);
    await waitFor(() => expect(runtime.generatePartThumbnail).toHaveBeenCalledOnce());
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 1100));

    expect(runtime.generatePartThumbnail).toHaveBeenCalledOnce();
  });

  it("stops retrying a persistent failure and explains how to recover", async () => {
    vi.useFakeTimers();
    runtime.fetchWithRetry.mockResolvedValue(new Response(null, { status: 404 }));
    runtime.generatePartThumbnail.mockResolvedValue(null);
    const { container } = render(<PartThumb partId={7} eager fallbackLabel="ABC" />);

    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });

    expect(runtime.generatePartThumbnail).toHaveBeenCalledTimes(3);
    expect(container.firstElementChild?.getAttribute("title")).toContain("refresh thumbnails");
  });
});
