import { describe, expect, it } from "vitest";
import {
  clearAuxiliaryError,
  currentAuxiliaryError,
  setAuxiliaryError,
  type AuxiliaryErrors,
} from "./auxiliaryErrors";

describe("auxiliary error lifecycle", () => {
  it("clears a fetch error after that fetch succeeds", () => {
    const failed = setAuxiliaryError({}, "printer-activity", "Could not refresh printer activity");
    expect(currentAuxiliaryError(failed)).toBe("Could not refresh printer activity");

    const recovered = clearAuxiliaryError(failed, "printer-activity");

    expect(currentAuxiliaryError(recovered)).toBeNull();
  });

  it("does not clear an unrelated fetch error", () => {
    let errors: AuxiliaryErrors = {};
    errors = setAuxiliaryError(errors, "printer-activity", "Printer activity failed");
    errors = setAuxiliaryError(errors, "phase-progress", "Phase progress failed");
    errors = clearAuxiliaryError(errors, "printer-activity");

    expect(currentAuxiliaryError(errors)).toBe("Phase progress failed");
  });

  it("displays the most recently updated error even when its key already existed", () => {
    let errors: AuxiliaryErrors = {};
    errors = setAuxiliaryError(errors, "printer-activity", "Printer activity failed");
    errors = setAuxiliaryError(errors, "phase-progress", "Phase progress failed");
    errors = setAuxiliaryError(errors, "printer-activity", "Printer activity failed again");

    expect(currentAuxiliaryError(errors)).toBe("Printer activity failed again");
  });
});
