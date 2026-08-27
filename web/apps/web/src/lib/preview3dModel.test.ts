import { describe, expect, it } from "vitest";
import {
  contrastBackground,
  formatMm,
  normalizedRenderHex,
  perceivedLuminance,
  previewErrorMessage,
  previewTarget,
  previewUrlWithColor,
} from "./preview3dModel";

describe("preview3dModel", () => {
  it("chooses contrasting backgrounds from mesh color luminance", () => {
    expect(perceivedLuminance("#000000")).toBe(0);
    expect(contrastBackground("#000000")).toBe("#dfe4ea");
    expect(contrastBackground("#ffffff")).toBe("#0a0e14");
    expect(perceivedLuminance("not-a-color")).toBe(0.5);
  });

  it("formats STL millimeter dimensions", () => {
    expect(formatMm(12.34)).toBe("12.3");
    expect(formatMm(100.4)).toBe("100");
  });

  it("resolves the preview target preference", () => {
    expect(previewTarget(3, 9, "part.stl", true)).toEqual({
      kind: "source",
      sourceId: 9,
      relativePath: "part.stl",
    });
    expect(previewTarget(3, 9, "part.stl", false)).toEqual({ kind: "part", partId: 3 });
    expect(previewTarget(null, 9, "part.stl")).toEqual({
      kind: "source",
      sourceId: 9,
      relativePath: "part.stl",
    });
    expect(previewTarget(null, null, null)).toBeNull();
  });

  it("maps preview fetch errors to user-facing copy", () => {
    expect(previewErrorMessage(404, "mesh")).toContain("STL not ready yet");
    expect(previewErrorMessage(413, "mesh")).toContain("too large");
    expect(previewErrorMessage(404, "png")).toBe("Preview image not available for this part.");
    expect(previewErrorMessage(500, "png")).toBe("Preview unavailable (HTTP 500).");
  });

  it("adds optional render color parameters", () => {
    expect(previewUrlWithColor("/mesh", "#abcdef")).toBe("/mesh?hex=%23abcdef");
    expect(previewUrlWithColor("/mesh?part=1", "#abcdef")).toBe(
      "/mesh?part=1&hex=%23abcdef",
    );
    expect(previewUrlWithColor("/mesh", " ")).toBe("/mesh");
  });

  it("normalizes render hex values", () => {
    expect(normalizedRenderHex(" #ABCDEF ")).toBe("#abcdef");
    expect(normalizedRenderHex("abcdef")).toBeNull();
  });
});
