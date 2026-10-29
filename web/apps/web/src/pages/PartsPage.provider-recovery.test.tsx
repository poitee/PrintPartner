// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TENANT_FEATURE_TOGGLES_CAPABILITY, type PlanFeatures } from "@print-partner/contracts";
import PartsPage from "./PartsPage";
import { EngineHttpError } from "../api/engineTransport";
import {
  abandonPlanDraft,
  applyPlanDraft,
  editPlanDraftParts,
  listPlanDrafts,
  recomputePlanDraft,
  savePlanChoices,
  type SavePlanChoicesResponse,
} from "../api/endpoints/planDrafts";
import { fetchPlanFeatures } from "../api/endpoints/planFeatures";
import { fetchPlanReview, type PlanReview, type ReviewPart } from "../api/endpoints/planManifests";
import { BuildSaveFlushProvider } from "../context/BuildSaveFlushContext";
import { PlanWorkspaceProvider } from "../context/PlanWorkspaceContext";

// Real PlanWorkspaceProvider, router and Plan page. Only the engine endpoints are fixtures.
const health = vi.hoisted(() => ({ capabilities: [] as string[] }));
vi.mock("../context/ProfileContext", () => ({
  useProfileSelection: () => ({ selectedProfileId: 7, profiles: [{ id: 7, freshness: { status: "current" } }] }),
}));
vi.mock("../hooks/useEngineHealth", () => ({ useEngineHealth: () => ({ health: { ok: true } }) }));
vi.mock("../queries/health", () => ({
  useHealthQuery: () => ({ data: { ok: true, capabilities: health.capabilities }, status: "success", isSuccess: true }),
}));
vi.mock("../queries/planLayers", () => ({
  usePlanLayersQuery: () => ({ data: [{ id: 1, project_id: 4, project_name: "Voron", layer_type: "base" }], isLoading: false }),
}));
vi.mock("../api/endpoints/stlNaming", () => ({ fetchStlNaming: async () => ({ folder_rules: [] }) }));
vi.mock("../api/endpoints/planFeatures", () => ({ fetchPlanFeatures: vi.fn(), patchPlanFeatures: vi.fn() }));
vi.mock("../api/endpoints/planManifests", () => ({ fetchPlanReview: vi.fn() }));
vi.mock("../api/endpoints/planDrafts", () => ({
  savePlanChoices: vi.fn(), applyPlanDraft: vi.fn(), editPlanDraftParts: vi.fn(), fetchPlanDraftWorkspace: vi.fn(),
  listPlanDrafts: vi.fn(), recomputePlanDraft: vi.fn(), abandonPlanDraft: vi.fn(),
  reconcilePlanDraft: vi.fn(), rebasePlanDraft: vi.fn(),
}));
vi.mock("../components/plan/PlanFeaturesCard", () => ({ default: () => null }));
vi.mock("../components/KitManifestOptions", () => ({ default: () => null }));
vi.mock("../components/build/PlanRolesCard", () => ({ default: () => null }));
vi.mock("../components/review/ReviewPartsSheet", () => ({ default: () => null }));

const features: PlanFeatures = {
  profile_id: 7,
  overrides: {},
  effective: {
    farm: { enabled: false, source: "default" },
    orders: { enabled: false, source: "default" },
    bambu: { enabled: false, source: "default" },
    spoolman: { enabled: false, source: "default" },
  },
};
const part: ReviewPart = {
  id: 42, match_key: "bracket.stl", relative_path: "frame/bracket.stl", filename: "bracket.stl",
  source_layer: "base:Voron", status: "ok", role: "primary", requirement: null, option_group_id: null,
  included: true, filament_color_id: null, quantity_auto: 1, quantity_override: null, quantity_effective: 1,
  printed_count: 0, print_units: [false], missing: true, filament_display: "Unset",
};
function review(included: boolean, version: number): PlanReview {
  return {
    profile_id: 7, accepted_basis: { profile_id: 7, plan_revision_id: version + 2, plan_version: version,
      plan_revision_digest: "c".repeat(64), required_unit_mapping_digest: "d".repeat(64) },
    plan_name: "Disposable", layers: [],
    totals: { included_parts: Number(included), total_print_units: Number(included), by_role: {}, by_filament: {} },
    issues: [], has_blockers: false,
    part_groups: [{ source_layer: "base:Voron", folder: "frame", parts: [{ ...part, included }] }],
  };
}
const saved: SavePlanChoicesResponse = {
  receipt: { profile_id: 7, draft_id: 9, revision_id: 4, plan_version: 2, draft_lifecycle_version: 1,
    revision_digest: "c".repeat(64), required_unit_mapping_digest: "d".repeat(64), applied_at: "2026-10-28T00:00:00Z" },
  review: review(false, 2),
  profile: { id: 7, name: "Disposable", part_count: 1, order_number: null, special_request: null,
    accepted_progress: { kind: "ready", total_units: 0, remaining_units: 0 },
    build_stale: false, freshness: { status: "current", accepted_input_set_id: 1, accepted_at: "2026-10-28T00:00:00Z" },
    archived_at: null, last_used_at: null },
  closed_draft_ids: [9],
};
const refusal = "Quantity is no longer valid";

