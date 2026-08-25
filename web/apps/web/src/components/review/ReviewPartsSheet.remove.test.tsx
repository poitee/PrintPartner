// @vitest-environment jsdom

/**
 * Plan stage: clicking Remove under "Proposed inclusion" must reach the draft
 * edit API. Drives the real click path through the real PlanWorkspaceProvider —
 * only the engine HTTP layer is mocked.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import {
  editPlanDraftParts,
  type PlanDraftWorkspace,
  type PlanReview,
  type ReviewPart,
} from "../../api/engine";
import { queryKeys } from "../../queries/keys";
import { PlanWorkspaceProvider, usePlanWorkspace } from "../../context/PlanWorkspaceContext";
import {
  REVIEW_PARTS_UI_STORAGE_KEY,
  serializePersistedReviewPartsUi,
  parsePersistedReviewPartsUi,
} from "../../lib/persistedReviewPartsUi";
import ReviewPartsSheet from "./ReviewPartsSheet";

function reviewPart(over: Partial<ReviewPart> & { id: number; match_key: string }): ReviewPart {
  return {
    relative_path: "frame/bracket.stl",
    filename: "bracket.stl",
    source_layer: "base:Voron",
    status: "ok",
    role: "structural",
    requirement: null,
    option_group_id: null,
    included: true,
    filament_color_id: null,
    quantity_auto: 1,
    quantity_override: null,
    quantity_effective: 1,
    printed_count: 0,
    print_units: [false],
    missing: false,
    filament_display: "",
    ...over,
  } as ReviewPart;
}

function draftPart(over: {
  draft_part_id: number;
  base_revision_part_id: number;
  part_key: string;
  filename?: string;
  relative_path?: string;
  source_layer?: string;
}) {
  return {
    draft_part_id: over.draft_part_id,
    base_revision_part_id: over.base_revision_part_id,
    part_key: over.part_key,
    filename: over.filename ?? "bracket.stl",
    relative_path: over.relative_path ?? "frame/bracket.stl",
    source_layer: over.source_layer ?? "base:Voron",
    role: "structural",
    quantity_inferred: 1,
    quantity_override: null,
    quantity_effective: 1,
    included: true,
  };
}

const state = vi.hoisted(() => ({
  review: null as PlanReview | null,
  workspace: null as PlanDraftWorkspace | null,
}));

vi.mock("../../api/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/engine")>();
  return {
    ...actual,
    editPlanDraftParts: vi.fn(),
    recomputePlanDraft: vi.fn(),
    rebasePlanDraft: vi.fn(),
    applyPlanDraft: vi.fn(),
    abandonPlanDraft: vi.fn(),
    reconcilePlanDraft: vi.fn(),
    fetchSpoolmanSpools: vi.fn(async () => []),
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

vi.mock("../../queries/planDraft", () => ({
  usePlanDraftListQuery: () => ({
    data: state.workspace ? [state.workspace.draft] : [],
    isLoading: false,
    error: null,
  }),
  usePlanDraftWorkspaceQuery: (_p: number | null, draftId: number | null) => ({
    data: draftId != null && draftId === state.workspace?.draft.draft_id
      ? state.workspace
      : undefined,
    isLoading: false,
    error: null,
  }),
}));

vi.mock("../../queries/roleFilaments", () => ({
  useRoleFilamentsQuery: () => ({ data: [] }),
}));

vi.mock("../../hooks/useSpoolmanEnabled", () => ({
  useSpoolmanEnabled: () => ({ configured: false, integrationId: null }),
}));

vi.mock("../../hooks/useMediaQuery", () => ({
  useMediaQuery: () => false,
}));

vi.mock("../parts/PartThumbExpandButton", () => ({ default: () => null }));

/** Surfaces the value the Plan page renders as its alert (PartsPage.tsx). */
function DraftErrorProbe() {
  const { draftError } = usePlanWorkspace();
  return <p data-testid="draft-error">{draftError ?? ""}</p>;
}

function renderSheet() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <PlanWorkspaceProvider>
          <ReviewPartsSheet review={state.review!} planName="Voron" />
          <DraftErrorProbe />
        </PlanWorkspaceProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

function baseWorkspace(parts: PlanDraftWorkspace["parts"]): PlanDraftWorkspace {
  return {
    profile_id: 7,
    draft: {
      draft_id: 9,
      state: "open",
      lifecycle_version: 0,
      snapshot_digest: "a".repeat(64),
      base: { revision_id: 3, plan_version: 1 },
    },
    parts,
    diff: { base_is_current: true, added: [], removed: [], changed: [] },
    reconciliation: { kind: "ready", reused_units: 0, new_units: 0, surplus_units: 0 },
  };
}

