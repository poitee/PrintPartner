// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  fetchWithRetry: vi.fn(),
  generatePartThumbnail: vi.fn(),
  revokeObjectURL: vi.fn(),
  probeResult: "invalid" as "invalid" | "error",
}));

vi.mock("../../api/engine", () => ({
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
});
