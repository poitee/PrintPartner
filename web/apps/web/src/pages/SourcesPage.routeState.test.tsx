// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import SourcesPage from "./SourcesPage";

vi.mock("../api/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/engine")>();
  return {
    ...actual,
    fetchSources: vi.fn().mockResolvedValue([]),
    fetchSourceCategories: vi.fn().mockResolvedValue([]),
  };
});
vi.mock("../hooks/useEngineHealth", () => ({
  useEngineHealth: () => ({ health: { ok: true }, error: null, loading: false }),
}));
vi.mock("../hooks/useJobRunner", () => ({
  useJobRunner: () => ({ busy: false, runJob: vi.fn() }),
}));
vi.mock("../hooks/useImportSharedBuild", () => ({
  useImportSharedBuild: () => vi.fn(),
}));
vi.mock("../context/DateFormatContext", () => ({
  useDateFormat: () => ({ formatDate: (value: string) => value }),
}));
vi.mock("../context/JobContext", () => ({
  useJobContext: () => ({ activeJobs: [] }),
}));
vi.mock("../context/PlanWorkspaceContext", () => ({
  usePlanWorkspace: () => ({ review: null }),
}));
vi.mock("../context/ProfileContext", () => ({
  useProfileSelection: () => ({ profiles: [], selectedProfileId: null }),
}));

function LocationStateProbe() {
  const location = useLocation();
  return <output data-testid="location-state">{JSON.stringify(location.state)}</output>;
}

describe("SourcesPage route state", () => {
  afterEach(cleanup);

  it("opens and focuses global STL search, then consumes CommandPalette state", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[{ pathname: "/library", state: { stlSearch: true } }]}>
          <Routes>
            <Route
              path="/library"
              element={
                <>
                  <SourcesPage />
                  <LocationStateProbe />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const search = await screen.findByRole("textbox", {
      name: "Search all repos for a part",
    });
    await waitFor(() => expect(document.activeElement).toBe(search));
    await waitFor(() =>
      expect(screen.getByTestId("location-state").textContent).toBe("null"),
    );
  });
});
