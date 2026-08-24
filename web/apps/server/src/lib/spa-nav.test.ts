import { describe, expect, it } from "vitest";
import { isBrowserDocumentNavigation, isSpaClientPath, isStaticAssetPath } from "./spa-nav.js";

describe("isSpaClientPath", () => {
  it("matches workflow routes", () => {
    expect(isSpaClientPath("/sources")).toBe(true);
    expect(isSpaClientPath("/build?profile=3")).toBe(true);
    expect(isSpaClientPath("/builds")).toBe(true);
    expect(isSpaClientPath("/plans")).toBe(true);
    expect(isSpaClientPath("/login")).toBe(true);
    expect(isSpaClientPath("/setup")).toBe(true);
    expect(isSpaClientPath("/forgot-password")).toBe(true);
    expect(isSpaClientPath("/reset-password")).toBe(true);
    expect(isSpaClientPath("/plans/7/studio")).toBe(true);
    expect(isSpaClientPath("/printers")).toBe(true);
    expect(isSpaClientPath("/library")).toBe(true);
    expect(isSpaClientPath("/parts")).toBe(true);
    expect(isSpaClientPath("/progress")).toBe(true);
    expect(isSpaClientPath("/export")).toBe(true);
    expect(isSpaClientPath("/production")).toBe(true);
  });

  it("ignores API-only paths", () => {
    expect(isSpaClientPath("/health")).toBe(false);
    expect(isSpaClientPath("/sources/1/cover")).toBe(false);
    expect(isSpaClientPath("/assets/app.js")).toBe(false);
  });
});

describe("isStaticAssetPath", () => {
  it("matches built assets", () => {
    expect(isStaticAssetPath("/assets/index-abc123.js")).toBe(true);
    expect(isStaticAssetPath("/assets/index-abc123.css")).toBe(true);
    expect(isStaticAssetPath("/favicon.ico")).toBe(true);
  });

  it("ignores API routes", () => {
    expect(isStaticAssetPath("/plans")).toBe(false);
    expect(isStaticAssetPath("/auth/me")).toBe(false);
  });
});

describe("isBrowserDocumentNavigation", () => {
  it("detects browser navigations", () => {
    expect(
      isBrowserDocumentNavigation({
        method: "GET",
        headers: { "sec-fetch-mode": "navigate", accept: "text/html" },
      } as never),
    ).toBe(true);
  });

  it("treats API fetches as non-document", () => {
    expect(
      isBrowserDocumentNavigation({
        method: "GET",
        headers: { "sec-fetch-mode": "cors", accept: "*/*" },
      } as never),
    ).toBe(false);
  });
});
