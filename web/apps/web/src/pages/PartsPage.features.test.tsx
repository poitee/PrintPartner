// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  TENANT_FEATURE_TOGGLES_CAPABILITY,
  type PlanFeatures,
} from "@print-partner/contracts";
import PartsPage from "./PartsPage";
import { BuildSaveFlushProvider } from "../context/BuildSaveFlushContext";

const state = vi.hoisted(() => ({
  capabilities: [] as string[],
  selectedProfileId: 1 as number | null,
  pending: false,
  fetchCalls: [] as number[],
  featuresData: {
    profile_id: 1,
    overrides: {},
    effective: {
      farm: { enabled: false, source: "default" as const },
      orders: { enabled: false, source: "default" as const },
      bambu: { enabled: false, source: "default" as const },
      spoolman: { enabled: false, source: "default" as const },
    },
  } as PlanFeatures,
}));

vi.mock("../hooks/useEngineHealth", () => ({
  useEngineHealth: () => ({
    health: { ok: true, capabilities: state.capabilities },
    error: null,
    loading: false,
    fetching: false,
    refresh: vi.fn(),
  }),
}));

vi.mock("../context/ProfileContext", () => ({
  useProfileSelection: () => ({
    selectedProfileId: state.selectedProfileId,
    profiles: state.selectedProfileId ? [{ id: state.selectedProfileId, freshness: { status: "current" } }] : [],
    loading: false,
    error: null,
    reloadProfiles: vi.fn(),
  }),
}));

vi.mock("../context/PlanWorkspaceContext", () => ({
  usePlanWorkspace: () => ({
    review: null,
    loading: false,
    error: null,
    draftError: null,
    draftWorkspace: state.pending ? { profile_id: 1, draft: { draft_id: 1, snapshot_digest: "proof" } } : null,
    draftLoading: false,
    preparePlan: vi.fn(),
    saving: false,
    refresh: vi.fn(),
    mergeConflict: false,
    discardPendingEdits: vi.fn(),
  }),
}));

vi.mock("../components/review/PendingPlanFiles", () => ({ default: () => null }));
vi.mock("../components/review/PlanProgressChoices", () => ({ default: () => null }));

vi.mock("../queries/planLayers", () => ({
  usePlanLayersQuery: () => ({ data: [], isLoading: false }),
}));

vi.mock("../api/endpoints/stlNaming", () => ({
  fetchStlNaming: async () => ({ folder_rules: [] }),
}));

vi.mock("../api/endpoints/planFeatures", () => ({
  fetchPlanFeatures: vi.fn().mockImplementation(async (profileId: number) => {
    state.fetchCalls.push(profileId);
    return state.featuresData;
  }),
  patchPlanFeatures: vi.fn(),
}));

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <BuildSaveFlushProvider>
          <PartsPage />
        </BuildSaveFlushProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("PartsPage feature toggles integration", () => {
  beforeEach(() => {
    state.capabilities = [];
    state.pending = false;
    state.selectedProfileId = 1;
    state.fetchCalls = [];
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("flag-off: hides controls and makes no feature reads on a selected empty Plan", () => {
    state.capabilities = [];
    renderPage();

    expect(screen.getByText("Add a source from the Library to get started.")).toBeTruthy();
    expect(screen.queryByText("Plan feature toggles")).toBeNull();
    expect(state.fetchCalls).toEqual([]);
  });

  it("keeps controls visible while the selected Plan has pending edits", async () => {
    state.capabilities = [TENANT_FEATURE_TOGGLES_CAPABILITY];
    state.pending = true;
    renderPage();
    expect(await screen.findByRole("button", { name: "Print farm: Inherit" })).toBeTruthy();
    expect(state.fetchCalls).toEqual([1]);
  });

  it("flag-on: renders PlanFeaturesCard on a selected empty Plan and fetches features", async () => {
    state.capabilities = [TENANT_FEATURE_TOGGLES_CAPABILITY];
    renderPage();

    expect(await screen.findByText("Plan feature toggles")).toBeTruthy();
    expect(screen.getByText("Add a source from the Library to get started.")).toBeTruthy();
    expect(await screen.findByText("Print farm")).toBeTruthy();
    expect(state.fetchCalls).toContain(1);
  });
});
