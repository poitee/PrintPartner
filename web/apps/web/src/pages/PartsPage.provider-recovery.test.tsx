// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PlanDraftWorkspace } from "@print-partner/contracts";
import { EngineHttpError } from "../api/engineTransport";
import {
  recomputePlanDraft,
  savePlanChoices,
  type SavePlanChoicesResponse,
} from "../api/endpoints/planDrafts";
import type { PlanReview } from "../api/endpoints/planManifests";
import {
  BuildSaveFlushProvider,
  useFlushBuildPageSaves,
} from "../context/BuildSaveFlushContext";
import {
  PlanWorkspaceProvider,
  usePlanWorkspace,
} from "../context/PlanWorkspaceContext";
import PartsPage from "./PartsPage";

const part = {
  id: 42,
  match_key: "frame/bracket.stl",
  relative_path: "frame/bracket.stl",
  source_layer: "base:Voron",
  filename: "bracket.stl",
};

const acceptedReview: PlanReview = {
  profile_id: 7,
  accepted_basis: {
    profile_id: 7,
    plan_revision_id: 3,
    plan_version: 1,
    plan_revision_digest: "c".repeat(64),
    required_unit_mapping_digest: "d".repeat(64),
  },
  plan_name: "Accepted Plan",
  layers: [],
  totals: {
    included_parts: 1,
    total_print_units: 1,
    by_role: {},
    by_filament: {},
  },
  issues: [],
  has_blockers: false,
  part_groups: [{
    folder: "frame",
    source_layer: "base:Voron",
    parts: [{
      ...part,
      included: true,
      status: "unchanged",
      role: "structural",
      requirement: null,
      option_group_id: null,
      filament_color_id: null,
      filament_display: "Unassigned",
      quantity_auto: 1,
      quantity_override: null,
      quantity_effective: 1,
      printed_count: 0,
      print_units: [],
      missing: true,
    }],
  }],
};

const draftWorkspace: PlanDraftWorkspace = {
  profile_id: 7,
  draft: {
    draft_id: 9,
    state: "open",
    lifecycle_version: 0,
    snapshot_digest: "a".repeat(64),
    base: { revision_id: 3, plan_version: 1 },
  },
  parts: [{
    draft_part_id: 17,
    base_revision_part_id: 42,
    part_key: part.match_key,
    filename: part.filename,
    relative_path: part.relative_path,
    source_layer: part.source_layer,
    role: "structural",
    quantity_inferred: 1,
    quantity_override: null,
    quantity_effective: 1,
    included: true,
  }],
  diff: { base_is_current: true, added: [], removed: [], changed: [] },
  reconciliation: {
    kind: "ready",
    reused_units: 0,
    new_units: 0,
    surplus_units: 0,
  },
};

function savedQuantity(): SavePlanChoicesResponse {
  return {
    receipt: {
      profile_id: 7,
      draft_id: 9,
      revision_id: 4,
      plan_version: 2,
      draft_lifecycle_version: 1,
      revision_digest: "e".repeat(64),
      required_unit_mapping_digest: "f".repeat(64),
      applied_at: "2026-10-03T00:00:00.000Z",
    },
    review: {
      ...acceptedReview,
      accepted_basis: {
        ...acceptedReview.accepted_basis!,
        plan_revision_id: 4,
        plan_version: 2,
        plan_revision_digest: "e".repeat(64),
        required_unit_mapping_digest: "f".repeat(64),
      },
    },
    profile: {
      id: 7,
      name: "Accepted Plan",
      order_number: null,
      special_request: null,
      part_count: 1,
      accepted_progress: { kind: "ready", total_units: 1, remaining_units: 1 },
      build_stale: false,
      freshness: {
        status: "current",
        accepted_input_set_id: 1,
        accepted_at: "2026-10-03T00:00:00.000Z",
      },
      archived_at: null,
      last_used_at: null,
    },
    closed_draft_ids: [9],
  };
}

vi.mock("../context/ProfileContext", () => ({
  useProfileSelection: () => ({
    selectedProfileId: 7,
    profiles: [{ id: 7, freshness: { status: "current" } }],
  }),
}));

vi.mock("../hooks/useEngineHealth", () => ({
  useEngineHealth: () => ({ health: { ok: true } }),
}));

vi.mock("../queries/planLayers", () => ({
  usePlanLayersQuery: () => ({
    data: [{ id: 1, project_id: 4, project_name: "Voron", layer_type: "base" }],
    isLoading: false,
  }),
}));

