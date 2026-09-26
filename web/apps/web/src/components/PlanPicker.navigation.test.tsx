// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ProfileSummary } from "@print-partner/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router-dom";
import { PlanActionsProvider } from "../context/PlanActionsContext";
import { ProfileProvider, useProfileSelection } from "../context/ProfileContext";
import { useProfileUrlSync } from "../hooks/useProfileUrlSync";
import BuildSaveNavigationGuard from "./BuildSaveNavigationGuard";
import { LibraryDraftProvider } from "../context/LibraryDraftContext";
import PlanPicker from "./PlanPicker";

const saves = vi.hoisted(() => ({ flush: vi.fn<() => Promise<void>>() }));
const profiles: ProfileSummary[] = [1, 2].map((id) => ({
  id,
  name: `Build ${id}`,
  order_number: null,
  special_request: null,
  part_count: 0,
  accepted_progress: { kind: "empty" },
  build_stale: false,
  freshness: {
    status: "untracked",
    accepted_input_set_id: null,
    accepted_at: null,
    reasons: [{ kind: "no_accepted_inputs" }],
  },
  archived_at: null,
  last_used_at: null,
}));

vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({ user: null, multiUser: false, loading: false }),
}));
vi.mock("../hooks/useEngineHealth", () => ({
  useEngineHealth: () => ({ health: { ok: true } }),
}));
vi.mock("../hooks/useFlushBuildPageSaves", () => ({
  useFlushBuildPageSaves: () => saves.flush,
}));
vi.mock("../queries/profiles", () => {
  const mutation = () => ({ isPending: false, mutate: vi.fn(), mutateAsync: vi.fn() });
  return {
    useProfilesQuery: () => ({ data: profiles, isLoading: false, isSuccess: true, error: null, refetch: vi.fn() }),
    useCreateProfileMutation: mutation,
    useUpdateProfileMutation: mutation,
    useDeleteProfileMutation: mutation,
    useDuplicateProfileMutation: mutation,
    useArchiveProfileMutation: mutation,
    useTouchProfileLastUsedMutation: mutation,
  };
});

function Probe() {
  useProfileUrlSync();
  const location = useLocation();
  const { selectedProfileId } = useProfileSelection();
  return (
    <>
      <BuildSaveNavigationGuard />
      <PlanPicker />
      <output data-testid="route">{selectedProfileId}|{location.pathname}{location.search}</output>
    </>
  );
}

describe("PlanPicker guarded navigation", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => {
    cleanup();
    saves.flush.mockReset();
    vi.unstubAllGlobals();
  });

  it("keeps the selected Build and URL together when the save fails, then switches on retry", async () => {
    saves.flush.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createMemoryRouter([
      { path: "*", element: <ProfileProvider><PlanActionsProvider><Probe /></PlanActionsProvider></ProfileProvider> },
    ], { initialEntries: ["/plan?profile=1"] });
    render(<QueryClientProvider client={queryClient}><LibraryDraftProvider><RouterProvider router={router} /></LibraryDraftProvider></QueryClientProvider>);
    await waitFor(() => expect(screen.getByTestId("route").textContent).toBe("1|/plan?profile=1"));

    fireEvent.click(screen.getByRole("combobox", { name: "Select Build" }));
    fireEvent.click(screen.getByText("Build 2"));
    await waitFor(() => expect(saves.flush).toHaveBeenCalledTimes(1));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(screen.getByTestId("route").textContent).toBe("1|/plan?profile=1");

    fireEvent.click(screen.getByText("Build 2"));
    await waitFor(() => expect(screen.getByTestId("route").textContent).toBe("2|/plan?profile=2"));
  });
});
