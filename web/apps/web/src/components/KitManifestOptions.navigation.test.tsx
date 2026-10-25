// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, MemoryRouter, RouterProvider, useLocation } from "react-router-dom";
import BuildSaveNavigationGuard from "./BuildSaveNavigationGuard";
import { LibraryDraftProvider } from "../context/LibraryDraftContext";
import KitManifestOptions from "./KitManifestOptions";
import { BuildSaveFlushProvider } from "../context/BuildSaveFlushContext";
import { resetKitManifestAutosaveForTests } from "../hooks/useKitManifestAutosave";
import { resetAuxiliarySaveIntentForTests } from "../lib/planAuxiliarySaveIntent";

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
  // An unmount flush can settle after afterEach, so each test also starts from a clean slate.
  beforeEach(() => {
    resetKitManifestAutosaveForTests();
    resetAuxiliarySaveIntentForTests();
  });

  afterEach(() => {
    cleanup();
    mocks.save.mockReset();
    resetKitManifestAutosaveForTests();
    resetAuxiliarySaveIntentForTests();
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
        <BuildSaveFlushProvider>
          <BuildSaveNavigationGuard />
          <Page />
        </BuildSaveFlushProvider>
      ),
    }], { initialEntries: ["/sources?profile=2", "/plan?profile=2"], initialIndex: 1 });
    render(<LibraryDraftProvider><RouterProvider router={router} /></LibraryDraftProvider>);

    fireEvent.click(await screen.findByRole("button", { name: "Custom" }));
    await screen.findByText("Save failed — retry");
    expect(mocks.save).toHaveBeenCalledTimes(1);
    act(() => { void router.navigate(-1); });
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(2));
    await waitFor(() => expect([...router.state.blockers.values()][0]?.state).toBe("unblocked"));
    expect(router.state.location.pathname).toBe("/plan");
    expect(screen.getByRole("button", { name: "Custom" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("shows a failed variant edit after the editor remounts and retries it there", async () => {
    mocks.save.mockRejectedValue(new Error("offline"));
    const editor = () => <MemoryRouter><BuildSaveFlushProvider><KitManifestOptions profileId={2} /></BuildSaveFlushProvider></MemoryRouter>;
    const first = render(editor());
    fireEvent.click(await screen.findByRole("button", { name: "Custom" }));
    await screen.findByText("Save failed — retry");
    first.unmount();
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(2));

    render(editor());
    await screen.findByText("Save failed — retry");
    expect(screen.getByRole("button", { name: "Custom" }).getAttribute("aria-pressed")).toBe("true");
    mocks.save.mockImplementation(async (_profileId, kit) => kit);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("Saved");
    expect(mocks.save).toHaveBeenCalledTimes(3);
    expect(mocks.save.mock.calls[2]?.[1]).toEqual(mocks.save.mock.calls[0]?.[1]);
  });
});
