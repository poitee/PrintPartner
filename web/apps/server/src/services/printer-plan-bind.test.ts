import { describe, expect, it } from "vitest";
import { resolvePlanIdForPrinterFetch } from "./printer-plan-bind.js";

describe("resolvePlanIdForPrinterFetch", () => {
  it("prefers stored plan_id over active spine (never steals a bound job)", () => {
    expect(resolvePlanIdForPrinterFetch(7, 3)).toBe(7);
    expect(resolvePlanIdForPrinterFetch(7, null)).toBe(7);
  });

  it("binds unbound jobs once to the active spine", () => {
    expect(resolvePlanIdForPrinterFetch(null, 3)).toBe(3);
    expect(resolvePlanIdForPrinterFetch(undefined, 3)).toBe(3);
    expect(resolvePlanIdForPrinterFetch(0, 3)).toBe(3);
  });

  it("returns null when neither stored nor active spine is usable", () => {
    expect(resolvePlanIdForPrinterFetch(null, null)).toBeNull();
    expect(resolvePlanIdForPrinterFetch(undefined, undefined)).toBeNull();
    expect(resolvePlanIdForPrinterFetch(-1, 0)).toBeNull();
  });
});
