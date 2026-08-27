import { describe, expect, it } from "vitest";
import {
  CHECKOFF_CORRECTION_NOTE_MAX,
  checkoffCorrectionImpact,
  checkoffCorrectionNeedsReason,
  checkoffCorrectionReasonLabel,
  describeCheckoffCorrectionImpact,
  formatCheckoffCorrection,
  isCheckoffCorrectionReason,
  validateCheckoffCorrection,
} from "./checkoffConsoleCorrection";

describe("checkoffCorrectionImpact", () => {
  it("finds printer history from live, finished, or verified printer work", () => {
    expect(checkoffCorrectionImpact({ printingOn: "Core One" }).printerHistory).toBe(true);
    expect(checkoffCorrectionImpact({ awaitingVerify: "Core One" }).printerHistory).toBe(true);
    expect(checkoffCorrectionImpact({ verifiedByPrinter: true }).printerHistory).toBe(true);
    expect(checkoffCorrectionImpact({}).printerHistory).toBe(false);
  });

  it("finds material deduction from an assigned filament", () => {
    expect(checkoffCorrectionImpact({ filamentDisplay: "ABS Black" }).materialDeduction).toBe(true);
    expect(checkoffCorrectionImpact({ filamentDisplay: "  " }).materialDeduction).toBe(false);
    expect(checkoffCorrectionImpact({ filamentDisplay: null }).materialDeduction).toBe(false);
  });
});

describe("checkoffCorrectionNeedsReason", () => {
  it("asks for a reason only when the correction changes history", () => {
    expect(
      checkoffCorrectionNeedsReason({ printerHistory: false, materialDeduction: false }),
    ).toBe(false);
    expect(
      checkoffCorrectionNeedsReason({ printerHistory: true, materialDeduction: false }),
    ).toBe(true);
    expect(
      checkoffCorrectionNeedsReason({ printerHistory: false, materialDeduction: true }),
    ).toBe(true);
  });
});

describe("describeCheckoffCorrectionImpact", () => {
  it("names what changes", () => {
    expect(
      describeCheckoffCorrectionImpact({ printerHistory: true, materialDeduction: true }),
    ).toContain("printer job and used tracked filament");
    expect(
      describeCheckoffCorrectionImpact({ printerHistory: true, materialDeduction: false }),
    ).toContain("A printer job recorded this unit");
    expect(
      describeCheckoffCorrectionImpact({ printerHistory: false, materialDeduction: true }),
    ).toContain("tracked filament");
    expect(
      describeCheckoffCorrectionImpact({ printerHistory: false, materialDeduction: false }),
    ).toBe("Nothing else depends on this unit.");
  });
});

describe("validateCheckoffCorrection", () => {
  it("requires a reason when the correction changes history", () => {
    const result = validateCheckoffCorrection({
      draft: { reason: null, note: "" },
      needsReason: true,
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      { field: "reason", message: "Choose why you are correcting this unit" },
    ]);
  });

  it("accepts a plain undo when nothing depends on the unit", () => {
    expect(
      validateCheckoffCorrection({ draft: { reason: null, note: "" }, needsReason: false }).ok,
    ).toBe(true);
  });

  it("rejects an over-long note", () => {
    const result = validateCheckoffCorrection({
      draft: { reason: "recount", note: "x".repeat(CHECKOFF_CORRECTION_NOTE_MAX + 1) },
      needsReason: true,
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.field).toBe("note");
  });
});

describe("reason labels", () => {
  it("guards stored reasons and labels them", () => {
    expect(isCheckoffCorrectionReason("recount")).toBe(true);
    expect(isCheckoffCorrectionReason("nope")).toBe(false);
    expect(checkoffCorrectionReasonLabel("wrong_row")).toBe("Marked the wrong part");
  });
});

describe("formatCheckoffCorrection", () => {
  it("reads as provenance on the row", () => {
    const line = formatCheckoffCorrection({
      partId: 1,
      unitIndex: 0,
      reason: "part_damaged",
      note: " snapped ",
      at: "2026-08-27T10:00:00.000Z",
    });
    expect(line).toContain("Part damaged or scrapped");
    expect(line).toContain("snapped");
  });

  it("survives a broken timestamp", () => {
    expect(
      formatCheckoffCorrection({
        partId: 1,
        unitIndex: 0,
        reason: "recount",
        note: "",
        at: "nope",
      }),
    ).toBe("Corrected: Recounted the bin");
  });
});
