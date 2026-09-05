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
import type { PlanDraftWorkspace } from "@print-partner/contracts";
import { applyPlanDraft, editPlanDraftParts, listPlanDrafts, recomputePlanDraft } from "../../api/endpoints/planDrafts";
import type { PlanReview, ReviewPart } from "../../api/endpoints/planManifests";
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

vi.mock("../../api/endpoints/planDrafts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/endpoints/planDrafts")>();
  return {
    ...actual,
    editPlanDraftParts: vi.fn(),
    recomputePlanDraft: vi.fn(),
    rebasePlanDraft: vi.fn(),
    applyPlanDraft: vi.fn(),
    listPlanDrafts: vi.fn(),
    abandonPlanDraft: vi.fn(),
    reconcilePlanDraft: vi.fn(),
  };
});

vi.mock("../../api/endpoints/filaments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/endpoints/filaments")>();
  return {
    ...actual,
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

function workspaceWithQuantity(
  workspace: PlanDraftWorkspace,
  digestCharacter: string,
  quantity: number,
): PlanDraftWorkspace {
  return {
    ...workspace,
    draft: {
      ...workspace.draft,
      snapshot_digest: digestCharacter.repeat(64),
    },
    parts: workspace.parts.map((part) => ({
      ...part,
      quantity_override: quantity,
      quantity_effective: quantity,
    })),
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  vi.resetAllMocks();
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
  vi.mocked(listPlanDrafts).mockResolvedValue([]);
  vi.mocked(applyPlanDraft).mockImplementation(async (workspace) => ({
    profile_id: workspace.profile_id,
    draft_id: workspace.draft.draft_id,
    revision_id: 4,
    plan_version: 2,
    draft_lifecycle_version: 1,
    revision_digest: "c".repeat(64),
    required_unit_mapping_digest: "d".repeat(64),
    applied_at: "2026-08-21T12:00:00.000Z",
  }));
});

describe("Plan sheet Working Plan edits", () => {
  it("sends a set_included edit for a part with a unique part_key", async () => {
    state.review = baseReview([reviewPart({ id: 42, match_key: "frame/bracket.stl" })]);
    state.workspace = baseWorkspace([
      draftPart({ draft_part_id: 17, base_revision_part_id: 42, part_key: "frame/bracket.stl" }),
    ]);

    renderSheet();
    await screen.findByRole("columnheader", { name: "Actions" });
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
    await screen.findByRole("columnheader", { name: "Actions" });
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
    await screen.findByRole("columnheader", { name: "Actions" });
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() =>
      expect(editPlanDraftParts).toHaveBeenCalledWith(
        expect.objectContaining({
          decisions: [{ kind: "set_included", draft_part_ids: [17], value: false }],
        }),
      ),
    );
  });

  it("offers the Working Plan's Parts, not accepted Parts the draft dropped", async () => {
    // Proposed inclusion projects the draft (workingPlanReviewParts maps over
    // workspace.parts), so an accepted Part the draft no longer carries has no
    // row here at all. It surfaces as a removal in the draft diff instead.
    // This is why every rendered row resolves: its match_key IS a draft
    // part_key. resolveDraftPart's "missing" branch stays as defence for
    // non-UI callers and is covered directly in planDraftPartMatch.test.ts.
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
    await screen.findByRole("columnheader", { name: "Actions" });

    expect(screen.getByText("motor.stl")).toBeTruthy();
    expect(screen.queryByText("bracket.stl")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Remove" }));

    // The one row present is the draft's, so the edit lands rather than erroring.
    await waitFor(() =>
      expect(editPlanDraftParts).toHaveBeenCalledWith(
        expect.objectContaining({
          decisions: [{ kind: "set_included", draft_part_ids: [17], value: false }],
        }),
      ),
    );
    expect(screen.getByTestId("draft-error").textContent).toBe("");
  });

  it("reports duplicates the row identity cannot narrow", async () => {
    state.review = baseReview([reviewPart({ id: 42, match_key: "frame/bracket.stl" })]);
    state.workspace = baseWorkspace([
      draftPart({ draft_part_id: 17, base_revision_part_id: 42, part_key: "frame/bracket.stl" }),
      draftPart({ draft_part_id: 18, base_revision_part_id: 43, part_key: "frame/bracket.stl" }),
    ]);

    renderSheet();
    await screen.findByRole("columnheader", { name: "Actions" });
    await userEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]!);

    await waitFor(() =>
      expect(screen.getByTestId("draft-error").textContent).toMatch(
        /2 Parts matching bracket\.stl/,
      ),
    );
    expect(editPlanDraftParts).not.toHaveBeenCalled();
  });

  it("keeps quantity steps available while the preceding edit is saving", async () => {
    const pending = deferred<PlanDraftWorkspace>();
    state.review = baseReview([
      reviewPart({ id: 42, match_key: "frame/bracket.stl" }),
    ]);
    const initialWorkspace = baseWorkspace([
      draftPart({
        draft_part_id: 17,
        base_revision_part_id: 42,
        part_key: "frame/bracket.stl",
      }),
    ]);
    state.workspace = initialWorkspace;
    const secondWorkspace = workspaceWithQuantity(initialWorkspace, "b", 2);
    const thirdWorkspace = workspaceWithQuantity(initialWorkspace, "c", 3);
    const fourthWorkspace = workspaceWithQuantity(initialWorkspace, "d", 4);
    vi.mocked(recomputePlanDraft)
      .mockResolvedValueOnce({ ...secondWorkspace, draft: { ...secondWorkspace.draft, draft_id: 10 } })
      .mockResolvedValueOnce({ ...thirdWorkspace, draft: { ...thirdWorkspace.draft, draft_id: 11 } });
    vi.mocked(editPlanDraftParts)
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(thirdWorkspace)
      .mockResolvedValueOnce(fourthWorkspace);

    renderSheet();
    await screen.findByRole("columnheader", { name: "Actions" });
    const increase = screen.getByRole("button", {
      name: "Increase quantity for bracket.stl",
    });
    await userEvent.click(increase);
    await waitFor(() => expect(editPlanDraftParts).toHaveBeenCalledTimes(1));

    expect((increase as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(increase);
    await userEvent.click(increase);
    expect(editPlanDraftParts).toHaveBeenCalledTimes(1);

    pending.resolve(secondWorkspace);
    await waitFor(() => expect(editPlanDraftParts).toHaveBeenCalledTimes(3));
    expect(editPlanDraftParts).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        expectedSnapshotDigest: "c".repeat(64),
        decisions: [
          expect.objectContaining({
            kind: "set_quantity_override",
            value: 4,
          }),
        ],
      }),
    );
  });

  it("renders a rejected Plan edit as an alert", async () => {
    state.review = baseReview([
      reviewPart({ id: 42, match_key: "frame/bracket.stl" }),
    ]);
    state.workspace = baseWorkspace([
      draftPart({
        draft_part_id: 17,
        base_revision_part_id: 42,
        part_key: "frame/bracket.stl",
      }),
    ]);
    vi.mocked(editPlanDraftParts).mockRejectedValueOnce(new Error("disk full"));

    renderSheet();
    await screen.findByRole("columnheader", { name: "Actions" });
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() =>
      expect(screen.getByTestId("draft-error").textContent).toBe("disk full"),
    );
  });
});
