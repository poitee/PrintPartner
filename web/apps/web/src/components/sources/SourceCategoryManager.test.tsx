// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveSourceCategories } from "../../api/engine";
import { queryKeys } from "../../queries/keys";
import { useSourceCategoriesQuery } from "../../queries/sourceCategories";
import SourceCategoryManager from "./SourceCategoryManager";

vi.mock("../../api/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/engine")>();
  return {
    ...actual,
    fetchSourceCategories: vi.fn().mockResolvedValue(["Frames"]),
    saveSourceCategories: vi.fn(async (input: { categories: string[] }) => input.categories),
  };
});

function SavedCategories() {
  const { data = [] } = useSourceCategoriesQuery();
  return <output data-testid="saved-categories">{data.join("|")}</output>;
}

describe("SourceCategoryManager", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("nests a new subcategory under its category and saves the full path", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    queryClient.setQueryData(queryKeys.sourceCategories, ["Voron"]);

    render(
      <QueryClientProvider client={queryClient}>
        <SourceCategoryManager engineReady />
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Add subcategory under Voron" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Subcategory 2" }), {
      target: { value: "Voron 2.4" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save categories" }));

    await waitFor(() => expect(vi.mocked(saveSourceCategories)).toHaveBeenCalled());
    expect(vi.mocked(saveSourceCategories).mock.calls[0]?.[0]).toEqual({
      categories: ["Voron", "Voron/Voron 2.4"],
      replacements: {},
    });
  });

  it("moves a renamed category's subcategories with it", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    queryClient.setQueryData(queryKeys.sourceCategories, ["Voron", "Voron/Trident"]);

    render(
      <QueryClientProvider client={queryClient}>
        <SourceCategoryManager engineReady />
      </QueryClientProvider>,
    );

    fireEvent.change(await screen.findByRole("textbox", { name: "Category 1" }), {
      target: { value: "Voron kits" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save categories" }));

    await waitFor(() => expect(vi.mocked(saveSourceCategories)).toHaveBeenCalled());
    expect(vi.mocked(saveSourceCategories).mock.calls[0]?.[0]).toEqual({
      categories: ["Voron kits", "Voron kits/Trident"],
      replacements: { Voron: "Voron kits", "Voron/Trident": "Voron kits/Trident" },
    });
  });

  it("rejects a slash typed into a category name", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    queryClient.setQueryData(queryKeys.sourceCategories, ["Voron"]);

    render(
      <QueryClientProvider client={queryClient}>
        <SourceCategoryManager engineReady />
      </QueryClientProvider>,
    );

    fireEvent.change(await screen.findByRole("textbox", { name: "Category 1" }), {
      target: { value: "Voron/Trident" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save categories" }));

    expect(await screen.findByText(/use Add sub to nest one/)).toBeTruthy();
    expect(vi.mocked(saveSourceCategories)).not.toHaveBeenCalled();
  });

  it("keeps an unsaved draft local and publishes a successful save to shared state", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    queryClient.setQueryData(queryKeys.sourceCategories, ["Frames"]);

    render(
      <QueryClientProvider client={queryClient}>
        <SourceCategoryManager engineReady />
        <SavedCategories />
      </QueryClientProvider>,
    );

    const firstCategory = await screen.findByRole("textbox", { name: "Category 1" });
    fireEvent.change(screen.getByLabelText("Add category"), {
      target: { value: "Draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    act(() => queryClient.setQueryData(queryKeys.sourceCategories, ["External"]));

    expect((firstCategory as HTMLInputElement).value).toBe("Frames");
    expect(
      (screen.getByRole("textbox", { name: "Category 2" }) as HTMLInputElement).value,
    ).toBe("Draft");
    await waitFor(() =>
      expect(screen.getByTestId("saved-categories").textContent).toBe("External"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Save categories" }));

    await waitFor(() =>
      expect(screen.getByTestId("saved-categories").textContent).toBe("Frames|Draft"),
    );
  });

  it("keeps the edited draft when a save is rejected", async () => {
    vi.mocked(saveSourceCategories).mockRejectedValueOnce(new Error("Save failed"));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    queryClient.setQueryData(queryKeys.sourceCategories, ["Frames"]);

    render(
      <QueryClientProvider client={queryClient}>
        <SourceCategoryManager engineReady />
        <SavedCategories />
      </QueryClientProvider>,
    );

    const firstCategory = await screen.findByRole("textbox", { name: "Category 1" });
    fireEvent.change(firstCategory, { target: { value: "Edited frames" } });
    fireEvent.click(screen.getByRole("button", { name: "Save categories" }));

    await screen.findByText("Save failed");
    expect((firstCategory as HTMLInputElement).value).toBe("Edited frames");
    expect(screen.getByTestId("saved-categories").textContent).toBe("Frames");
  });

  it("resumes saved-state updates after the draft is restored", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    queryClient.setQueryData(queryKeys.sourceCategories, ["Frames"]);

    render(
      <QueryClientProvider client={queryClient}>
        <SourceCategoryManager engineReady />
        <SavedCategories />
      </QueryClientProvider>,
    );

    const firstCategory = await screen.findByRole("textbox", { name: "Category 1" });
    fireEvent.change(firstCategory, { target: { value: "Edited" } });
    fireEvent.change(firstCategory, { target: { value: "Frames" } });

    act(() => queryClient.setQueryData(queryKeys.sourceCategories, ["External"]));

    await waitFor(() =>
      expect((firstCategory as HTMLInputElement).value).toBe("External"),
    );

    fireEvent.change(firstCategory, { target: { value: "Saved external" } });
    const saveButton = screen.getByRole("button", { name: "Save categories" });
    await waitFor(() => {
      expect((firstCategory as HTMLInputElement).value).toBe("Saved external");
      expect((saveButton as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(saveButton);

    await waitFor(() =>
      expect(screen.getByTestId("saved-categories").textContent).toBe("Saved external"),
    );
  });

  it("sends stable rename and removal mappings with the saved category order", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    queryClient.setQueryData(queryKeys.sourceCategories, ["Frames", "Mods", "Other"]);

    render(
      <QueryClientProvider client={queryClient}>
        <SourceCategoryManager engineReady />
      </QueryClientProvider>,
    );

    fireEvent.change(await screen.findByRole("textbox", { name: "Category 2" }), {
      target: { value: "Upgrades" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[2]!);
    fireEvent.click(screen.getByRole("button", { name: "Save categories" }));

    await waitFor(() =>
      expect(saveSourceCategories).toHaveBeenCalledWith(
        {
          categories: ["Frames", "Upgrades"],
          replacements: { Mods: "Upgrades", Other: null },
        },
        expect.anything(),
      ),
    );
  });
});