let client: QueryClient;
function renderApp() {
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/plan"]}>
        <PlanWorkspaceProvider>
          <BuildSaveFlushProvider>
            <Link to="/builds">Builds</Link>
            <Link to="/plan">Plan</Link>
            <Routes>
              <Route path="/plan" element={<PartsPage />} />
              <Route path="/builds" element={<h1>Builds</h1>} />
            </Routes>
          </BuildSaveFlushProvider>
        </PlanWorkspaceProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const checkbox = () => screen.getByRole("checkbox", { name: "Include bracket.stl" });
const recoveryAlert = () => screen.queryAllByRole("alert").find((node) => node.textContent?.includes(refusal)) ?? null;
const prepareCalls = () => [recomputePlanDraft, applyPlanDraft, abandonPlanDraft, editPlanDraftParts]
  .reduce((total, endpoint) => total + vi.mocked(endpoint).mock.calls.length, 0);

/** Refuses the first Save, then leaves the Plan route and comes back so PartsPage remounts. */
async function failSaveThenRemount() {
  vi.mocked(savePlanChoices).mockRejectedValueOnce(new EngineHttpError(refusal, 422));
  renderApp();
  await waitFor(() => expect(checkbox().getAttribute("aria-checked")).toBe("true"));
  fireEvent.click(checkbox());
  await waitFor(() => expect(recoveryAlert()).not.toBeNull());
  expect(savePlanChoices).toHaveBeenCalledOnce();
  const original = vi.mocked(savePlanChoices).mock.calls[0];

  fireEvent.click(screen.getByRole("link", { name: "Builds" }));
  await screen.findByRole("heading", { name: "Builds" });
  expect(screen.queryByRole("checkbox", { name: "Include bracket.stl" })).toBeNull();
  fireEvent.click(screen.getByRole("link", { name: "Plan" }));
  await waitFor(() => expect(recoveryAlert()).not.toBeNull());
  expect(checkbox().getAttribute("aria-checked")).toBe("false");
  return original;
}

beforeEach(() => {
  vi.resetAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  vi.mocked(fetchPlanFeatures).mockResolvedValue(features);
  vi.mocked(fetchPlanReview).mockResolvedValue(review(true, 1));
  vi.mocked(listPlanDrafts).mockResolvedValue([]);
  vi.mocked(savePlanChoices).mockResolvedValue(saved);
});
afterEach(() => {
  cleanup();
  client.clear();
});

describe("Plan page failed Save recovery with the real provider", () => {
  beforeEach(() => {
    health.capabilities = [TENANT_FEATURE_TOGGLES_CAPABILITY];
  });

  it("provider_recovery_never_auto_retries_failed_save", async () => {
    await failSaveThenRemount();
    // The remounted page's own prepare refuses from the retained intent instead of resending it.
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Not saved"));
    expect(screen.getByRole("button", { name: "Retry save" })).toBeTruthy();
    expect(savePlanChoices).toHaveBeenCalledOnce();
    expect(prepareCalls()).toBe(0);
  });

  it("provider_explicit_retry_publishes_once", async () => {
    const original = await failSaveThenRemount();
    let finish!: (response: SavePlanChoicesResponse) => void;
    vi.mocked(savePlanChoices).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const retry = screen.getByRole("button", { name: "Retry save" });
    fireEvent.click(retry);
    await waitFor(() => expect(savePlanChoices).toHaveBeenCalledTimes(2));
    // A second click while the retry runs must not publish again.
    fireEvent.click(retry);
    finish(saved);
    await waitFor(() => expect(recoveryAlert()).toBeNull());
    expect(screen.getByRole("status").textContent).toBe("Saved");
    expect(vi.mocked(savePlanChoices).mock.calls[1]).toEqual(original);

    fireEvent.click(screen.getByRole("link", { name: "Builds" }));
    await screen.findByRole("heading", { name: "Builds" });
    fireEvent.click(screen.getByRole("link", { name: "Plan" }));
    await waitFor(() => expect(checkbox().getAttribute("aria-checked")).toBe("false"));
    expect(screen.getByRole("status").textContent).toBe("Saved");
    expect(savePlanChoices).toHaveBeenCalledTimes(2);
    expect(prepareCalls()).toBe(0);
  });

  it("keeps the earlier file-choice flush with desktop rebuild off", async () => {
    health.capabilities = [];
    vi.mocked(savePlanChoices).mockRejectedValue(new EngineHttpError(refusal, 422));
    renderApp();
    await waitFor(() => expect(checkbox().getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(checkbox());
    // Flag-off does not gain the rebuild guard: the page's prepare resends the refused command.
    await waitFor(() => expect(savePlanChoices).toHaveBeenCalledTimes(2));
    expect(vi.mocked(savePlanChoices).mock.calls[1]).toEqual(vi.mocked(savePlanChoices).mock.calls[0]);
    await waitFor(() => expect(recoveryAlert()).not.toBeNull());
  });
});
