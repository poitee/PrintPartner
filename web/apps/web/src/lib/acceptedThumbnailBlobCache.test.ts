import { describe, expect, it } from "vitest";
import { AcceptedThumbnailBlobCache } from "./acceptedThumbnailBlobCache";

describe("AcceptedThumbnailBlobCache", () => {
  it("evicts least recently used legal thumbnails by byte budget", () => {
    const maxPngBytes = 5 * 1024 * 1024;
    const cache = new AcceptedThumbnailBlobCache(maxPngBytes * 2);
    const first = new Blob([new Uint8Array(maxPngBytes)]);
    const second = new Blob([new Uint8Array(maxPngBytes)]);
    const third = new Blob([new Uint8Array(maxPngBytes)]);

    cache.set("a".repeat(64), first);
    cache.set("b".repeat(64), second);
    expect(cache.get("a".repeat(64))).toBe(first);
    cache.set("c".repeat(64), third);

    expect(cache.get("a".repeat(64))).toBe(first);
    expect(cache.get("b".repeat(64))).toBeNull();
    expect(cache.get("c".repeat(64))).toBe(third);
  });
});
