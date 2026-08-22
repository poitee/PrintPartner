import { afterEach, describe, expect, it, vi } from "vitest";
import { savePlanKitManifest, type KitManifest } from "./engine";

const kit: KitManifest = {
  name: "test-kit",
  layers: [],
  selections: { toolhead: "stealthburner" },
  include: [],
  exclude: [],
  replacements: { "addon.stl": "base.stl" },
  choice_tree: [{ id: "toolhead", type: "pick_one" }],
  category_links: [{ categoryId: "frame", members: [] }],
};

describe("savePlanKitManifest", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("PUTs wrapped { kit } body to /plans/{id}/kit-manifest", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe("PUT");
      const body = JSON.parse(String(init?.body)) as { kit: KitManifest };
      expect(body).toEqual({ kit });
      expect(body.kit.choice_tree).toHaveLength(1);
      expect(body.kit.category_links?.[0]?.categoryId).toBe("frame");
      return new Response(JSON.stringify({ kit: body.kit }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const saved = await savePlanKitManifest(7, kit);
    expect(saved.selections.toolhead).toBe("stealthburner");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/plans\/7\/kit-manifest$/),
      expect.objectContaining({ method: "PUT" }),
    );
  });
});
