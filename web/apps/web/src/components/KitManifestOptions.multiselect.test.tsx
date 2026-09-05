// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import KitManifestOptions from "./KitManifestOptions";
import {
  fetchPlanKitManifest,
  fetchPlanManifestBuilder,
} from "../api/endpoints/planManifests";

const mocks = vi.hoisted(() => ({
  saveUserEdit: vi.fn(),
}));

vi.mock("../api/endpoints/planManifests", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/endpoints/planManifests")>();
  return {
    ...actual,
    fetchPlanManifestBuilder: vi.fn().mockResolvedValue({
      merged_option_groups: {
        extras: {
          rule: "pick_n",
          label: "Optional extras",
          parts: [],
          variants: [
            { id: "skirts", label: "Skirts", parts: [] },
            { id: "panels", label: "Panels", parts: [] },
            { id: "screen", label: "Screen", parts: [] },
          ],
          min: 2,
          max: 2,
        },
      },
    }),
    fetchPlanKitManifest: vi.fn().mockResolvedValue({
      name: null,
      layers: [],
      selections: {},
      include: [],
      exclude: [],
    }),
  };
});

vi.mock("../context/KitManifestSaveContext", () => ({
  useKitManifestSaveRegistry: () => ({
    registerFlush: vi.fn(),
    unregisterFlush: vi.fn(),
  }),
}));

vi.mock("../hooks/useKitManifestAutosave", () => ({
  useKitManifestAutosave: () => ({
    dirty: false,
    status: "idle",
    saveNow: vi.fn(),
    saveUserEdit: mocks.saveUserEdit,
  }),
}));

