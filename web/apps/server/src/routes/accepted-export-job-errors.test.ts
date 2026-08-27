import { describe, expect, it } from "vitest";
import {
  ACCEPTED_PLATE_EXPORT_ERRORS,
  AcceptedPlateExportPublicError,
  acceptedPlateExportError,
  directExportError,
} from "./accepted-export-job-errors.js";

describe("accepted export job errors", () => {
  it("maps accepted plate export failures to public messages", () => {
    expect(acceptedPlateExportError({ kind: "plate_revision_changed" })).toBe(
      "Plate layout changed. Refresh and export again.",
    );
    expect(acceptedPlateExportError({ kind: "unplaced_units" })).toBe(
      "Arrange every Required unit on a Plate before exporting.",
    );
    expect(acceptedPlateExportError({ kind: "profile_not_found" })).toBe(
      ACCEPTED_PLATE_EXPORT_ERRORS.accepted_state,
    );
    expect(acceptedPlateExportError({ kind: "transaction_unavailable" })).toBe(
      "Accepted Plate export is temporarily unavailable.",
    );
  });

  it("maps direct export failures to public messages", () => {
    expect(directExportError({ kind: "profile_not_found" })).toBe(
      ACCEPTED_PLATE_EXPORT_ERRORS.accepted_state,
    );
    expect(directExportError({ kind: "unknown_token", token: "unit:missing" })).toBe(
      "A selected Required unit is not on this Plan.",
    );
    expect(directExportError({ kind: "limit_exceeded", limit: "output_bytes" })).toBe(
      "Direct export exceeds the configured limit.",
    );
    expect(directExportError({ kind: "output_failure" })).toBe(
      "Direct export could not be published safely.",
    );
  });

  it("marks public errors by class", () => {
    expect(new AcceptedPlateExportPublicError("safe")).toBeInstanceOf(Error);
  });
});
