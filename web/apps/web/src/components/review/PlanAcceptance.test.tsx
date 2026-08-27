// @vitest-environment jsdom

/**
 * Plan is the acceptance checkpoint. This drives the real decision path:
 * a blocked Accept, the Required-unit answers that unblock it, and the durable
 * receipt that stays on the page afterwards. Only the engine HTTP layer is
 * mocked.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { PlanDraftWorkspace } from "@print-partner/contracts";
import { applyPlanDraft, reconcilePlanDraft } from "../../api/endpoints/planDrafts";
import type { PlanReview, ReviewPart } from "../../api/endpoints/planManifests";
import { queryKeys } from "../../queries/keys";
import { PlanWorkspaceProvider } from "../../context/PlanWorkspaceContext";
import { PlanAcceptanceProvider } from "./PlanAcceptanceContext";
import PlanAcceptanceActionCard from "./PlanAcceptanceActionCard";
import PlanAcceptanceConfirmation from "./PlanAcceptanceConfirmation";
import PlanAcceptedRevisionCard from "./PlanAcceptedRevisionCard";
import PlanIssuesSection from "./PlanIssuesSection";
import WorkingPlanReviewCard from "../build/WorkingPlanReviewCard";

/** A tiny store so the mocked draft query re-renders like the real one. */
const state = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    review: null as PlanReview | null,
    workspace: null as PlanDraftWorkspace | null,
    version: 0,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot() {
      return state.version;
    },
    setWorkspace(next: PlanDraftWorkspace | null) {
      state.workspace = next;
      state.version += 1;
      for (const listener of listeners) listener();
    },
  };
});

vi.mock("../../api/endpoints/planDrafts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/endpoints/planDrafts")>();
  return {
    ...actual,
    editPlanDraftParts: vi.fn(),
    recomputePlanDraft: vi.fn(),
    rebasePlanDraft: vi.fn(),
    applyPlanDraft: vi.fn(),
    abandonPlanDraft: vi.fn(),
    reconcilePlanDraft: vi.fn(),
  };
});

vi.mock("../../hooks/useEngineHealth", () => ({
  useEngineHealth: () => ({ health: { ok: true } }),
}));

vi.mock("../../context/ProfileContext", () => ({
  useProfileSelection: () => ({ selectedProfileId: 7, profiles: [] }),
}));

vi.mock("../../queries/planReview", () => ({
  usePlanReviewQuery: () => ({ data: state.review, isLoading: false, error: null }),
  usePatchPartMutation: () => ({ mutateAsync: vi.fn() }),
  usePatchPartProgressMutation: () => ({ mutateAsync: vi.fn() }),
  usePatchPartAssembledMutation: () => ({ mutateAsync: vi.fn() }),
  invalidatePlanReview: (client: QueryClient, profileId: number) =>
    client.invalidateQueries({ queryKey: queryKeys.planReview(profileId, false) }),
}));

vi.mock("../../queries/profiles", () => ({
  invalidateProfiles: (client: QueryClient) =>
    client.invalidateQueries({ queryKey: queryKeys.profiles }),
}));

vi.mock("../../queries/planDraft", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    usePlanDraftListQuery: () => {
      useSyncExternalStore(state.subscribe, state.snapshot, state.snapshot);
      return {
        data: state.workspace ? [state.workspace.draft] : [],
        isLoading: false,
        error: null,
      };
    },
    usePlanDraftWorkspaceQuery: (_p: number | null, draftId: number | null) => {
      useSyncExternalStore(state.subscribe, state.snapshot, state.snapshot);
      return {
        data: draftId != null && draftId === state.workspace?.draft.draft_id
          ? state.workspace
          : undefined,
        isLoading: false,
        error: null,
      };
    },
  };
});

function reviewPart(over: Partial<ReviewPart> & { id: number }): ReviewPart {
  return {
    match_key: `stls/part-${over.id}.stl`,
    relative_path: `STLs/part-${over.id}.stl`,
    filename: `part-${over.id}.stl`,
    source_layer: "base:Voron",
    status: "base",
    role: "primary",
    requirement: null,
    option_group_id: null,
    included: true,
    filament_color_id: null,
    quantity_auto: 1,
    quantity_override: null,
    quantity_effective: 4,
    printed_count: 2,
    print_units: [true, true, false, false],
    missing: true,
    filament_display: "",
    ...over,
  } as ReviewPart;
}

function baseReview(): PlanReview {
  return {
    profile_id: 7,
    accepted_basis: {
      profile_id: 7,
      plan_version: 1,
      plan_revision_id: 1,
      plan_revision_digest: "d".repeat(64),
      required_unit_mapping_digest: "e".repeat(64),
    },
    plan_name: "Voron 2.4 Workshop",
    layers: [],
    totals: { included_parts: 1, total_print_units: 4, by_role: {}, by_filament: {} },
    issues: [],
    has_blockers: false,
    part_groups: [{
      folder: "STLs",
      source_layer: "base:Voron",
      parts: [reviewPart({ id: 1 })],
    }],
  } as PlanReview;
}

function draftPart(draftPartId: number) {
  return {
    draft_part_id: draftPartId,
    base_revision_part_id: 1,
    part_key: "stls/part-1.stl",
    filename: "part-1.stl",
    relative_path: "STLs/part-1.stl",
    source_layer: "base:Voron",
    role: "primary",
    quantity_inferred: 4,
    quantity_override: 6,
    quantity_effective: 6,
    included: true,
  };
}

