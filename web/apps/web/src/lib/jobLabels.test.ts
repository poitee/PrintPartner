import { describe, expect, it } from "vitest";
import { jobKindLabel } from "./jobLabels";

describe("jobKindLabel", () => {
  it("maps known job kinds", () => {
    expect(jobKindLabel("export-accepted-plate-3mf")).toBe("Accepted Plate 3MF");
    expect(jobKindLabel("printer-upload")).toBe("Send to printer");
  });

  it("falls back for unknown kinds", () => {
    expect(jobKindLabel("custom-job")).toBe("custom job");
  });
});
