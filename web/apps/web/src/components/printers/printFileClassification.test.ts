import { describe, expect, it } from "vitest";
import { isPrintReady, type PrintFileClassification } from "@print-partner/contracts";
import { printFileClassificationSummary } from "./printFileClassification";

describe("printFileClassificationSummary", () => {
  it("shows a sliced file as ready", () => {
    expect(printFileClassificationSummary({ format: "gcode" })).toMatchObject({
      status: "ready",
      headline: "Sliced G-code",
      downloadOnly: false,
    });
    expect(printFileClassificationSummary({ format: "bgcode" }).status).toBe("ready");
  });

  it("uses the words the research doc fixed for each 3MF classification", () => {
    const cases: readonly { classification: PrintFileClassification; headline: string }[] = [
      { classification: { format: "3mf", kind: "slicer_project" }, headline: "Needs slicing" },
      {
        classification: { format: "3mf", kind: "model_package" },
        headline: "Needs preparation and slicing",
      },
      {
        classification: { format: "3mf", kind: "toolpath_package" },
        headline: "Compatibility review required",
      },
      { classification: { format: "3mf", kind: "unsupported" }, headline: "Unsupported 3MF" },
    ];
    for (const { classification, headline } of cases) {
      expect(printFileClassificationSummary(classification).headline).toBe(headline);
    }
  });

  it("offers download, not printing, for a container it cannot read", () => {
    const unsupported = printFileClassificationSummary({ format: "3mf", kind: "unsupported" });
    expect(unsupported.downloadOnly).toBe(true);
    expect(unsupported.status).toBe("error");
    expect(isPrintReady({ format: "3mf", kind: "unsupported" })).toBe(false);
  });

  it("never presents an unsliced 3MF as something to print", () => {
    for (const kind of ["slicer_project", "model_package"] as const) {
      expect(printFileClassificationSummary({ format: "3mf", kind })).toMatchObject({
        status: "needs_attention",
        downloadOnly: false,
      });
      expect(isPrintReady({ format: "3mf", kind })).toBe(false);
    }
  });

  it("tells the operator what to do next in every case", () => {
    const classifications: PrintFileClassification[] = [
      { format: "gcode" },
      { format: "bgcode" },
      { format: "3mf", kind: "slicer_project" },
      { format: "3mf", kind: "model_package" },
      { format: "3mf", kind: "toolpath_package" },
      { format: "3mf", kind: "unsupported" },
    ];
    for (const classification of classifications) {
      expect(printFileClassificationSummary(classification).nextStep.length).toBeGreaterThan(0);
    }
  });
});
