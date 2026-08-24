import { describe, expect, it } from "vitest";
import { statusTone, type StatusEmphasis, type StatusTone } from "./statusTone";

const TONES: StatusTone[] = ["success", "warning", "info", "error", "neutral"];
const EMPHASES: StatusEmphasis[] = ["text", "soft", "outline", "solid"];

describe("statusTone", () => {
  it("emits only semantic token classes — no raw palette, no dark: overrides", () => {
    for (const tone of TONES) {
      for (const emphasis of EMPHASES) {
        const cls = statusTone({ tone, emphasis });
        expect(cls).not.toMatch(/\b(amber|emerald|sky|red|green|rose|slate)-\d/);
        expect(cls).not.toMatch(/dark:/);
      }
    }
  });

  it("pairs solid fills with their foreground ink", () => {
    expect(statusTone({ tone: "warning", emphasis: "solid" })).toContain("text-warning-foreground");
    expect(statusTone({ tone: "error", emphasis: "solid" })).toContain("text-destructive-foreground");
  });

  it("uses soft backgrounds for chips and banners", () => {
    expect(statusTone({ tone: "success", emphasis: "soft" })).toContain("bg-success-soft");
    expect(statusTone({ tone: "info", emphasis: "soft" })).toContain("bg-info-soft");
  });
});
