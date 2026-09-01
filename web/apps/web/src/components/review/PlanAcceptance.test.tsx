// @vitest-environment jsdom

/**
 * Plan is the publication checkpoint. This drives the real decision path:
 * pending choices, the Required-unit answers that complete them, and the durable
 * receipt that stays on the page afterwards. Only the engine HTTP layer is
 * mocked.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { PlanDraftWorkspace, PlanFreshness } from "@print-partner/contracts";
import {
  applyPlanDraft,
  recomputePlanDraft,
  reconcilePlanDraft,
} from "../../api/endpoints/planDrafts";
import type {
  PlanReview,
  ReviewPart,
} from "../../api/endpoints/planManifests";
import { EngineHttpError } from "../../api/engineTransport";
import { queryKeys } from "../../queries/keys";
import { PlanWorkspaceProvider } from "../../context/PlanWorkspaceContext";
import { PlanAcceptanceProvider } from "./PlanAcceptanceContext";
import PlanAcceptanceActionCard from "./PlanAcceptanceActionCard";
import PlanAcceptanceConfirmation from "./PlanAcceptanceConfirmation";
import PlanAcceptedRevisionCard from "./PlanAcceptedRevisionCard";
import PlanIssuesSection from "./PlanIssuesSection";
import PlanSourceNotice from "./PlanSourceNotice";
import WorkingPlanReviewCard from "../build/WorkingPlanReviewCard";

type PlanTestState = {
  review: PlanReview | null;
  workspace: PlanDraftWorkspace | null;
  freshness: PlanFreshness;
  version: number;
  subscribe(listener: () => void): () => void;
  snapshot(): number;
  setWorkspace(next: PlanDraftWorkspace | null): void;
};

/** A tiny store so the mocked draft query re-renders like the real one. */
const state = vi.hoisted((): PlanTestState => {
  const listeners = new Set<() => void>();
  const freshness: PlanFreshness = {
    status: "current",
    accepted_input_set_id: 1,
    accepted_at: "2026-08-27T10:00:00.000Z",
  };
  return {
    review: null,
    workspace: null,
    freshness,
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
  useProfileSelection: () => ({
    selectedProfileId: 7,
    profiles: [{ id: 7, name: "Voron 2.4 Workshop", freshness: state.freshness }],
  }),
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
            <PlanSourceNotice />
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
  state.freshness = {
    status: "current",
    accepted_input_set_id: 1,
    accepted_at: "2026-08-27T10:00:00.000Z",
  };
  vi.mocked(reconcilePlanDraft).mockReset();
  vi.mocked(recomputePlanDraft).mockReset();
  vi.mocked(applyPlanDraft).mockReset();
});

afterEach(() => {
  cleanup();
});

describe("Plan acceptance checkpoint", () => {
  it("keeps Source updates out of Issues and offers Production first", async () => {
    state.setWorkspace(resolvedWorkspace());
    state.freshness = {
      status: "stale",
      accepted_input_set_id: 1,
      accepted_at: "2026-08-27T10:00:00.000Z",
      reasons: [{ kind: "plan_configuration_changed" }],
      untracked_sources: [],
    };

    renderPlan();

    const notice = await screen.findByRole("region", { name: "Source updates available" });
    expect(notice.textContent).toContain(
      "Production and Checkoff continue using the files from published Plan revision 1.",
    );
    expect(screen.getByRole("link", { name: "Continue to Production" }).getAttribute("href"))
      .toBe("/export?profile=7");
    expect(
      screen.getByRole("link", { name: "Review Sources for the next Plan" }).getAttribute("href"),
    ).toBe("/sources?profile=7");
    expect(screen.queryByRole("heading", { name: "Issues" })).toBeNull();
    expect(
      (await screen.findByRole("button", { name: "Publish Plan revision 2 for Production" }))
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  it("shows the published revision and the working change counts", async () => {
    const user = userEvent.setup();
    renderPlan();
    expect(await screen.findByText("Plan revision 1 published")).toBeTruthy();
    expect(screen.getByText(
      "Production and Checkoff still use this revision until you publish the working changes below.",
    )).toBeTruthy();
    const changes = screen.getByRole("region", { name: "Working Plan changes" });
    expect(changes.textContent).toContain("Changed quantity");
    expect(changes.textContent).toContain("Not published yet");
    const toggle = screen.getByRole("button", { name: "Show 1 part changes" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById("working-plan-change-details")?.className).toContain("print:block");
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "Hide part changes" })).toBeTruthy();
  });

  it("does not claim Production uses a revision that has not been published", async () => {
    state.review = { ...baseReview(), accepted_basis: null };
    renderPlan();
    expect(await screen.findByText("No Plan revision published yet")).toBeTruthy();
    expect(screen.getByText(
      "Publish a Working Plan before Production and Checkoff can start.",
    )).toBeTruthy();
    expect(screen.queryByText(/still use this revision/)).toBeNull();
  });

  it("names the choice needed before publication", async () => {
    renderPlan();
    const publish = await screen.findByRole("button", { name: "Publish Plan for Production" });
    expect(publish.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(
      'Complete 1 choice under "Before publishing" first.',
    )).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Before publishing \(1\)/ })).toBeTruthy();
    // The summary links to the control that fixes the issue.
    const link = screen.getByRole("link", {
      name: "part-1.stl: choose what happens to units already printed",
    });
    expect(link.getAttribute("href")).toBe("#plan-issue-required-unit-11");
  });

  it("builds the first Working Plan from the Plan page", async () => {
    const user = userEvent.setup();
    state.setWorkspace(null);
    vi.mocked(recomputePlanDraft).mockImplementation(async () => {
      const next = resolvedWorkspace();
      state.setWorkspace(next);
      return next;
    });

    renderPlan();
    await user.click(await screen.findByRole("button", {
      name: "Build Working Plan from Sources",
    }));

    await waitFor(() => expect(recomputePlanDraft).toHaveBeenCalledWith(7));
    expect(await screen.findByRole("button", { name: "Show 1 part changes" })).toBeTruthy();
  });

  it("publishes the revision and leaves a receipt on the page", async () => {
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

    const publish = await screen.findByRole("button", { name: "Publish Plan revision 2 for Production" });
    await waitFor(() => expect(publish.hasAttribute("disabled")).toBe(false));
    expect(screen.getByText("Units kept")).toBeTruthy();
    expect(screen.getByText("Must be printed again")).toBeTruthy();
    await user.click(publish);

    expect(await screen.findByText("Plan revision 2 published")).toBeTruthy();
    expect(screen.getByText(
      "6 Required units are current. 2 verified units were preserved.",
    )).toBeTruthy();
    expect(screen.getByRole("link", { name: "Prepare 4 remaining units" }).getAttribute("href"))
      .toBe("/export?profile=7&select=missing");
    expect(screen.getByRole("link", { name: "View Checkoff" }).getAttribute("href"))
      .toBe("/progress?profile=7");
  });

  it("hides publish and empty issue cards when the published revision is current", async () => {
    state.setWorkspace(null);
    renderPlan();
    expect(await screen.findByText("Plan revision 1 published")).toBeTruthy();
    expect(screen.getByText("Production and Checkoff use this revision.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Publish Plan/ })).toBeNull();
    expect(screen.queryByRole("region", { name: "Working Plan changes" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Issues" })).toBeNull();
  });

  it("names the files whose printed work could not move", async () => {
    const user = userEvent.setup();
    state.setWorkspace(resolvedWorkspace());
    vi.mocked(applyPlanDraft).mockRejectedValue(new EngineHttpError("unsafe", 422, {
      code: "checkoff_remap_unsafe",
      unmappable: [{ linkId: "l1", filename: "part-1.stl", reason: "printed 6 units, new quantity is 4" }],
    }));

    renderPlan();
    await user.click(await screen.findByRole("button", { name: "Publish Plan revision 2 for Production" }));
    expect(await screen.findByText(/part-1.stl: printed 6 units, new quantity is 4/)).toBeTruthy();
  });

  it("rebuilds from current Sources instead of retrying an unchanged Working Plan", async () => {
    const user = userEvent.setup();
    const rebuiltWorkspace: PlanDraftWorkspace = {
      ...resolvedWorkspace(),
      draft: {
        ...resolvedWorkspace().draft,
        draft_id: 10,
        snapshot_digest: "c".repeat(64),
      },
    };
    state.setWorkspace(resolvedWorkspace());
    vi.mocked(recomputePlanDraft).mockImplementation(async () => {
      state.setWorkspace(rebuiltWorkspace);
      return rebuiltWorkspace;
    });
    vi.mocked(applyPlanDraft)
      .mockRejectedValueOnce(new EngineHttpError("Sources changed", 409, {
        code: "inputs_changed",
      }))
      .mockResolvedValueOnce({
        profile_id: 7,
        draft_id: 10,
        revision_id: 2,
        plan_version: 2,
        draft_lifecycle_version: 1,
        revision_digest: "d".repeat(64),
        required_unit_mapping_digest: "e".repeat(64),
        applied_at: "2026-09-01T00:00:00.000Z",
      });

    renderPlan();
    await user.click(await screen.findByRole("button", {
      name: "Publish Plan revision 2 for Production",
    }));

    expect(await screen.findByText("Working Plan rebuilt from Sources")).toBeTruthy();
    expect(screen.getByText(/Sources changed after this Working Plan was created/)).toBeTruthy();
    expect(recomputePlanDraft).toHaveBeenCalledWith(7);
    expect(screen.queryByText(/choice before publishing/)).toBeNull();

    await user.click(screen.getByRole("button", {
      name: "Publish Plan revision 2 for Production",
    }));

    await waitFor(() => expect(applyPlanDraft).toHaveBeenCalledTimes(2));
    expect(applyPlanDraft).toHaveBeenLastCalledWith(rebuiltWorkspace, undefined);
    expect(await screen.findByText("Plan revision 2 published")).toBeTruthy();
  });

  it("retries a linked-record publication with the same move option", async () => {
    const user = userEvent.setup();
    state.setWorkspace(resolvedWorkspace());
    vi.mocked(applyPlanDraft)
      .mockRejectedValueOnce(new EngineHttpError("locked", 423, {
        code: "production_active",
        checkoff_link_count: 2,
        send_queue_item_count: 0,
      }))
      .mockRejectedValueOnce(new Error("engine offline"));

    renderPlan();
    await user.click(await screen.findByRole("button", { name: "Publish Plan revision 2 for Production" }));
    await user.click(await screen.findByRole("button", { name: "Move records and publish" }));
    expect(applyPlanDraft).toHaveBeenLastCalledWith(
      expect.anything(),
      { remapCheckoffLinks: true },
    );

    await user.click(await screen.findByRole("button", { name: "Retry publishing" }));
    expect(applyPlanDraft).toHaveBeenLastCalledWith(
      expect.anything(),
      { remapCheckoffLinks: true },
    );
    expect(applyPlanDraft).toHaveBeenCalledTimes(3);
  });
});
