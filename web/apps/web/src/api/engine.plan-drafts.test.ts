import { afterEach, describe, expect, it, vi } from "vitest";
import { recomputePlanDraft, type PlanDraftWorkspace } from "./engine";

const workspace: PlanDraftWorkspace = {
  profile_id: 7,
  draft: {
    draft_id: 9,
    state: "open",
    lifecycle_version: 0,
    snapshot_digest: "a".repeat(64),
    base: { revision_id: 3, plan_version: 1 },
  },
  parts: [],
  diff: { base_is_current: true, added: [], removed: [], changed: [] },
  reconciliation: { kind: "ready", reused_units: 0, new_units: 0, surplus_units: 0 },
};

describe("Plan draft API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates an idempotency key when randomUUID is unavailable", async () => {
    vi.stubGlobal("crypto", {});
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Idempotency-Key")).toMatch(/^idem-/);
      return new Response(JSON.stringify(workspace), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(recomputePlanDraft(7)).resolves.toEqual(workspace);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
