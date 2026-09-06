// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PlanReview, ReviewPart } from "../api/endpoints/planManifests";
import { fetchPlanReview } from "../api/endpoints/planManifests";
import { savePlanChoices, recomputePlanDraft, editPlanDraftParts, applyPlanDraft, listPlanDrafts, type SavePlanChoicesResponse } from "../api/endpoints/planDrafts";
import { EngineHttpError } from "../api/engineTransport";
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
  savePlanChoices: vi.fn(), applyPlanDraft: vi.fn(), editPlanDraftParts: vi.fn(), fetchPlanDraftWorkspace: vi.fn(),
  listPlanDrafts: vi.fn(), recomputePlanDraft: vi.fn(), abandonPlanDraft: vi.fn(),
  reconcilePlanDraft: vi.fn(), rebasePlanDraft: vi.fn(),
}));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
const part: ReviewPart = {
  id: 42, match_key: "bracket.stl", relative_path: "frame/bracket.stl", filename: "bracket.stl",
  source_layer: "base:Voron", status: "ok", role: "primary", requirement: null, option_group_id: null,
  included: true, filament_color_id: null, quantity_auto: 1, quantity_override: null, quantity_effective: 1,
  printed_count: 0, print_units: [false], missing: true, filament_display: "Unset",
};
function review(included: boolean, profileId = 7, version = 1): PlanReview {
  return {
    profile_id: profileId, accepted_basis: { profile_id: profileId, plan_revision_id: version + 2, plan_version: version,
      plan_revision_digest: "c".repeat(64), required_unit_mapping_digest: "d".repeat(64) },
    plan_name: "Test", layers: [],
    totals: { included_parts: Number(included), total_print_units: Number(included), by_role: {}, by_filament: {} },
    issues: [], has_blockers: false,
    part_groups: [{ source_layer: "base:Voron", folder: "frame", parts: [{ ...part, included }] }],
  };
}
function saved(included: boolean, profileId = 7, version = 2): SavePlanChoicesResponse {
  return {
    receipt: { profile_id: profileId, draft_id: 9, revision_id: version + 2, plan_version: version,
      draft_lifecycle_version: 1, revision_digest: "c".repeat(64), required_unit_mapping_digest: "d".repeat(64), applied_at: "2026-09-06T00:00:00Z" },
    review: review(included, profileId, version),
    profile: { id: profileId, name: "Test", part_count: 1, order_number: null, special_request: null,
      accepted_progress: { kind: "ready", total_units: Number(included), remaining_units: Number(included) },
      build_stale: false, freshness: { status: "current", accepted_input_set_id: 1, accepted_at: "2026-09-06T00:00:00Z" },
      archived_at: null, last_used_at: null },
    closed_draft_ids: [9],
  };
}
function Picker() {
  const plan = usePlanWorkspace();
  return <>
    <span role="status">{plan.saving ? "Saving" : plan.draftError ? "Not saved" : "Saved"}</span>
    {plan.draftError && <p role="alert">{plan.draftError}</p>}
    <button onClick={() => void plan.preparePlan().catch(() => {})}>Retry save</button>
    <button onClick={() => void plan.discardPendingEdits().catch(() => {})}>Discard</button>
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
  vi.mocked(savePlanChoices).mockImplementation(async (id, request) => {
    const decision = request.decisions[0];
    return saved(decision?.kind === "set_included" ? decision.value : true, id, request.expected_base.plan_version + 1);
  });
});
afterEach(() => { cleanup(); client.clear(); });

it("confirms one save from its response and prevents an older Review read from reversing the click", async () => {
  const save = deferred<SavePlanChoicesResponse>();
  const staleRead = deferred<PlanReview>();
  vi.mocked(savePlanChoices).mockReturnValueOnce(save.promise);
  mount();
  await waitFor(() => expect(checked()).toBe("true"));
  const fetchCount = vi.mocked(fetchPlanReview).mock.calls.length;
  const oldRequest = client.fetchQuery({ queryKey: queryKeys.planReview(7, true), staleTime: 0,
    queryFn: () => staleRead.promise }).catch(() => undefined);
  fireEvent.click(checkbox());
  expect(checked()).toBe("false");
  await waitFor(() => expect(savePlanChoices).toHaveBeenCalledOnce());
  expect(screen.getByRole("status").textContent).toBe("Saving");
  await act(async () => { save.resolve(saved(false)); });
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Saved"));
  expect(vi.mocked(fetchPlanReview).mock.calls.length).toBe(fetchCount);
  expect(recomputePlanDraft).not.toHaveBeenCalled();
  expect(editPlanDraftParts).not.toHaveBeenCalled();
  expect(applyPlanDraft).not.toHaveBeenCalled();
  await act(async () => { staleRead.resolve(review(true)); await oldRequest; });
  expect(checked()).toBe("false");
  expect(client.getQueryData<PlanReview>(queryKeys.planReview(7, true))?.accepted_basis?.plan_version).toBe(2);
  expect(client.getQueryData<PlanReview>(queryKeys.planReview(7, false))?.part_groups).toEqual([]);
});

