import { describe, expect, it, vi } from "vitest";
import { readStickyId, writeStickyId } from "./stickyIdStorage";

describe("stickyIdStorage", () => {
  it("reads trimmed ids", () => {
    const storage = {
      getItem: vi.fn(() => " printer "),
    } as unknown as Storage;

    expect(readStickyId("key", storage)).toBe("printer");
  });

  it("writes and removes ids", () => {
    const storage = {
      setItem: vi.fn(),
      removeItem: vi.fn(),
    } as unknown as Storage;

    writeStickyId("key", "printer", storage);
    writeStickyId("key", "", storage);

    expect(storage.setItem).toHaveBeenCalledWith("key", "printer");
    expect(storage.removeItem).toHaveBeenCalledWith("key");
  });

  it("swallows unavailable storage errors", () => {
    const storage = {
      getItem: vi.fn(() => {
        throw new Error("blocked");
      }),
      setItem: vi.fn(() => {
        throw new Error("blocked");
      }),
    } as unknown as Storage;

    expect(readStickyId("key", storage)).toBe("");
    expect(() => writeStickyId("key", "printer", storage)).not.toThrow();
  });
});
