import { describe, expect, it, vi } from "vitest";
import { asInt, resolvePlanId } from "./tool-inputs.js";

describe("asInt", () => {
  it("truncates finite numbers and numeric strings", () => {
    expect(asInt(7.9)).toBe(7);
    expect(asInt(" 8.2 ")).toBe(8);
  });

  it("rejects empty and non-finite values", () => {
    expect(asInt(1 / 0)).toBeNull();
    expect(asInt(" ")).toBeNull();
    expect(asInt("abc")).toBeNull();
  });
});

describe("resolvePlanId", () => {
  it("uses a requested plan when validation passes", () => {
    const repo = { getOwnedProfileIdentity: vi.fn(() => ({ id: 12 })) };

    expect(resolvePlanId({ plan_id: "12" }, { repo, activePlanId: 7 })).toBe(12);
    expect(repo.getOwnedProfileIdentity).toHaveBeenCalledWith(12);
  });

  it("falls back to the active plan when validation fails", () => {
    const repo = { getOwnedProfileIdentity: vi.fn(() => null) };

    expect(resolvePlanId({ plan_id: "12" }, { repo, activePlanId: 7 })).toBe(7);
  });

  it("can skip requested plan validation", () => {
    const repo = { getOwnedProfileIdentity: vi.fn(() => null) };

    expect(resolvePlanId({ plan_id: "12" }, { repo, activePlanId: 7 }, false)).toBe(12);
    expect(repo.getOwnedProfileIdentity).not.toHaveBeenCalled();
  });
});