it("coalesces rapid choices and never lets an older save replace the latest click", async () => {
  const first = deferred<SavePlanChoicesResponse>();
  vi.mocked(savePlanChoices).mockReturnValueOnce(first.promise);
  const page = mount();
  await waitFor(() => expect(checked()).toBe("true"));
  fireEvent.click(checkbox());
  await waitFor(() => expect(savePlanChoices).toHaveBeenCalledOnce());
  fireEvent.click(checkbox()); fireEvent.click(checkbox()); fireEvent.click(checkbox());
  expect(checked()).toBe("true");
  expect(checkbox().hasAttribute("disabled")).toBe(false);
  await act(async () => { first.resolve(saved(false)); });
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Saved"));
  expect(checked()).toBe("true");
  expect(savePlanChoices).toHaveBeenCalledTimes(2);
  expect(vi.mocked(savePlanChoices).mock.calls[1]?.[1].expected_base.plan_version).toBe(2);
  page.unmount(); client.clear(); mount();
  await waitFor(() => expect(checked()).toBe("true"));
});

it("does not save again when rapid clicks end at the choice already being saved", async () => {
  const first = deferred<SavePlanChoicesResponse>();
  vi.mocked(savePlanChoices).mockReturnValueOnce(first.promise);
  mount();
  await waitFor(() => expect(checked()).toBe("true"));
  fireEvent.click(checkbox());
  await waitFor(() => expect(savePlanChoices).toHaveBeenCalledOnce());
  fireEvent.click(checkbox()); fireEvent.click(checkbox());
  await act(async () => { first.resolve(saved(false)); });
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Saved"));
  expect(savePlanChoices).toHaveBeenCalledOnce();
  expect(checked()).toBe("false");
});

it.each(["network", "reply"])("retains the same payload and key through an uncertain %s failure and manual retry", async (failure) => {
  vi.mocked(savePlanChoices).mockRejectedValueOnce(new Error(failure)).mockRejectedValueOnce(new Error(failure));
  mount();
  await waitFor(() => expect(checked()).toBe("true"));
  fireEvent.click(checkbox());
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Not saved"));
  expect(checked()).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Saved"));
  expect(savePlanChoices).toHaveBeenCalledTimes(3);
  const calls = vi.mocked(savePlanChoices).mock.calls;
  expect(calls[1]).toEqual(calls[0]);
  expect(calls[2]).toEqual(calls[0]);
  expect(checked()).toBe("false");
});

