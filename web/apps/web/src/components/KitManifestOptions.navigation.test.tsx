// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router-dom";
import BuildSaveNavigationGuard from "./BuildSaveNavigationGuard";
import KitManifestOptions from "./KitManifestOptions";
import { ImportRulesSaveProvider } from "../context/ImportRulesSaveContext";
import { KitManifestSaveProvider } from "../context/KitManifestSaveContext";

const mocks = vi.hoisted(() => ({ save: vi.fn() }));

vi.mock("../api/endpoints/planManifests", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/endpoints/planManifests")>();
  return {
    ...actual,
    fetchPlanManifestBuilder: vi.fn().mockResolvedValue({
      merged_option_groups: {
        variants: {
          rule: "pick_one",
          label: "Variants",
          parts: [],
          variants: [
            { id: "stock", label: "Stock", parts: [] },
            { id: "custom", label: "Custom", parts: [] },
          ],
        },
      },
      resolved_selections: { variants: "stock" },
    }),
    fetchPlanKitManifest: vi.fn().mockResolvedValue({
      name: null,
      layers: [],
      base_source_id: null,
      addon_source_ids: [],
      selections: {},
      include: [],
      exclude: [],
      replacements: {},
      choice_tree: [],
      category_links: [],
    }),
    savePlanKitManifest: mocks.save,
  };
});

describe("KitManifestOptions guarded navigation", () => {
  afterEach(() => {
    cleanup();
    mocks.save.mockReset();
  });

  it("keeps a failed variant edit on Plan when browser Back also fails to save", async () => {
    mocks.save.mockRejectedValue(new Error("offline"));
    function Page() {
      const location = useLocation();
      return location.pathname === "/plan" ? <KitManifestOptions profileId={2} /> : <h1>Sources</h1>;
    }
    const router = createMemoryRouter([{
      path: "*",
      element: (
        <ImportRulesSaveProvider>
          <KitManifestSaveProvider>
            <BuildSaveNavigationGuard />
            <Page />
          </KitManifestSaveProvider>
        </ImportRulesSaveProvider>
      ),
    }], { initialEntries: ["/sources?profile=2", "/plan?profile=2"], initialIndex: 1 });
    render(<RouterProvider router={router} />);

    fireEvent.click(await screen.findByRole("button", { name: "Custom" }));
    await screen.findByText("Save failed — retry");
    expect(mocks.save).toHaveBeenCalledTimes(1);
    act(() => { void router.navigate(-1); });
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(2));
    await waitFor(() => expect([...router.state.blockers.values()][0]?.state).toBe("unblocked"));
    expect(router.state.location.pathname).toBe("/plan");
    expect(screen.getByRole("button", { name: "Custom" }).getAttribute("aria-pressed")).toBe("true");
  });

});
