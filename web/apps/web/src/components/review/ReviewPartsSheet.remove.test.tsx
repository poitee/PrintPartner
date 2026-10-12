// @vitest-environment jsdom

/**
 * Plan stage: clicking Remove under "Proposed inclusion" saves a stable file
 * target. Drives the real click path through the real PlanWorkspaceProvider.
 * only the engine HTTP layer is mocked.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { PlanDraftWorkspace } from "@print-partner/contracts";
import { applyPlanDraft, editPlanDraftParts, listPlanDrafts, recomputePlanDraft, savePlanChoices, type SavePlanChoicesResponse } from "../../api/endpoints/planDrafts";
import { EngineHttpError } from "../../api/engineTransport";
import type { PlanReview, ReviewPart } from "../../api/endpoints/planManifests";
import { queryKeys } from "../../queries/keys";
import { PlanWorkspaceProvider, usePlanWorkspace } from "../../context/PlanWorkspaceContext";
import {
  REVIEW_PARTS_UI_STORAGE_KEY,
  serializePersistedReviewPartsUi,
  parsePersistedReviewPartsUi,
} from "../../lib/persistedReviewPartsUi";
import ReviewPartsSheet from "./ReviewPartsSheet";
import PartsPage from "../../pages/PartsPage";

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
  selectedProfileId: 7,
  reviewLoading: false,
  draftLoading: false,
}));

vi.mock("../../api/endpoints/planDrafts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/endpoints/planDrafts")>();
  return {
    ...actual,
    editPlanDraftParts: vi.fn(),
    savePlanChoices: vi.fn(),
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
  useProfileSelection: () => ({
    selectedProfileId: state.selectedProfileId,
    profiles: [
      { id: 7, name: "Build A", freshness: { status: "current" } },
      { id: 8, name: "Build B", freshness: { status: "current" } },
    ],
  }),
}));

vi.mock("../../queries/planReview", () => ({
  usePlanReviewQuery: () => ({ data: state.review, isLoading: state.reviewLoading, error: null }),
  usePatchPartMutation: () => ({ mutateAsync: vi.fn() }),
  usePatchPartProgressMutation: () => ({ mutateAsync: vi.fn() }),
  usePatchPartAssembledMutation: () => ({ mutateAsync: vi.fn() }),
  invalidatePlanReview: (client: QueryClient, profileId: number) =>
    client.invalidateQueries({ queryKey: queryKeys.planReview(profileId, false) }),
}));

vi.mock("../../queries/profiles", () => ({
  refreshProfileSummary: (client: QueryClient) =>
    client.invalidateQueries({ queryKey: queryKeys.profiles }),
  invalidateProfiles: (client: QueryClient) =>
    client.invalidateQueries({ queryKey: queryKeys.profiles }),
}));

vi.mock("../../queries/planDraft", () => ({
  usePlanDraftListQuery: () => ({
    data: state.workspace ? [state.workspace.draft] : [],
    isLoading: state.draftLoading,
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
vi.mock("../../queries/planLayers", () => ({
  usePlanLayersQuery: () => ({ data: [{ id: 1, project_id: 1, project_name: "source" }], isLoading: false }),
}));
vi.mock("../../api/endpoints/stlNaming", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/endpoints/stlNaming")>();
  return { ...actual, fetchStlNaming: vi.fn(async () => ({ folder_rules: [] })) };
});
vi.mock("../KitManifestOptions", () => ({ default: () => null }));
vi.mock("../build/PlanRolesCard", () => ({ default: () => null }));
vi.mock("./PlanFileSelection", () => ({ default: () => null }));
vi.mock("./PlanProgressChoices", () => ({ default: () => null }));
vi.mock("./PendingPlanFiles", () => ({ default: () => null }));
vi.mock("../share/ShareBuildExportDialog", () => ({ default: () => null }));

/** Surfaces the value the Plan page renders as its alert (PartsPage.tsx). */
function DraftErrorProbe() {
  const { draftError } = usePlanWorkspace();
  return <p data-testid="draft-error">{draftError ?? ""}</p>;
}

