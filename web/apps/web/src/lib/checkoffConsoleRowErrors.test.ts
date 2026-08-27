import { describe, expect, it } from "vitest";
import {
  checkoffLinkErrorKey,
  checkoffRowErrorKey,
  checkoffRowErrorSummary,
  clearCheckoffRowError,
  describeCheckoffMutationFailure,
  getCheckoffRowError,
  hasCheckoffRowErrors,
  NO_CHECKOFF_ROW_ERRORS,
  setCheckoffRowError,
} from "./checkoffConsoleRowErrors";

const error = {
  message: "Could not save the printed count for gantry.stl: offline",
  retryLabel: "Retry checkoff",
  at: "2026-08-27T10:00:00.000Z",
};

describe("row error store", () => {
  it("keeps one persistent error per row", () => {
    const withError = setCheckoffRowError(NO_CHECKOFF_ROW_ERRORS, checkoffRowErrorKey(11), error);
    expect(getCheckoffRowError(withError, "part:11")).toEqual(error);
    expect(hasCheckoffRowErrors(withError)).toBe(true);
    expect(hasCheckoffRowErrors(NO_CHECKOFF_ROW_ERRORS)).toBe(false);
  });

  it("clears on a successful retry", () => {
    const withError = setCheckoffRowError(NO_CHECKOFF_ROW_ERRORS, "part:11", error);
    expect(hasCheckoffRowErrors(clearCheckoffRowError(withError, "part:11"))).toBe(false);
    expect(clearCheckoffRowError(withError, "part:99")).toBe(withError);
  });

  it("summarises newest first", () => {
    let errors = setCheckoffRowError(NO_CHECKOFF_ROW_ERRORS, "part:11", error);
    errors = setCheckoffRowError(errors, "part:12", {
      ...error,
      message: "newer",
      at: "2026-08-27T11:00:00.000Z",
    });
    expect(checkoffRowErrorSummary(errors).map((entry) => entry.key)).toEqual([
      "part:12",
      "part:11",
    ]);
  });
});

describe("describeCheckoffMutationFailure", () => {
  it("names the action, the part, and the cause", () => {
    expect(
      describeCheckoffMutationFailure({
        action: "checkoff",
        filename: "gantry.stl",
        cause: new Error("offline"),
      }),
    ).toBe("Could not save the printed count for gantry.stl: offline");
    expect(
      describeCheckoffMutationFailure({
        action: "correction",
        filename: "gantry.stl",
        cause: "500",
      }),
    ).toBe("Could not save the correction for gantry.stl: 500");
    expect(
      describeCheckoffMutationFailure({
        action: "assembly",
        filename: "gantry.stl",
        cause: "500",
      }),
    ).toBe("Could not save assembly state for gantry.stl: 500");
  });

  it("names verification failures by the printer job", () => {
    expect(
      describeCheckoffMutationFailure({
        action: "verification",
        filename: "gantry.bgcode",
        cause: "409",
      }),
    ).toBe("Could not confirm the printed units for gantry.bgcode: 409");
    expect(
      describeCheckoffMutationFailure({
        action: "rejection",
        filename: "gantry.bgcode",
        cause: "409",
      }),
    ).toBe("Could not save the reject for gantry.bgcode: 409");
    expect(
      describeCheckoffMutationFailure({
        action: "dismissal",
        filename: "gantry.bgcode",
        cause: "409",
      }),
    ).toBe("Could not dismiss this job for gantry.bgcode: 409");
  });
});

describe("checkoffLinkErrorKey", () => {
  it("keys a failure to its printer job", () => {
    expect(checkoffLinkErrorKey("link-1")).toBe("link:link-1");
  });
});
