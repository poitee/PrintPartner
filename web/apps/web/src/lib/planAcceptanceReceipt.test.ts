import { describe, expect, it } from "vitest";
import {
  clearPlanAcceptance,
  readPlanAcceptance,
  writePlanAcceptance,
} from "./planAcceptanceReceipt";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => map.delete(key),
    setItem: (key: string, value: string) => map.set(key, value),
  } as Storage;
}

const receipt = {
  buildId: 1,
  planVersion: 5,
  requiredUnits: 18,
  verifiedUnits: 11,
  remainingUnits: 7,
  unmoved: [],
  acceptedAt: "2026-08-27T10:00:00.000Z",
};

describe("acceptance receipt store", () => {
  it("survives a return to the page", () => {
    const storage = memoryStorage();
    writePlanAcceptance(receipt, storage);
    expect(readPlanAcceptance(1, storage)).toEqual(receipt);
  });

  it("keeps receipts apart per Build", () => {
    const storage = memoryStorage();
    writePlanAcceptance(receipt, storage);
    expect(readPlanAcceptance(2, storage)).toBeNull();
  });

  it("ignores damaged records and clears on request", () => {
    const storage = memoryStorage();
    storage.setItem("pp.plan-acceptance.1", "{ not json");
    expect(readPlanAcceptance(1, storage)).toBeNull();
    writePlanAcceptance(receipt, storage);
    clearPlanAcceptance(1, storage);
    expect(readPlanAcceptance(1, storage)).toBeNull();
  });
});
