import { describe, expect, it } from "vitest";
import { isSafeAppUrl } from "./authPageModel";

describe("isSafeAppUrl", () => {
  it("allows http and https URLs", () => {
    expect(isSafeAppUrl("http://localhost:5173/reset-password?token=abc")).toBe(true);
    expect(isSafeAppUrl("https://example.com/reset-password?token=abc")).toBe(true);
  });

  it("rejects invalid and non-web URLs", () => {
    expect(isSafeAppUrl("/reset-password?token=abc")).toBe(false);
    expect(isSafeAppUrl("javascript:alert(1)")).toBe(false);
  });
});
