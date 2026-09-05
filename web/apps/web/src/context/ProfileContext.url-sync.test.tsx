// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ProfileSummary } from "@print-partner/contracts";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";
import { useProfileUrlSync } from "../hooks/useProfileUrlSync";
import { ProfileProvider, useProfileSelection } from "./ProfileContext";

const queryRuntime = vi.hoisted(() => ({
  healthReady: true,
  profilesReady: true,
}));

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

vi.mock("./AuthContext", () => ({
  useAuth: () => ({ user: null, multiUser: false, loading: false }),
}));

vi.mock("../hooks/useEngineHealth", () => ({
  useEngineHealth: () => ({
    health: queryRuntime.healthReady ? { ok: true } : null,
    loading: !queryRuntime.healthReady,
  }),
}));

vi.mock("../queries/profiles", () => ({
  useProfilesQuery: (enabled: boolean) => ({
    data: enabled && queryRuntime.profilesReady ? profiles : undefined,
    isLoading: false,
    isSuccess: enabled && queryRuntime.profilesReady,
    error: null,
    refetch: vi.fn(),
  }),
}));

function wrapper(children: ReactNode, route: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>
        <ProfileProvider>{children}</ProfileProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function ProfileUrlProbe() {
  useProfileUrlSync();
  const { selectedProfileId, setSelectedProfileId } = useProfileSelection();
  const location = useLocation();
  return (
    <>
      <output data-testid="profile-url">
        {selectedProfileId ?? "none"}|{location.pathname}{location.search}
      </output>
      <button type="button" onClick={() => setSelectedProfileId(2)}>
        Select Build 2
      </button>
    </>
  );
}

describe("ProfileProvider URL ownership", () => {
  beforeEach(() => {
    sessionStorage.clear();
    queryRuntime.healthReady = true;
    queryRuntime.profilesReady = true;
  });
  afterEach(cleanup);

  it("lets an explicit URL Build win over first-Build hydration", async () => {
    render(wrapper(<ProfileUrlProbe />, "/sources?profile=2"));

    await waitFor(() => {
      expect(screen.getByTestId("profile-url").textContent).toBe(
        "2|/sources?profile=2",
      );
    });
    expect(sessionStorage.getItem("pp-selected-profile-id")).toBe("2");
  });

  it("preserves an explicit URL while health gates the profiles query", async () => {
    queryRuntime.healthReady = false;
    queryRuntime.profilesReady = false;
    const view = render(wrapper(<ProfileUrlProbe />, "/sources?profile=2"));

    await waitFor(() => {
      expect(screen.getByTestId("profile-url").textContent).toBe(
        "none|/sources?profile=2",
      );
    });

    queryRuntime.healthReady = true;
    queryRuntime.profilesReady = true;
    view.rerender(wrapper(<ProfileUrlProbe />, "/sources?profile=2"));

    await waitFor(() => {
      expect(screen.getByTestId("profile-url").textContent).toBe(
        "2|/sources?profile=2",
      );
    });
  });

  it("publishes a local Build selection to the URL", async () => {
    render(wrapper(<ProfileUrlProbe />, "/sources?profile=1"));
    await waitFor(() => {
      expect(screen.getByTestId("profile-url").textContent).toBe(
        "1|/sources?profile=1",
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Select Build 2" }));

    await waitFor(() => {
      expect(screen.getByTestId("profile-url").textContent).toBe(
        "2|/sources?profile=2",
      );
    });
  });
});
