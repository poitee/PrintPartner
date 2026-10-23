import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resetAuxiliarySaveIntentForTests,
  retainFailedAuxiliarySave,
  retryFailedAuxiliarySaves,
} from "./planAuxiliarySaveIntent";

afterEach(() => {
  resetAuxiliarySaveIntentForTests();
});

describe("planAuxiliarySaveIntent", () => {
  it("failed_special_request_retry_preserves_order", async () => {
    const order: string[] = [];
    retainFailedAuxiliarySave(7, "special_request", async () => {
      order.push("special_request");
    });
    retainFailedAuxiliarySave(7, "manifest", async () => {
      order.push("manifest");
    });

    await retryFailedAuxiliarySaves(7);

    expect(order).toEqual(["special_request", "manifest"]);
  });
});
