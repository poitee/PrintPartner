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
    saveSourceCategories: vi.fn(async (categories: string[]) => categories),
  };
});

function SavedCategories() {
  const { data = [] } = useSourceCategoriesQuery();
  return <output data-testid="saved-categories">{data.join("|")}</output>;
}

describe("SourceCategoryManager", () => {
  afterEach(cleanup);

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
    fireEvent.click(screen.getByRole("button", { name: "Save categories" }));

    await waitFor(() =>
      expect(screen.getByTestId("saved-categories").textContent).toBe("Saved external"),
    );
  });
});