function baseReview(parts: ReviewPart[]): PlanReview {
  return {
    profile_id: 7,
    accepted_basis: null,
    plan_name: "Voron",
    layers: [],
    totals: {
      included_parts: parts.length,
      total_print_units: parts.length,
      by_role: {},
      by_filament: {},
    },
    issues: [],
    has_blockers: false,
    part_groups: [{ folder: "frame", source_layer: "base:Voron", parts }],
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  localStorage.clear();
  // Table layout is the surface with the "Proposed inclusion" column.
  localStorage.setItem(
    REVIEW_PARTS_UI_STORAGE_KEY,
    serializePersistedReviewPartsUi({
      ...parsePersistedReviewPartsUi(null),
      layoutMode: "table",
    }),
  );
  vi.mocked(editPlanDraftParts).mockImplementation(async () => state.workspace!);
});

describe("Plan: Remove under Proposed inclusion", () => {
  it("sends a set_included edit for a part with a unique part_key", async () => {
    state.review = baseReview([reviewPart({ id: 42, match_key: "frame/bracket.stl" })]);
    state.workspace = baseWorkspace([
      draftPart({ draft_part_id: 17, base_revision_part_id: 42, part_key: "frame/bracket.stl" }),
    ]);

    renderSheet();
    await screen.findByRole("columnheader", { name: "Proposed inclusion" });
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() =>
      expect(editPlanDraftParts).toHaveBeenCalledWith(
        expect.objectContaining({
          decisions: [{ kind: "set_included", draft_part_ids: [17], value: false }],
        }),
      ),
    );
  });

  it("sends a set_included edit when two source layers share one part_key", async () => {
    state.review = baseReview([
      reviewPart({ id: 42, match_key: "frame/bracket.stl", source_layer: "base:Voron" }),
      reviewPart({
        id: 43,
        match_key: "frame/bracket.stl",
        source_layer: "overlay:Mods",
        filename: "bracket.stl",
      }),
    ]);
    state.workspace = baseWorkspace([
      draftPart({ draft_part_id: 17, base_revision_part_id: 42, part_key: "frame/bracket.stl" }),
      draftPart({
        draft_part_id: 18,
        base_revision_part_id: 43,
        part_key: "frame/bracket.stl",
        source_layer: "overlay:Mods",
      }),
    ]);

    renderSheet();
    await screen.findByRole("columnheader", { name: "Proposed inclusion" });
    const removes = screen.getAllByRole("button", { name: "Remove" });
    await userEvent.click(removes[0]!);

    await waitFor(() =>
      expect(editPlanDraftParts).toHaveBeenCalledWith(
        expect.objectContaining({
          decisions: [{ kind: "set_included", draft_part_ids: [17], value: false }],
        }),
      ),
    );
  });

  it("sends a set_included edit for a part the draft added after the base revision", async () => {
    state.review = baseReview([reviewPart({ id: 42, match_key: "frame/bracket.stl" })]);
    state.workspace = baseWorkspace([
      draftPart({ draft_part_id: 17, base_revision_part_id: 42, part_key: "bracket.stl" }),
    ]);

    renderSheet();
    await screen.findByRole("columnheader", { name: "Proposed inclusion" });
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() =>
      expect(editPlanDraftParts).toHaveBeenCalledWith(
        expect.objectContaining({
          decisions: [{ kind: "set_included", draft_part_ids: [17], value: false }],
        }),
      ),
    );
  });

  it("reports a part the draft does not carry instead of failing silently", async () => {
    state.review = baseReview([reviewPart({ id: 42, match_key: "frame/bracket.stl" })]);
    state.workspace = baseWorkspace([
      draftPart({
        draft_part_id: 17,
        base_revision_part_id: 99,
        part_key: "frame/motor.stl",
        filename: "motor.stl",
        relative_path: "frame/motor.stl",
      }),
    ]);

    renderSheet();
    await screen.findByRole("columnheader", { name: "Proposed inclusion" });
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() =>
      expect(screen.getByTestId("draft-error").textContent).toMatch(
        /bracket\.stl is not in the saved draft/,
      ),
    );
    expect(editPlanDraftParts).not.toHaveBeenCalled();
  });

  it("reports duplicates the row identity cannot narrow", async () => {
    state.review = baseReview([reviewPart({ id: 42, match_key: "frame/bracket.stl" })]);
    state.workspace = baseWorkspace([
      draftPart({ draft_part_id: 17, base_revision_part_id: 42, part_key: "frame/bracket.stl" }),
      draftPart({ draft_part_id: 18, base_revision_part_id: 43, part_key: "frame/bracket.stl" }),
    ]);

    renderSheet();
    await screen.findByRole("columnheader", { name: "Proposed inclusion" });
    await userEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]!);

    await waitFor(() =>
      expect(screen.getByTestId("draft-error").textContent).toMatch(
        /2 Parts matching bracket\.stl/,
      ),
    );
    expect(editPlanDraftParts).not.toHaveBeenCalled();
  });
});
