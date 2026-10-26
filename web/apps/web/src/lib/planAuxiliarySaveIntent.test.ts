import { afterEach, describe, expect, it } from "vitest";
import {
  resetAuxiliarySaveIntentForTests,
  retainFailedAuxiliarySave,
  retryFailedAuxiliarySaves,
} from "./planAuxiliarySaveIntent";

afterEach(() => {
  resetAuxiliarySaveIntentForTests();
});

describe("planAuxiliarySaveIntent", () => {
  it("retries every retained save when an earlier retry fails", async () => {
    const order: string[] = [];
    retainFailedAuxiliarySave(7, "special_request", "offline", async () => {
      order.push("special_request");
      throw new Error("offline");
    });
    retainFailedAuxiliarySave(7, "manifest", "offline", async () => {
      order.push("manifest");
    });

    await expect(retryFailedAuxiliarySaves(7)).rejects.toThrow("offline");

    expect(order).toEqual(["special_request", "manifest"]);
  });
});
