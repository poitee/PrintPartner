import { describe, expect, it } from "vitest";
import { sourceContentAvailable } from "./sourceContentAvailable";

describe("sourceContentAvailable", () => {
  it("uses the explicit availability signal when the server redacts local_path", () => {
    expect(sourceContentAvailable({ content_available: true, local_path: null })).toBe(true);
  });

  it("falls back to local_path for older servers", () => {
    expect(sourceContentAvailable({ local_path: "/repos/1" })).toBe(true);
    expect(sourceContentAvailable({ local_path: null })).toBe(false);
  });
});
