import { describe, expect, it } from "vitest";
import { rollbackOptimisticCache } from "./reviewCache";

describe("optimistic review cache rollback", () => {
  it("restores an existing cache entry on rollback", () => {
    const previous = { profile_id: 12 };

    expect(rollbackOptimisticCache(previous)).toEqual({
      kind: "restore",
      previous,
    });
  });

  it("removes a synthetic cache entry on rollback", () => {
    expect(rollbackOptimisticCache(undefined)).toEqual({ kind: "remove" });
  });
});