describe("KitManifestOptions multi-select groups", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows resolved repository defaults before the user saves an override", async () => {
    vi.mocked(fetchPlanManifestBuilder).mockResolvedValueOnce({
      profile_id: 7,
      sources: [],
      resolved_selections: { extras: ["skirts", "panels"] },
      merged_option_groups: {
        extras: {
          rule: "pick_n",
          label: "Optional extras",
          parts: [],
          variants: [
            { id: "skirts", label: "Skirts", parts: [] },
            { id: "panels", label: "Panels", parts: [] },
            { id: "screen", label: "Screen", parts: [] },
          ],
          min: 2,
          max: 2,
        },
      },
    });

    render(
      <MemoryRouter>
        <KitManifestOptions profileId={7} />
      </MemoryRouter>,
    );

    expect((await screen.findByRole("button", { name: "Skirts" })).getAttribute("aria-pressed"))
      .toBe("true");
    expect(screen.getByRole("button", { name: "Panels" }).getAttribute("aria-pressed"))
      .toBe("true");
    expect(screen.getByRole("button", { name: "Screen" }).getAttribute("aria-pressed"))
      .toBe("false");
    expect(mocks.saveUserEdit).not.toHaveBeenCalled();
  });

  it("saves an explicit empty value when users deselect an optional default", async () => {
    vi.mocked(fetchPlanManifestBuilder).mockResolvedValueOnce({
      profile_id: 7,
      sources: [],
      resolved_selections: { extras: ["skirts"] },
      merged_option_groups: {
        extras: {
          rule: "pick_any",
          label: "Optional extras",
          parts: [],
          variants: [
            { id: "skirts", label: "Skirts", parts: [] },
            { id: "panels", label: "Panels", parts: [] },
          ],
          min: 0,
          max: null,
        },
      },
    });
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <KitManifestOptions profileId={7} />
      </MemoryRouter>,
    );

    const skirts = await screen.findByRole("button", { name: "Skirts" });
    expect(skirts.getAttribute("aria-pressed")).toBe("true");
    await user.click(skirts);

    expect(mocks.saveUserEdit).toHaveBeenLastCalledWith({ extras: [] });
    expect(skirts.getAttribute("aria-pressed")).toBe("false");
  });

  it("does not persist untouched defaults when users edit another group", async () => {
    vi.mocked(fetchPlanManifestBuilder).mockResolvedValueOnce({
      profile_id: 7,
      sources: [],
      resolved_selections: {
        extras: ["skirts"],
        finish: ["textured"],
      },
      merged_option_groups: {
        extras: {
          rule: "pick_any",
          label: "Optional extras",
          parts: [],
          variants: [{ id: "skirts", label: "Skirts", parts: [] }],
          min: 0,
          max: null,
        },
        finish: {
          rule: "pick_any",
          label: "Finish",
          parts: [],
          variants: [{ id: "textured", label: "Textured", parts: [] }],
          min: 0,
          max: null,
        },
      },
    });
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <KitManifestOptions profileId={7} />
      </MemoryRouter>,
    );

    expect(
      (await screen.findByRole("button", { name: "Textured" })).getAttribute(
        "aria-pressed",
      ),
    ).toBe("true");
    await user.click(screen.getByRole("button", { name: "Skirts" }));

    expect(mocks.saveUserEdit).toHaveBeenLastCalledWith({ extras: [] });
  });

  it("does not display an undeclared default for a one-variant pick-one group", async () => {
    vi.mocked(fetchPlanManifestBuilder).mockResolvedValueOnce({
      profile_id: 7,
      sources: [],
      resolved_selections: {},
      merged_option_groups: {
        toolhead: {
          rule: "pick_one",
          label: "Toolhead",
          parts: [],
          variants: [{ id: "stock", label: "Stock", parts: [] }],
          min: 1,
          max: 1,
        },
      },
    });

    render(
      <MemoryRouter>
        <KitManifestOptions profileId={7} />
      </MemoryRouter>,
    );

    expect(
      (await screen.findByRole("button", { name: "Stock" })).getAttribute(
        "aria-pressed",
      ),
    ).toBe("false");
    expect(mocks.saveUserEdit).not.toHaveBeenCalled();
  });

  it("keeps a stale empty tombstone when users edit a surviving group", async () => {
    vi.mocked(fetchPlanKitManifest).mockResolvedValueOnce({
      name: null,
      layers: [],
      selections: { retired_group: [] },
      include: [],
      exclude: [],
    });
    vi.mocked(fetchPlanManifestBuilder).mockResolvedValueOnce({
      profile_id: 7,
      sources: [],
      resolved_selections: {
        extras: ["skirts"],
        retired_group: [],
      },
      merged_option_groups: {
        extras: {
          rule: "pick_any",
          label: "Optional extras",
          parts: [],
          variants: [{ id: "skirts", label: "Skirts", parts: [] }],
          min: 0,
          max: null,
        },
      },
    });
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <KitManifestOptions profileId={7} />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole("button", { name: "Skirts" }));

    expect(mocks.saveUserEdit).toHaveBeenLastCalledWith({
      retired_group: [],
      extras: [],
    });
  });

  it("persists an empty required multi-select as an incomplete choice", async () => {
    vi.mocked(fetchPlanManifestBuilder).mockResolvedValueOnce({
      profile_id: 7,
      sources: [],
      resolved_selections: { extras: ["skirts", "panels"] },
      merged_option_groups: {
        extras: {
          rule: "pick_n",
          label: "Required extras",
          parts: [],
          variants: [
            { id: "skirts", label: "Skirts", parts: [] },
            { id: "panels", label: "Panels", parts: [] },
          ],
          min: 2,
          max: 2,
        },
      },
    });
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <KitManifestOptions profileId={7} />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole("button", { name: "Skirts" }));
    await user.click(screen.getByRole("button", { name: "Panels" }));

    expect(mocks.saveUserEdit).toHaveBeenLastCalledWith({ extras: [] });
    expect(screen.getByText("Choose at least 2 options.")).not.toBeNull();
  });

  it("lets users satisfy an inclusive pick_n range without exceeding its maximum", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <KitManifestOptions profileId={7} />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("heading", { name: "Optional extras" }),
    ).not.toBeNull();
    expect(screen.getByText("Choose at least 2 options.")).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Skirts" }));
    expect(mocks.saveUserEdit).toHaveBeenLastCalledWith({ extras: ["skirts"] });
    expect(screen.getByText("Choose at least 2 options.")).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Panels" }));
    expect(mocks.saveUserEdit).toHaveBeenLastCalledWith({
      extras: ["skirts", "panels"],
    });
    await waitFor(() => {
      expect(screen.queryByText("Choose at least 2 options.")).toBeNull();
    });
    expect(screen.getByRole("button", { name: "Screen" }).hasAttribute("disabled")).toBe(
      true,
    );
  });
});
