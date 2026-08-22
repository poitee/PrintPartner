import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPlanPhaseManifest } from "./engine";

describe("fetchPlanPhaseManifest", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns an empty optional manifest when the endpoint is absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: "Not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(fetchPlanPhaseManifest(7)).resolves.toEqual({
      profile_id: 7,
      has_phases: false,
      phases: [],
    });
  });

  it("keeps real phase-manifest failures visible", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: "database unavailable" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(fetchPlanPhaseManifest(7)).rejects.toThrow("database unavailable");
  });
});