vi.mock("../queries/planReview", () => ({
  usePlanReviewQuery: () => ({ data: acceptedReview, isLoading: false, error: null }),
  usePatchPartMutation: () => ({ mutateAsync: vi.fn() }),
  usePatchPartProgressMutation: () => ({ mutateAsync: vi.fn() }),
  usePatchPartAssembledMutation: () => ({ mutateAsync: vi.fn() }),
  invalidatePlanReview: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../queries/planDraft", () => ({
  usePlanDraftListQuery: () => ({ data: [], isLoading: false, error: null }),
  usePlanDraftWorkspaceQuery: () => ({ data: undefined, isLoading: false, error: null }),
}));

vi.mock("../queries/profiles", () => ({
  refreshProfileSummary: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../api/endpoints/planDrafts", () => ({
  abandonPlanDraft: vi.fn(),
  applyPlanDraft: vi.fn(),
  editPlanDraftParts: vi.fn(),
  fetchPlanDraftWorkspace: vi.fn(),
  listPlanDrafts: vi.fn().mockResolvedValue([]),
  reconcilePlanDraft: vi.fn(),
  recomputePlanDraft: vi.fn(),
  rebasePlanDraft: vi.fn(),
  savePlanChoices: vi.fn(),
}));

vi.mock("../api/endpoints/stlNaming", () => ({
  fetchStlNaming: vi.fn().mockResolvedValue({ folder_rules: [] }),
}));

vi.mock("../components/KitManifestOptions", () => ({ default: () => null }));
vi.mock("../components/review/PlanFileSelection", () => ({ default: () => null }));
vi.mock("../components/review/PlanProgressChoices", () => ({ default: () => null }));
vi.mock("../components/review/PendingPlanFiles", () => ({ default: () => null }));
vi.mock("../components/build/PlanRolesCard", () => ({ default: () => null }));
vi.mock("../components/review/ReviewPartsSheet", () => ({ default: () => null }));

function Controls() {
  const plan = usePlanWorkspace();
  const flush = useFlushBuildPageSaves();
  return (
    <>
      <button onClick={() => void plan.setQuantity(part, 2).catch(() => {})}>
        Change quantity
      </button>
      <button onClick={() => void flush().then(
        () => undefined,
        (error: unknown) => {
          const output = document.querySelector("[data-testid='barrier']");
          if (output) output.textContent = error instanceof Error ? error.message : String(error);
        },
      )}>
        Leave page
      </button>
      <span data-testid="barrier" />
    </>
  );
}

let client: QueryClient;

beforeEach(() => {
  vi.clearAllMocks();
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  vi.mocked(recomputePlanDraft).mockReset().mockResolvedValue(draftWorkspace);
  vi.mocked(savePlanChoices).mockReset()
    .mockRejectedValueOnce(new EngineHttpError("Quantity is no longer valid", 422))
    .mockResolvedValueOnce(savedQuantity());
});

afterEach(() => {
  cleanup();
  client.clear();
});

it("keeps a definitive quantity failure blocked until the user deliberately retries", async () => {
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <BuildSaveFlushProvider>
          <PlanWorkspaceProvider>
            <PartsPage />
            <Controls />
          </PlanWorkspaceProvider>
        </BuildSaveFlushProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );

  fireEvent.click(screen.getByRole("button", { name: "Change quantity" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(
    "Quantity is no longer valid",
  ));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(savePlanChoices).toHaveBeenCalledOnce();
  expect(screen.getByRole("status").textContent).toBe("Not saved");
  const originalRequest = vi.mocked(savePlanChoices).mock.calls[0]?.[1];
  const originalKey = vi.mocked(savePlanChoices).mock.calls[0]?.[2];

  fireEvent.click(screen.getByRole("button", { name: "Leave page" }));
  await waitFor(() => expect(screen.getByTestId("barrier").textContent).toContain(
    "Quantity is no longer valid",
  ));
  expect(savePlanChoices).toHaveBeenCalledOnce();

  fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
  await waitFor(() => expect(savePlanChoices).toHaveBeenCalledTimes(2));
  expect(vi.mocked(savePlanChoices).mock.calls[1]?.[1]).toBe(originalRequest);
  expect(vi.mocked(savePlanChoices).mock.calls[1]?.[2]).toBe(originalKey);
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(screen.getByRole("status").textContent).toBe("Saved");
});