function unresolvedWorkspace(): PlanDraftWorkspace {
  return {
    profile_id: 7,
    draft: {
      draft_id: 9,
      state: "open",
      lifecycle_version: 0,
      snapshot_digest: "a".repeat(64),
      base: { revision_id: 1, plan_version: 1 },
    },
    parts: [draftPart(11)],
    diff: {
      base_is_current: true,
      added: [],
      removed: [],
      changed: [{
        before: {
          revision_part_id: 1,
          filename: "part-1.stl",
          relative_path: "STLs/part-1.stl",
          source_layer: "base:Voron",
        },
        after: draftPart(11),
        fields: ["quantityOverride", "quantityEffective"],
      }],
    },
    reconciliation: {
      kind: "unresolved",
      conflicts: [
        { kind: "unsafe_predecessor", target_draft_part_id: 11, predecessor_revision_part_id: 1 },
      ],
    },
  };
}

function resolvedWorkspace(): PlanDraftWorkspace {
  return {
    ...unresolvedWorkspace(),
    draft: { ...unresolvedWorkspace().draft, snapshot_digest: "b".repeat(64) },
    reconciliation: { kind: "ready", reused_units: 2, new_units: 4, surplus_units: 0 },
  };
}

function renderPlan() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <PlanWorkspaceProvider>
          <PlanAcceptanceProvider>
            <PlanAcceptanceConfirmation />
            <PlanAcceptedRevisionCard />
            <WorkingPlanReviewCard />
            <PlanIssuesSection />
            <PlanAcceptanceActionCard />
          </PlanAcceptanceProvider>
        </PlanWorkspaceProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.sessionStorage.clear();
  state.review = baseReview();
  state.setWorkspace(unresolvedWorkspace());
  vi.mocked(reconcilePlanDraft).mockReset();
  vi.mocked(applyPlanDraft).mockReset();
});

afterEach(() => {
  cleanup();
});

describe("Plan acceptance checkpoint", () => {
  it("shows the accepted revision and the working change counts", async () => {
    renderPlan();
    expect(await screen.findByText("Plan revision 1 accepted")).toBeTruthy();
    const changes = screen.getByRole("region", { name: "Working Plan changes" });
    expect(changes.textContent).toContain("Changed quantity");
    expect(changes.textContent).toContain("Not accepted yet");
  });

  it("blocks acceptance while a Required-unit decision is open, and says why", async () => {
    renderPlan();
    const accept = await screen.findByRole("button", { name: "Accept Plan revision" });
    expect(accept.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(
      'Acceptance is blocked. Resolve 1 item under "Must resolve" first.',
    )).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Must resolve \(1\)/ })).toBeTruthy();
    // The summary links to the control that fixes the issue.
    const link = screen.getByRole("link", {
      name: "part-1.stl: choose what happens to units already printed",
    });
    expect(link.getAttribute("href")).toBe("#plan-issue-required-unit-11");
  });

  it("accepts the revision and leaves a receipt on the page", async () => {
    const user = userEvent.setup();
    vi.mocked(reconcilePlanDraft).mockImplementation(async () => {
      const next = resolvedWorkspace();
      state.setWorkspace(next);
      return next;
    });
    vi.mocked(applyPlanDraft).mockResolvedValue({
      profile_id: 7,
      draft_id: 9,
      revision_id: 2,
      plan_version: 2,
      draft_lifecycle_version: 1,
      revision_digest: "c".repeat(64),
      required_unit_mapping_digest: "f".repeat(64),
      applied_at: "2026-08-27T10:00:00.000Z",
    });

    renderPlan();
    await user.selectOptions(
      await screen.findByLabelText("part-1.stl: choose what happens to units already printed"),
      "1",
    );
    await user.click(screen.getByRole("button", { name: "Save Required-unit decisions" }));
    await waitFor(() => expect(reconcilePlanDraft).toHaveBeenCalledOnce());

    const accept = await screen.findByRole("button", { name: "Accept Plan revision" });
    await waitFor(() => expect(accept.hasAttribute("disabled")).toBe(false));
    await user.click(accept);

    expect(await screen.findByText("Plan revision 2 accepted")).toBeTruthy();
    expect(screen.getByText(
      "6 Required units are current. 2 verified units were preserved.",
    )).toBeTruthy();
    expect(screen.getByRole("link", { name: "Prepare 4 remaining units" }).getAttribute("href"))
      .toBe("/export?profile=7&select=missing");
    expect(screen.getByRole("link", { name: "View Checkoff" }).getAttribute("href"))
      .toBe("/progress?profile=7");
  });

  it("names the files whose printed work could not move", async () => {
    const user = userEvent.setup();
    state.setWorkspace(resolvedWorkspace());
    const { EngineHttpError } = await import("../../api/engineTransport");
    vi.mocked(applyPlanDraft).mockRejectedValue(new EngineHttpError("unsafe", 422, {
      code: "checkoff_remap_unsafe",
      unmappable: [{ linkId: "l1", filename: "part-1.stl", reason: "printed 6 units, new quantity is 4" }],
    }));

    renderPlan();
    await user.click(await screen.findByRole("button", { name: "Accept Plan revision" }));
    expect(await screen.findByText(/part-1.stl: printed 6 units, new quantity is 4/)).toBeTruthy();
  });
});
