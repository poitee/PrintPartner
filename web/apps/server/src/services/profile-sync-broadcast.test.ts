import { describe, expect, it, vi } from "vitest";
import {
  broadcastProfileSync,
  subscribeProfileSync,
} from "./profile-sync-broadcast.js";

describe("profile sync broadcast", () => {
  it("delivers profile changes only to listeners in the same tenant", () => {
    const tenantA = vi.fn();
    const tenantB = vi.fn();
    const unsubscribeA = subscribeProfileSync("tenant-a", tenantA);
    const unsubscribeB = subscribeProfileSync("tenant-b", tenantB);

    try {
      broadcastProfileSync("tenant-a", {
        kind: "process",
        slicer: "orca",
        name: "Fine",
        version: "2.3",
      });
      expect(tenantA).toHaveBeenCalledOnce();
      expect(tenantB).not.toHaveBeenCalled();
    } finally {
      unsubscribeA();
      unsubscribeB();
    }
  });
});