it("discards an ambiguous command without replaying it before the next different edit", async () => {
  vi.mocked(savePlanChoices).mockRejectedValueOnce(new Error("offline")).mockRejectedValueOnce(new Error("offline"));
  mount();
  await waitFor(() => expect(checked()).toBe("true"));
  fireEvent.click(checkbox());
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Not saved"));
  vi.mocked(fetchPlanReview).mockResolvedValue(review(false, 7, 2));
  fireEvent.click(screen.getByRole("button", { name: "Discard" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Saved"));
  fireEvent.click(screen.getByRole("button", { name: "Set quantity" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Saved"));
  expect(savePlanChoices).toHaveBeenCalledTimes(3);
  const calls = vi.mocked(savePlanChoices).mock.calls;
  expect(calls[2]?.[1].decisions[0]?.kind).toBe("set_quantity_override");
  expect(calls[2]?.[1].expected_base.plan_version).toBe(2);
  expect(calls[2]?.[2]).not.toBe(calls[0]?.[2]);
});

it("retains an ambiguous command when discard cannot read the accepted Plan", async () => {
  vi.mocked(savePlanChoices).mockRejectedValueOnce(new Error("offline")).mockRejectedValueOnce(new Error("offline"));
  mount();
  await waitFor(() => expect(checked()).toBe("true"));
  fireEvent.click(checkbox());
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Not saved"));
  vi.mocked(fetchPlanReview).mockRejectedValue(new Error("cannot confirm discard"));
  fireEvent.click(screen.getByRole("button", { name: "Discard" }));
  await waitFor(() => expect(screen.getAllByRole("alert").map((alert) => alert.textContent).join(" ")).toContain("cannot confirm discard"));
  expect(screen.getByRole("status").textContent).toBe("Not saved");
  vi.mocked(fetchPlanReview).mockResolvedValue(review(true));
  fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Saved"));
  expect(savePlanChoices).toHaveBeenCalledTimes(3);
  const calls = vi.mocked(savePlanChoices).mock.calls;
  expect(calls[2]).toEqual(calls[0]);
});

it("keeps a pending choice in its Build when the user switches Builds", async () => {
  const first = deferred<SavePlanChoicesResponse>();
  vi.mocked(savePlanChoices).mockReturnValueOnce(first.promise);
  const page = mount();
  await waitFor(() => expect(checked()).toBe("true"));
  fireEvent.click(checkbox());
  await waitFor(() => expect(savePlanChoices).toHaveBeenCalledOnce());
  selection.profileId = 8;
  page.rerender(<QueryClientProvider client={client}><PlanWorkspaceProvider><Picker /></PlanWorkspaceProvider></QueryClientProvider>);
  await waitFor(() => expect(checked()).toBe("true"));
  expect(screen.getByRole("status").textContent).toBe("Saved");
  await act(async () => { first.resolve(saved(false)); });
  expect(checked()).toBe("true");
  selection.profileId = 7;
  page.rerender(<QueryClientProvider client={client}><PlanWorkspaceProvider><Picker /></PlanWorkspaceProvider></QueryClientProvider>);
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Saved"));
  expect(checked()).toBe("false");
});

it("does not label a failed selection Saved when a different edit succeeds", async () => {
  vi.mocked(savePlanChoices).mockRejectedValueOnce(new EngineHttpError("disk full", 422));
  mount();
  await waitFor(() => expect(checked()).toBe("true"));
  fireEvent.click(checkbox());
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Not saved"));
  fireEvent.click(screen.getByRole("button", { name: "Set quantity" }));
  await waitFor(() => expect(savePlanChoices).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getByRole("status").textContent).not.toBe("Saving"));
  expect(screen.getByRole("status").textContent).toBe("Not saved");
  expect(checked()).toBe("false");
});

it("batches different files with their individual final choices", async () => {
  const second: ReviewPart = { ...part, id: 43, match_key: "cover.stl", relative_path: "frame/cover.stl", filename: "cover.stl" };
  const first = deferred<SavePlanChoicesResponse>();
  vi.mocked(fetchPlanReview).mockResolvedValue({ ...review(true), part_groups: [{ folder: "frame", source_layer: "base:Voron", parts: [part, second] }] });
  vi.mocked(savePlanChoices).mockReturnValueOnce(first.promise).mockImplementation(async (id, request) => {
    const result = saved(true, id, 3);
    result.review.part_groups[0]!.parts = [part, second].map((row) => {
      const choice = request.decisions.find((entry) => entry.target.part_key === row.match_key);
      return { ...row, included: choice?.kind === "set_included" ? choice.value : row.included };
    });
    return result;
  });
  mount();
  await waitFor(() => expect(checked()).toBe("true"));
  fireEvent.click(checkbox());
  await waitFor(() => expect(savePlanChoices).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("checkbox", { name: "Include cover.stl" }));
  fireEvent.click(checkbox());
  await act(async () => { const result = saved(false); result.review.part_groups[0]!.parts.push(second); first.resolve(result); });
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Saved"));
  expect(checked()).toBe("true");
  expect(screen.getByRole("checkbox", { name: "Include cover.stl" }).getAttribute("aria-checked")).toBe("false");
  expect(savePlanChoices).toHaveBeenCalledTimes(2);
  expect(vi.mocked(savePlanChoices).mock.calls[1]?.[1].decisions.map((choice) => [choice.target.part_key, choice.value]))
    .toEqual([["bracket.stl", true], ["cover.stl", false]]);
});

it("marks ancillary summaries stale without starting additional save requests", async () => {
  const invalidate = vi.spyOn(client, "invalidateQueries");
  mount();
  await waitFor(() => expect(checked()).toBe("true"));
  fireEvent.click(checkbox());
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Saved"));
  expect(invalidate.mock.calls).toHaveLength(4);
  expect(invalidate.mock.calls.every(([filter]) => filter?.refetchType === "none")).toBe(true);
});