function acceptedPlan(parts: ReviewPart[]): PlanReview {
  return {
    ...baseReview(parts),
    accepted_basis: {
      profile_id: 7,
      plan_version: 1,
      plan_revision_id: 3,
      plan_revision_digest: "c".repeat(64),
      required_unit_mapping_digest: "d".repeat(64),
    },
  };
}

function renderPlan() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Harness() {
    return (
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <PlanWorkspaceProvider>
            <PartsPage />
          </PlanWorkspaceProvider>
        </QueryClientProvider>
      </MemoryRouter>
    );
  }
  const view = render(<Harness />);
  return { ...view, rerender: () => view.rerender(<Harness />) };
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

function saveResponse(workspace: PlanDraftWorkspace): SavePlanChoicesResponse {
  const quantity = workspace.parts[0]?.quantity_effective ?? 1;
  const version = Math.max(2, quantity);
  return {
    receipt: { profile_id: 7, draft_id: workspace.draft.draft_id, revision_id: version + 2, plan_version: version,
      draft_lifecycle_version: 1, revision_digest: "c".repeat(64), required_unit_mapping_digest: "d".repeat(64), applied_at: "2026-08-21T12:00:00.000Z" },
    review: { ...baseReview(workspace.parts.map((part) => reviewPart({
      id: part.draft_part_id + 100, match_key: part.part_key, relative_path: part.relative_path,
      filename: part.filename, source_layer: part.source_layer, included: part.included,
      quantity_override: part.quantity_override, quantity_effective: part.quantity_effective,
    }))), accepted_basis: { profile_id: 7, plan_version: version, plan_revision_id: version + 2,
      plan_revision_digest: "c".repeat(64), required_unit_mapping_digest: "d".repeat(64) } },
    profile: { id: 7, name: "Voron", order_number: null, special_request: null, part_count: workspace.parts.length,
      accepted_progress: { kind: "empty" }, build_stale: false,
      freshness: { status: "current", accepted_input_set_id: 1, accepted_at: "2026-08-21T12:00:00.000Z" },
      archived_at: null, last_used_at: null },
    closed_draft_ids: [workspace.draft.draft_id],
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
  state.selectedProfileId = 7;
  state.reviewLoading = false;
  state.draftLoading = false;
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
  vi.mocked(savePlanChoices).mockImplementation(async () => saveResponse(state.workspace!));
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
  it.each(["grid", "table"] as const)("saves a typed %s quantity through the Plan workspace once on Enter", async (layoutMode) => {
    localStorage.setItem(REVIEW_PARTS_UI_STORAGE_KEY, serializePersistedReviewPartsUi({
      ...parsePersistedReviewPartsUi(null), layoutMode,
    }));
    state.review = baseReview([reviewPart({ id: 42, match_key: "frame/bracket.stl" })]);
    state.workspace = baseWorkspace([
      draftPart({ draft_part_id: 17, base_revision_part_id: 42, part_key: "frame/bracket.stl" }),
    ]);
    vi.mocked(savePlanChoices).mockResolvedValue(saveResponse(workspaceWithQuantity(state.workspace, "b", 25)));
    renderSheet();
    const input = await screen.findByRole("spinbutton", { name: "Quantity for bracket.stl" });
    await userEvent.clear(input);
    await userEvent.type(input, "25");
    expect(savePlanChoices).not.toHaveBeenCalled();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(savePlanChoices).toHaveBeenCalledTimes(1));
    expect(savePlanChoices).toHaveBeenCalledWith(7,
      expect.objectContaining({ decisions: [{ kind: "set_quantity_override", target: {
        part_key: "frame/bracket.stl", relative_path: "frame/bracket.stl", source_layer: "base:Voron",
      }, value: 25 }] }), expect.any(String));
  });

  it("sends a set_included edit for a part with a unique part_key", async () => {
    state.review = baseReview([reviewPart({ id: 42, match_key: "frame/bracket.stl" })]);
    state.workspace = baseWorkspace([
      draftPart({ draft_part_id: 17, base_revision_part_id: 42, part_key: "frame/bracket.stl" }),
    ]);

    renderSheet();
    await screen.findByRole("columnheader", { name: "Actions" });
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() =>
      expect(savePlanChoices).toHaveBeenCalledWith(7,
        expect.objectContaining({ decisions: [{ kind: "set_included", target: {
          part_key: "frame/bracket.stl", relative_path: "frame/bracket.stl", source_layer: "base:Voron",
        }, value: false }] }), expect.any(String)),
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
      expect(savePlanChoices).toHaveBeenCalledWith(7,
        expect.objectContaining({ decisions: [{ kind: "set_included", target: {
          part_key: "frame/bracket.stl", relative_path: "frame/bracket.stl", source_layer: "base:Voron",
        }, value: false }] }), expect.any(String)),
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
      expect(savePlanChoices).toHaveBeenCalledWith(7,
        expect.objectContaining({ decisions: [{ kind: "set_included", target: {
          part_key: "bracket.stl", relative_path: "frame/bracket.stl", source_layer: "base:Voron",
        }, value: false }] }), expect.any(String)),
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
      expect(savePlanChoices).toHaveBeenCalledWith(7,
        expect.objectContaining({ decisions: [{ kind: "set_included", target: {
          part_key: "frame/motor.stl", relative_path: "frame/motor.stl", source_layer: "base:Voron",
        }, value: false }] }), expect.any(String)),
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
    expect(savePlanChoices).not.toHaveBeenCalled();
  });

  it("keeps quantity steps available while the preceding edit is saving", async () => {
    const pending = deferred<SavePlanChoicesResponse>();
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
    vi.mocked(savePlanChoices)
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(saveResponse(thirdWorkspace))
      .mockResolvedValueOnce(saveResponse(fourthWorkspace));

    renderSheet();
    await screen.findByRole("columnheader", { name: "Actions" });
    const increase = screen.getByRole("button", {
      name: "Increase quantity for bracket.stl",
    });
    await userEvent.click(increase);
    await waitFor(() => expect(savePlanChoices).toHaveBeenCalledTimes(1));

    expect((increase as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(increase);
    await userEvent.click(increase);
    expect(savePlanChoices).toHaveBeenCalledTimes(1);

    pending.resolve(saveResponse(secondWorkspace));
    await waitFor(() => expect(savePlanChoices).toHaveBeenCalledTimes(3));
    expect(savePlanChoices).toHaveBeenNthCalledWith(
      3, 7,
      expect.objectContaining({
        expected_base: { revision_id: 5, plan_version: 3 },
        decisions: [
          expect.objectContaining({
            kind: "set_quantity_override",
            value: 4,
          }),
        ],
      }), expect.any(String),
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
    vi.mocked(savePlanChoices).mockRejectedValueOnce(new EngineHttpError("disk full", 422));

    renderSheet();
    await screen.findByRole("columnheader", { name: "Actions" });
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() =>
      expect(screen.getByTestId("draft-error").textContent).toBe("disk full"),
    );
  });

  it("queues three increase clicks from the Plan page while the first save is in flight", async () => {
    const part = draftPart({ draft_part_id: 17, base_revision_part_id: 42, part_key: "frame/bracket.stl" });
    const initial = baseWorkspace([part]);
    state.review = acceptedPlan([reviewPart({ id: 42, match_key: "frame/bracket.stl" })]);
    state.workspace = null;
    const pending = [deferred<SavePlanChoicesResponse>(), deferred<SavePlanChoicesResponse>(), deferred<SavePlanChoicesResponse>()];
    vi.mocked(savePlanChoices)
      .mockReturnValueOnce(pending[0].promise)
      .mockReturnValueOnce(pending[1].promise)
      .mockReturnValueOnce(pending[2].promise);
    const user = userEvent.setup({ delay: null });
    renderPlan();
    const increase = await screen.findByRole("button", { name: "Increase quantity for bracket.stl" });
    await user.click(increase);
    expect((screen.getByRole("button", { name: "Remove" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Change color for bracket.stl" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Share Build" }) as HTMLButtonElement).disabled).toBe(true);
    expect((increase as HTMLButtonElement).disabled).toBe(false);
    await user.click(increase);
    await user.click(increase);
    await waitFor(() => expect(savePlanChoices).toHaveBeenCalledTimes(1));
    expect(vi.mocked(savePlanChoices).mock.calls[0]?.[0]).toBe(7);
    expect(vi.mocked(savePlanChoices).mock.calls[0]?.[1].decisions[0]?.value).toBe(2);
    pending[0].resolve(saveResponse(workspaceWithQuantity(initial, "b", 2)));
    await waitFor(() => expect(savePlanChoices).toHaveBeenCalledTimes(2));
    expect(vi.mocked(savePlanChoices).mock.calls[1]?.[1].decisions[0]?.value).toBe(3);
    pending[1].resolve(saveResponse(workspaceWithQuantity(initial, "c", 3)));
    await waitFor(() => expect(savePlanChoices).toHaveBeenCalledTimes(3));
    expect(vi.mocked(savePlanChoices).mock.calls[2]?.[1].decisions[0]?.value).toBe(4);
    pending[2].resolve(saveResponse(workspaceWithQuantity(initial, "d", 4)));
  });

  it.each([
    ["a plan reload", "reviewLoading"],
    ["a draft load", "draftLoading"],
  ] as const)("blocks another quantity change when saving overlaps %s", async (_label, flag) => {
    state.review = acceptedPlan([reviewPart({ id: 42, match_key: "frame/bracket.stl" })]);
    state.workspace = null;
    const pending = deferred<SavePlanChoicesResponse>();
    vi.mocked(savePlanChoices).mockReturnValueOnce(pending.promise);
    const user = userEvent.setup({ delay: null });
    const view = renderPlan();
    await user.click(await screen.findByRole("button", { name: "Increase quantity for bracket.stl" }));
    await waitFor(() => expect(savePlanChoices).toHaveBeenCalledTimes(1));
    state[flag] = true;
    view.rerender();
    expect((screen.getByRole("button", { name: "Increase quantity for bracket.stl" }) as HTMLButtonElement).disabled).toBe(true);
    expect(savePlanChoices).toHaveBeenCalledTimes(1);
    expect(vi.mocked(savePlanChoices).mock.calls[0]?.[1].decisions[0]?.value).toBe(2);
    pending.resolve(saveResponse(workspaceWithQuantity(baseWorkspace([
      draftPart({ draft_part_id: 17, base_revision_part_id: 42, part_key: "frame/bracket.stl" }),
    ]), "b", 2)));
    await waitFor(() => expect((screen.getByRole("button", { name: "Increase quantity for bracket.stl" }) as HTMLButtonElement).disabled).toBe(true));
    expect(savePlanChoices).toHaveBeenCalledTimes(1);
  });

  it("sends a Build B quantity click while Build A's save is still in flight", async () => {
    const part = draftPart({ draft_part_id: 17, base_revision_part_id: 42, part_key: "frame/bracket.stl" });
    const initial = baseWorkspace([part]);
    state.review = acceptedPlan([reviewPart({ id: 42, match_key: "frame/bracket.stl" })]);
    state.workspace = null;
    const pending = deferred<SavePlanChoicesResponse>();
    vi.mocked(savePlanChoices)
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(saveResponse(workspaceWithQuantity(initial, "b", 2)));
    const user = userEvent.setup({ delay: null });
    const view = renderPlan();
    await user.click(await screen.findByRole("button", { name: "Increase quantity for bracket.stl" }));
    await waitFor(() => expect(savePlanChoices).toHaveBeenCalledTimes(1));
    state.selectedProfileId = 8;
    view.rerender();
    const increase = screen.getByRole("button", { name: "Increase quantity for bracket.stl" });
    expect((increase as HTMLButtonElement).disabled).toBe(false);
    await user.click(increase);
    await waitFor(() => expect(savePlanChoices).toHaveBeenCalledTimes(2));
    expect(vi.mocked(savePlanChoices).mock.calls[0]?.[0]).toBe(7);
    expect(vi.mocked(savePlanChoices).mock.calls[0]?.[1].decisions[0]?.value).toBe(2);
    expect(vi.mocked(savePlanChoices).mock.calls[1]?.[0]).toBe(8);
    expect(vi.mocked(savePlanChoices).mock.calls[1]?.[1].decisions[0]?.value).toBe(2);
    pending.resolve(saveResponse(workspaceWithQuantity(initial, "c", 2)));
  });

});
