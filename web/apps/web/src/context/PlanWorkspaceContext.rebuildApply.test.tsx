// @vitest-environment jsdom

import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TENANT_FEATURE_TOGGLES_CAPABILITY,
  type PlanDraftWorkspace,
  type PlanFeatures,
} from "@print-partner/contracts";
import {
  applyPlanDraft,
  fetchPlanDraftWorkspace,
  listPlanDrafts,
} from "../api/endpoints/planDrafts";
import { fetchPlanFeatures } from "../api/endpoints/planFeatures";
import { fetchPlanReview, type PlanReview } from "../api/endpoints/planManifests";
import { queryKeys } from "../queries/keys";
import { PlanWorkspaceProvider, usePlanWorkspace } from "./PlanWorkspaceContext";

const features: PlanFeatures = {
  profile_id: 7,
  overrides: { spoolman: true },
  effective: {
    farm: { enabled: false, source: "default" },
    orders: { enabled: false, source: "default" },
    bambu: { enabled: false, source: "default" },
    spoolman: { enabled: true, source: "plan" },
  },
};

const workspace: PlanDraftWorkspace = {
  profile_id: 7,
  draft: {
    draft_id: 9,
    state: "open",
    lifecycle_version: 0,
    snapshot_digest: "a".repeat(64),
    base: { revision_id: 3, plan_version: 1 },
  },
  parts: [],
  diff: { base_is_current: true, added: [], removed: [], changed: [] },
  reconciliation: { kind: "ready", reused_units: 0, new_units: 0, surplus_units: 0 },
};

function reviewFor(revisionId: number): PlanReview {
  return {
    profile_id: 7,
    accepted_basis: {
      profile_id: 7,
      plan_revision_id: revisionId,
      plan_version: 2,
      plan_revision_digest: "c".repeat(64),
      required_unit_mapping_digest: "d".repeat(64),
    },
    plan_name: "Accepted Plan",
    layers: [],
    totals: { included_parts: 0, total_print_units: 0, by_role: {}, by_filament: {} },
    issues: [],
    has_blockers: false,
    part_groups: [],
  };
}

const applyPhase = vi.hoisted(() => ({
  on: false,
  draftsOpen: true,
  gate: Promise.resolve() as Promise<void>,
}));

vi.mock("../api/endpoints/planDrafts", () => ({
  applyPlanDraft: vi.fn(),
  abandonPlanDraft: vi.fn(),
  editPlanDraftParts: vi.fn(),
  fetchPlanDraftWorkspace: vi.fn(),
  listPlanDrafts: vi.fn(),
  reconcilePlanDraft: vi.fn(),
  recomputePlanDraft: vi.fn(),
  rebasePlanDraft: vi.fn(),
  savePlanChoices: vi.fn(),
}));

vi.mock("../api/endpoints/planManifests", () => ({
  fetchPlanReview: vi.fn(),
}));

vi.mock("../api/endpoints/planFeatures", () => ({
  fetchPlanFeatures: vi.fn(),
  patchPlanFeatures: vi.fn(),
}));

vi.mock("../hooks/useEngineHealth", () => ({
  useEngineHealth: () => ({ health: { ok: true } }),
}));

vi.mock("../queries/health", () => ({
  useHealthQuery: () => ({
    data: { ok: true, capabilities: [TENANT_FEATURE_TOGGLES_CAPABILITY] },
    status: "success" as const,
    isSuccess: true,
  }),
}));

vi.mock("./ProfileContext", () => ({
  useProfileSelection: () => ({ selectedProfileId: 7 }),
}));

function held() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function SlowWorkflow() {
  useQuery({
    queryKey: queryKeys.buildWorkflow(7),
    queryFn: async () => {
      if (applyPhase.on) await applyPhase.gate;
      return { ok: true };
    },
  });
  return null;
}

afterEach(() => {
  cleanup();
  applyPhase.on = false;
  applyPhase.draftsOpen = true;
  applyPhase.gate = Promise.resolve();
  vi.clearAllMocks();
});

describe("PlanWorkspaceProvider real review apply", () => {
  it("workspace_rebuild_apply_does_not_repin_a_closed_draft", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
    });
    const workflow = held();
    applyPhase.gate = Promise.resolve();
    client.setQueryData(queryKeys.planFeatures(7), features);
    vi.mocked(fetchPlanFeatures).mockResolvedValue(features);
    vi.mocked(fetchPlanDraftWorkspace).mockResolvedValue(workspace);
    vi.mocked(listPlanDrafts).mockImplementation(async () =>
      applyPhase.draftsOpen ? [workspace.draft] : [{ ...workspace.draft, state: "abandoned" }],
    );
    vi.mocked(applyPlanDraft).mockResolvedValue({
      profile_id: 7,
      draft_id: 9,
      revision_id: 4,
      plan_version: 2,
      draft_lifecycle_version: 1,
      revision_digest: "c".repeat(64),
      required_unit_mapping_digest: "d".repeat(64),
      applied_at: "2026-08-21T12:00:00.000Z",
    });
    vi.mocked(fetchPlanReview).mockImplementation(async () => reviewFor(applyPhase.on ? 4 : 3));
    const hook = renderHook(usePlanWorkspace, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>
          <PlanWorkspaceProvider>
            <SlowWorkflow />
            {children}
          </PlanWorkspaceProvider>
        </QueryClientProvider>
      ),
    });
    await waitFor(() => expect(hook.result.current.review?.accepted_basis?.plan_revision_id).toBe(3));
    const pinnedKey = queryKeys.planReview(7, false, true, workspace.draft.base.revision_id);
    applyPhase.gate = workflow.promise;
    applyPhase.on = true;
    applyPhase.draftsOpen = false;
    let settled = false;
    let applying!: Promise<unknown>;
    act(() => {
      applying = hook.result.current.applyActivePlanDraft().finally(() => { settled = true; });
    });
    await waitFor(() => {
      const listed = client.getQueryData<Array<{ state: string }>>(queryKeys.planDrafts(7));
      expect(listed?.[0]?.state).toBe("abandoned");
    });
    expect(settled).toBe(false);
    expect(hook.result.current.error).toBeNull();
    expect(client.getQueryState(pinnedKey)?.status).not.toBe("error");
    workflow.release();
    await act(async () => { await applying; });
    await waitFor(() => expect(hook.result.current.review?.accepted_basis?.plan_revision_id).toBe(4));
    expect(hook.result.current.error).toBeNull();
    expect(client.getQueryState(pinnedKey)?.status).not.toBe("error");
  });
});
