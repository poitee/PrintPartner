import { describe, expect, it } from "vitest";
import { downloadExport, engineAssetUrl } from "./browserFiles";

describe("browser file endpoint adapter", () => {
  it("resolves asset URLs and no-ops downloads outside the browser", () => {
    expect(engineAssetUrl("https://example.com/a.png")).toBe(
      "https://example.com/a.png",
    );
    expect(engineAssetUrl("/exports/a.png")).toContain("/exports/a.png");
    expect(() => downloadExport("/exports/a.zip", "a.zip")).not.toThrow();
  });
});
