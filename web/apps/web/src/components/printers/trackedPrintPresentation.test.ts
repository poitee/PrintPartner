import { describe, expect, it } from "vitest";
import type { PrinterCheckoffLinkState } from "@print-partner/contracts";
import { trackedPrintPresentation } from "./trackedPrintPresentation";

const STATES: readonly PrinterCheckoffLinkState[] = [
  "watching",
  "awaiting_verify",
  "host_failed",
  "dismissed",
  "verified",
  "applied",
];

describe("trackedPrintPresentation", () => {
  it("never leaks a database state name to the operator", () => {
    for (const state of STATES) {
      for (const manual of [true, false]) {
        const label = trackedPrintPresentation({ state, manual }).label;
        expect(label).not.toMatch(/_/);
        expect(label.length).toBeGreaterThan(0);
      }
    }
  });

  it("names the operator as the owner of a print only they can finish", () => {
    expect(trackedPrintPresentation({ state: "watching", manual: true })).toEqual({
      status: "needs_attention",
      label: "Waiting for you to mark it finished",
      awaitingOperator: true,
    });
  });

  it("names the printer as the owner of a watched print", () => {
    expect(trackedPrintPresentation({ state: "watching", manual: false })).toEqual({
      status: "in_progress",
      label: "Watching this printer",
      awaitingOperator: false,
    });
  });

  it("gives a failed print an error tone the operator has to handle", () => {
    expect(trackedPrintPresentation({ state: "host_failed", manual: false })).toMatchObject({
      status: "error",
      awaitingOperator: true,
    });
  });

  it("reads a finished print as complete", () => {
    for (const state of ["verified", "applied"] as const) {
      expect(trackedPrintPresentation({ state, manual: false })).toMatchObject({
        status: "complete",
        awaitingOperator: false,
      });
    }
  });
});
