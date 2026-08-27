import { describe, expect, it } from "vitest";
import {
  statusTone,
  WORKFLOW_STATUS_KINDS,
  workflowStatusPresentation,
  workflowStatusToneOf,
  type StatusEmphasis,
  type StatusTone,
} from "./statusTone";

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

describe("workflowStatusPresentation", () => {
  it("covers every workflow state with words and a distinct shape", () => {
    const icons = new Set<unknown>();
    for (const kind of WORKFLOW_STATUS_KINDS) {
      const presentation = workflowStatusPresentation(kind);
      expect(presentation.kind).toBe(kind);
      expect(presentation.label.length).toBeGreaterThan(0);
      expect(presentation.icon).toBeTruthy();
      icons.add(presentation.icon);
    }
    expect(icons.size).toBe(WORKFLOW_STATUS_KINDS.length);
  });

  it("maps states onto the tone the palette expects", () => {
    expect(workflowStatusToneOf("complete")).toBe("success");
    expect(workflowStatusToneOf("needs_attention")).toBe("warning");
    expect(workflowStatusToneOf("stale")).toBe("warning");
    expect(workflowStatusToneOf("error")).toBe("error");
    expect(workflowStatusToneOf("in_progress")).toBe("info");
    expect(workflowStatusToneOf("ready")).toBe("info");
    expect(workflowStatusToneOf("not_started")).toBe("neutral");
  });

  it("reserves the alert role for errors and stays quiet before work starts", () => {
    expect(workflowStatusPresentation("error").live).toBe("alert");
    expect(workflowStatusPresentation("not_started").live).toBeNull();
    for (const kind of WORKFLOW_STATUS_KINDS) {
      const { live } = workflowStatusPresentation(kind);
      if (kind !== "error") expect(live).not.toBe("alert");
    }
  });
});
