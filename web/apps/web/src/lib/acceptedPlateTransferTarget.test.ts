import { describe, expect, it } from "vitest";
import { parseAcceptedPlateId } from "@print-partner/contracts";
import {
  parseTransferTarget,
  transferTargetValue,
  type TransferTarget,
} from "./acceptedPlateTransferTarget";

describe("accepted Plate transfer targets", () => {
  it("round-trips exact Plate and new-Plate Printer targets", () => {
    const targets: readonly TransferTarget[] = [
      { kind: "plate", plateId: parseAcceptedPlateId(`plate_${"a".repeat(32)}`) },
      { kind: "printer", printerId: "printer-one" },
    ];
    expect(targets.map((target) => parseTransferTarget(transferTargetValue(target)))).toEqual(targets);
  });

  it("rejects malformed and empty target values", () => {
    expect(parseTransferTarget("")).toBeNull();
    expect(parseTransferTarget("plate:not-a-plate")).toBeNull();
    expect(parseTransferTarget("printer:   ")).toBeNull();
    expect(parseTransferTarget("unknown:printer-one")).toBeNull();
  });
});
