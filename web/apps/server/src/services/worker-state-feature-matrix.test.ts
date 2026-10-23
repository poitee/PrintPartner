import { describe, expect, it } from "vitest";
import { JOB_KINDS } from "@print-partner/contracts";

/**
 * GRE-498 worker-state matrix index.
 *
 * Farm: printer-upload-farm-feature-access.test.ts (moonraker/prusalink upload job).
 * Bambu: printer-upload-feature-access.test.ts (already on main).
 * Spoolman: spoolman-deduct.test.ts Plan-access skip/recheck cases.
 * Orders: no job-runner kind — admission lives on Plan PATCH / create-build / UI.
 */
describe("worker-state feature matrix", () => {
  it("has no orders background job kind", () => {
    expect(JOB_KINDS).not.toContain("orders");
    expect(JOB_KINDS.filter((kind: string) => kind.includes("order"))).toEqual([]);
  });

  it("covers farm and Bambu upload through the printer-upload job kind", () => {
    expect(JOB_KINDS).toContain("printer-upload");
  });
});
