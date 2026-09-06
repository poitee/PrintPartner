// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PlanDraftWorkspace } from "@print-partner/contracts";
import type { PlanReview, ReviewPart } from "../api/endpoints/planManifests";
import { fetchPlanReview } from "../api/endpoints/planManifests";
import { applyPlanDraft, editPlanDraftParts, fetchPlanDraftWorkspace, listPlanDrafts, recomputePlanDraft } from "../api/endpoints/planDrafts";
import PlanFileSelection from "../components/review/PlanFileSelection";
import { PlanWorkspaceProvider, usePlanWorkspace } from "./PlanWorkspaceContext";
import { queryKeys } from "../queries/keys";

const selection = vi.hoisted(() => ({ profileId: 7 }));
vi.mock("./ProfileContext", () => ({ useProfileSelection: () => ({ selectedProfileId: selection.profileId }) }));
vi.mock("../hooks/useEngineHealth", () => ({ useEngineHealth: () => ({ health: { ok: true } }) }));
vi.mock("../queries/planLayers", () => ({ usePlanLayersQuery: () => ({ data: [
  { id: 1, project_id: 4, project_name: "Voron", layer_type: "base" },
] }) }));
vi.mock("../api/endpoints/planManifests", () => ({ fetchPlanReview: vi.fn() }));
vi.mock("../api/endpoints/planDrafts", () => ({
  applyPlanDraft: vi.fn(), editPlanDraftParts: vi.fn(), fetchPlanDraftWorkspace: vi.fn(),
  listPlanDrafts: vi.fn(), recomputePlanDraft: vi.fn(), abandonPlanDraft: vi.fn(),
  reconcilePlanDraft: vi.fn(), rebasePlanDraft: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const part: ReviewPart = {
  id: 42, match_key: "bracket.stl", relative_path: "frame/bracket.stl", filename: "bracket.stl",
  source_layer: "base:Voron", status: "ok", role: "primary", requirement: null, option_group_id: null,
  included: true, filament_color_id: null, quantity_auto: 1, quantity_override: null, quantity_effective: 1,
  printed_count: 0, print_units: [false], missing: true, filament_display: "Unset",
};
function review(included: boolean, profileId = 7): PlanReview {
  return {
    profile_id: profileId, accepted_basis: null, plan_name: "Test", layers: [],
    totals: { included_parts: Number(included), total_print_units: Number(included), by_role: {}, by_filament: {} },
    issues: [], has_blockers: false,
    part_groups: [{ source_layer: "base:Voron", folder: "frame", parts: [{ ...part, included }] }],
  };
}
function workspace(included: boolean, draftId = 9, profileId = 7): PlanDraftWorkspace {
  return {
    profile_id: profileId,
    draft: { draft_id: draftId, state: "open", lifecycle_version: 0, snapshot_digest: "a".repeat(64), base: { revision_id: 3, plan_version: 1 } },
    parts: [{ draft_part_id: 17, base_revision_part_id: 42, part_key: part.match_key, filename: part.filename,
      relative_path: part.relative_path, source_layer: "base:Voron", role: "primary",
      quantity_inferred: 1, quantity_override: null, quantity_effective: 1, included }],
    diff: { base_is_current: true, added: [], removed: [], changed: [] },
    reconciliation: { kind: "ready", reused_units: 0, new_units: 0, surplus_units: 0 },
  };
}
function Picker() {
  const plan = usePlanWorkspace();
  return <>
    <span role="status">{plan.saving ? "Saving" : plan.draftError ? "Not saved" : "Saved"}</span>
    <span data-testid="active-draft">{plan.draftWorkspace?.draft.draft_id ?? "none"}</span>
    {plan.draftError && <p role="alert">{plan.draftError}</p>}
    <button onClick={() => void plan.preparePlan().catch(() => {})}>Retry save</button>
    <button onClick={() => void plan.setQuantity(part, 2).catch(() => {})}>Set quantity</button>
    <PlanFileSelection profileId={selection.profileId} disabled={false} />
  </>;
}
let client: QueryClient;
function mount() {
  return render(<QueryClientProvider client={client}><PlanWorkspaceProvider><Picker /></PlanWorkspaceProvider></QueryClientProvider>);
}
const checkbox = () => screen.getByRole("checkbox", { name: "Include bracket.stl" });
const checked = () => checkbox().getAttribute("aria-checked");
beforeEach(() => {
  vi.resetAllMocks();
  selection.profileId = 7;
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  vi.mocked(fetchPlanReview).mockImplementation(async (id) => review(true, id));
  vi.mocked(listPlanDrafts).mockResolvedValue([]);
  vi.mocked(recomputePlanDraft).mockImplementation(async (id) => workspace(true, 9, id));
  vi.mocked(fetchPlanDraftWorkspace).mockImplementation(async (id, draftId) => workspace(true, draftId, id));
  vi.mocked(editPlanDraftParts).mockImplementation(async (input) => {
    const decision = input.decisions[0];
    return workspace(decision?.kind === "set_included" ? decision.value : true, input.draftId, input.profileId);
  });
  vi.mocked(applyPlanDraft).mockImplementation(async (w) => ({
    profile_id: w.profile_id, draft_id: w.draft.draft_id, revision_id: 4, plan_version: 2,
    draft_lifecycle_version: 1, revision_digest: "c".repeat(64), required_unit_mapping_digest: "d".repeat(64), applied_at: "2026-09-06T00:00:00Z",
  }));
});
afterEach(() => { cleanup(); client.clear(); });

it("keeps a clicked selection through draft creation, edit, apply and delayed review refresh", async () => {
  const creation = deferred<PlanDraftWorkspace>();
  const edit = deferred<PlanDraftWorkspace>();
  const apply = deferred<Awaited<ReturnType<typeof applyPlanDraft>>>();
  const refresh = deferred<PlanReview>();
  vi.mocked(recomputePlanDraft).mockReturnValueOnce(creation.promise);
  vi.mocked(editPlanDraftParts).mockReturnValueOnce(edit.promise);
  vi.mocked(applyPlanDraft).mockReturnValueOnce(apply.promise);
  mount();
  await waitFor(() => expect(checked()).toBe("true"));
  fireEvent.click(checkbox());
  expect(checked()).toBe("false");
  await waitFor(() => expect(recomputePlanDraft).toHaveBeenCalledOnce());
  vi.mocked(fetchPlanReview).mockReturnValue(refresh.promise);
  await act(async () => { creation.resolve(workspace(true)); });
  await waitFor(() => expect(editPlanDraftParts).toHaveBeenCalledOnce());
  expect(checked()).toBe("false");
  await act(async () => { edit.resolve(workspace(false)); });
  await waitFor(() => expect(applyPlanDraft).toHaveBeenCalledOnce());
  expect(checked()).toBe("false");
  await act(async () => { apply.resolve({ profile_id: 7, draft_id: 9, revision_id: 4, plan_version: 2,
    draft_lifecycle_version: 1, revision_digest: "c".repeat(64), required_unit_mapping_digest: "d".repeat(64), applied_at: "2026-09-06T00:00:00Z" }); });
  await waitFor(() => expect(fetchPlanReview).toHaveBeenCalledTimes(4));
  expect(checked()).toBe("false");
  expect(screen.getByRole("status").textContent).toBe("Saving");
  await act(async () => { refresh.resolve(review(false)); });
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Saved"));
  expect(checked()).toBe("false");
});

it("coalesces rapid choices and never lets an older save replace the latest click", async () => {
  const firstEdit = deferred<PlanDraftWorkspace>();
  vi.mocked(editPlanDraftParts).mockReturnValueOnce(firstEdit.promise);
  let saved = true;
  let nextDraft = 9;
  vi.mocked(fetchPlanReview).mockImplementation(async (id) => review(saved, id));
  vi.mocked(recomputePlanDraft).mockImplementation(async (id) => workspace(saved, nextDraft++, id));
  vi.mocked(applyPlanDraft).mockImplementation(async (w) => {
    saved = w.parts[0]?.included ?? true;
    return { profile_id: 7, draft_id: w.draft.draft_id, revision_id: nextDraft,
      plan_version: nextDraft, draft_lifecycle_version: 1, revision_digest: "c".repeat(64),
      required_unit_mapping_digest: "d".repeat(64), applied_at: "2026-09-06T00:00:00Z" };
  });
  const page = mount();
  await waitFor(() => expect(checked()).toBe("true"));
  fireEvent.click(checkbox());
  await waitFor(() => expect(editPlanDraftParts).toHaveBeenCalledOnce());
  fireEvent.click(checkbox());
  fireEvent.click(checkbox());
  fireEvent.click(checkbox());
  expect(checked()).toBe("true");
  expect(checkbox().hasAttribute("disabled")).toBe(false);
  await act(async () => { firstEdit.resolve(workspace(false)); });
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Saved"));
  expect(checked()).toBe("true");
  expect(saved).toBe(true);
  expect(editPlanDraftParts).toHaveBeenCalledTimes(2);
  expect(applyPlanDraft).toHaveBeenCalledTimes(2);
  page.unmount();
  client.clear();
  mount();
  await waitFor(() => expect(checked()).toBe("true"));
});

it("does not save again when rapid clicks end at the choice already being saved", async () => {
  const edit = deferred<PlanDraftWorkspace>();
  vi.mocked(editPlanDraftParts).mockReturnValueOnce(edit.promise);
  mount();
  await waitFor(() => expect(checked()).toBe("true"));
  fireEvent.click(checkbox());
  await waitFor(() => expect(editPlanDraftParts).toHaveBeenCalledOnce());
  fireEvent.click(checkbox());
  fireEvent.click(checkbox());
  expect(checked()).toBe("false");
  vi.mocked(fetchPlanReview).mockResolvedValue(review(false));
  await act(async () => { edit.resolve(workspace(false)); });
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Saved"));
  expect(editPlanDraftParts).toHaveBeenCalledOnce();
  expect(applyPlanDraft).toHaveBeenCalledOnce();
  expect(checked()).toBe("false");
});

it.each(["create", "edit", "apply", "refresh"])("retains and retries a choice when %s fails", async (phase) => {
  mount();
  await waitFor(() => expect(checked()).toBe("true"));
  if (phase === "create") vi.mocked(recomputePlanDraft).mockRejectedValueOnce(new Error("disk full"));
  if (phase === "edit") vi.mocked(editPlanDraftParts).mockRejectedValueOnce(new Error("disk full"));
  if (phase === "apply") vi.mocked(applyPlanDraft).mockRejectedValueOnce(new Error("disk full"));
  if (phase === "refresh") vi.mocked(fetchPlanReview).mockRejectedValue(new Error("offline"));
  fireEvent.click(checkbox());
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Not saved"));
  if (phase === "refresh") expect(screen.getByTestId("active-draft").textContent).toBe("none");
  expect(checked()).toBe("false");
  expect(screen.getAllByRole("alert").map((alert) => alert.textContent).join(" ")).toMatch(/disk full|offline/);
  vi.mocked(recomputePlanDraft).mockResolvedValue(workspace(true, 10));
  vi.mocked(fetchPlanReview).mockResolvedValue(review(false));
  fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Saved"));
  expect(checked()).toBe("false");
});

it("keeps a pending choice in its Build when the user switches Builds", async () => {
  const firstEdit = deferred<PlanDraftWorkspace>();
  vi.mocked(editPlanDraftParts).mockReturnValueOnce(firstEdit.promise);
  const page = mount();
  await waitFor(() => expect(checked()).toBe("true"));
  fireEvent.click(checkbox());
  await waitFor(() => expect(editPlanDraftParts).toHaveBeenCalledOnce());
  selection.profileId = 8;
  page.rerender(<QueryClientProvider client={client}><PlanWorkspaceProvider><Picker /></PlanWorkspaceProvider></QueryClientProvider>);
  await waitFor(() => expect(checked()).toBe("true"));
  expect(screen.getByRole("status").textContent).toBe("Saved");
  vi.mocked(fetchPlanReview).mockImplementation(async (id) => review(id !== 7, id));
  await act(async () => { firstEdit.resolve(workspace(false)); });
  await waitFor(() => expect(applyPlanDraft).toHaveBeenCalledOnce());
  expect(checked()).toBe("true");
  selection.profileId = 7;
  page.rerender(<QueryClientProvider client={client}><PlanWorkspaceProvider><Picker /></PlanWorkspaceProvider></QueryClientProvider>);
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Saved"));
  expect(checked()).toBe("false");
});

it("does not label a failed selection Saved when a different edit succeeds", async () => {
  vi.mocked(editPlanDraftParts).mockRejectedValueOnce(new Error("disk full"));
  mount();
  await waitFor(() => expect(checked()).toBe("true"));
  fireEvent.click(checkbox());
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Not saved"));
  fireEvent.click(screen.getByRole("button", { name: "Set quantity" }));
  await waitFor(() => expect(applyPlanDraft).toHaveBeenCalledOnce());
  await waitFor(() => expect(screen.getByRole("status").textContent).not.toBe("Saving"));
  expect(screen.getByRole("status").textContent).toBe("Not saved");
  expect(checked()).toBe("false");
});

it("batches different files with their individual final choices", async () => {
  const second: ReviewPart = { ...part, id: 43, match_key: "cover.stl", relative_path: "frame/cover.stl", filename: "cover.stl" };
  let savedParts = [part, second];
  let draftId = 9;
  const firstEdit = deferred<PlanDraftWorkspace>();
  const makeWorkspace = (): PlanDraftWorkspace => {
    const w = workspace(true, draftId++);
    return { ...w, parts: savedParts.map((row, index) => ({
      draft_part_id: 17 + index, base_revision_part_id: row.id, part_key: row.match_key,
      relative_path: row.relative_path, source_layer: "base:Voron", filename: row.filename,
      role: "primary", quantity_inferred: 1, quantity_override: null, quantity_effective: 1, included: row.included,
    })) };
  };
  vi.mocked(fetchPlanReview).mockImplementation(async () => ({ ...review(true), part_groups: [
    { source_layer: "base:Voron", folder: "frame", parts: savedParts },
  ] }));
  vi.mocked(recomputePlanDraft).mockImplementation(async () => makeWorkspace());
  vi.mocked(editPlanDraftParts).mockReturnValueOnce(firstEdit.promise).mockImplementation(async ({ decisions, draftId: id }) => {
    const w = makeWorkspace();
    return { ...w, draft: { ...w.draft, draft_id: id }, parts: w.parts.map((row) => {
      const decision = decisions.find((choice) => choice.kind === "set_included" && choice.draft_part_ids.includes(row.draft_part_id));
      return { ...row, included: decision?.kind === "set_included" ? decision.value : row.included };
    }) };
  });
  vi.mocked(applyPlanDraft).mockImplementation(async (w) => {
    savedParts = savedParts.map((row) => ({ ...row, included: w.parts.find((p) => p.part_key === row.match_key)?.included ?? row.included }));
    return { profile_id: 7, draft_id: w.draft.draft_id, revision_id: draftId, plan_version: draftId,
      draft_lifecycle_version: 1, revision_digest: "c".repeat(64), required_unit_mapping_digest: "d".repeat(64), applied_at: "2026-09-06T00:00:00Z" };
  });
  mount();
  await waitFor(() => expect(checked()).toBe("true"));
  fireEvent.click(checkbox());
  await waitFor(() => expect(editPlanDraftParts).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("checkbox", { name: "Include cover.stl" }));
  fireEvent.click(checkbox());
  const first = makeWorkspace();
  await act(async () => { firstEdit.resolve({ ...first, draft: { ...first.draft, draft_id: 9 }, parts: first.parts.map((row) => ({ ...row, included: row.part_key !== part.match_key })) }); });
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Saved"));
  expect(checked()).toBe("true");
  expect(screen.getByRole("checkbox", { name: "Include cover.stl" }).getAttribute("aria-checked")).toBe("false");
  expect(savedParts.map((row) => row.included)).toEqual([true, false]);
  expect(editPlanDraftParts).toHaveBeenCalledTimes(2);
  expect(vi.mocked(editPlanDraftParts).mock.calls[1]?.[0].decisions).toEqual([
    { kind: "set_included", draft_part_ids: [17], value: true },
    { kind: "set_included", draft_part_ids: [18], value: false },
  ]);
});

it("does not refresh summaries between autosave write stages", async () => {
  const edit = deferred<PlanDraftWorkspace>();
  vi.mocked(editPlanDraftParts).mockReturnValueOnce(edit.promise);
  const invalidate = vi.spyOn(client, "invalidateQueries");
  mount();
  await waitFor(() => expect(checked()).toBe("true"));
  fireEvent.click(checkbox());
  await waitFor(() => expect(editPlanDraftParts).toHaveBeenCalledOnce());
  const summaryRefreshes = () => invalidate.mock.calls.filter(([filter]) =>
    JSON.stringify(filter?.queryKey) === JSON.stringify(queryKeys.planDrafts(7)) ||
    JSON.stringify(filter?.queryKey) === JSON.stringify(queryKeys.buildWorkflow(7)),
  );
  expect(summaryRefreshes()).toHaveLength(0);
  vi.mocked(fetchPlanReview).mockResolvedValue(review(false));
  await act(async () => { edit.resolve(workspace(false)); });
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Saved"));
  expect(summaryRefreshes()).toHaveLength(2);
});
