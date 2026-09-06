// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PartsPage from "./PartsPage";
import type { PlanDraftWorkspace } from "@print-partner/contracts";

const state = vi.hoisted(() => ({
  draftError: "Could not combine these pending edits",
  mergeConflict: false,
  saving: false,
  prepare: vi.fn(),
  discard: vi.fn(),
  edit: vi.fn(),
  workspace: null as PlanDraftWorkspace | null,
}));
vi.mock("../context/ProfileContext", () => ({ useProfileSelection: () => ({ selectedProfileId: 7, profiles: [] }) }));
vi.mock("../context/PlanWorkspaceContext", () => ({
  usePlanWorkspace: () => ({
    review: null,
    loading: false,
    error: null,
    draftError: state.draftError,
    draftWorkspace: state.workspace,
    draftLoading: false,
    preparePlan: state.prepare,
    saving: state.saving,
    refresh: vi.fn(),
    mergeConflict: state.mergeConflict,
    discardPendingEdits: state.discard,
    editActivePlanDraft: state.edit,
  }),
}));
vi.mock("../queries/planLayers", () => ({ usePlanLayersQuery: () => ({ data: [], isLoading: false }) }));
vi.mock("../api/endpoints/stlNaming", () => ({ fetchStlNaming: async () => ({ folder_rules: [] }) }));

function renderPlan() {
  return render(<MemoryRouter><PartsPage /></MemoryRouter>);
}

beforeEach(() => {
  vi.resetAllMocks();
  state.draftError = "Could not combine these pending edits";
  state.mergeConflict = false;
  state.saving = false;
  state.workspace = null;
  state.prepare.mockResolvedValue(undefined);
  state.discard.mockResolvedValue(undefined);
  state.edit.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("Plan pending-edit recovery", () => {
  it("shows retained draft files and saves explicit choices when a first Plan save conflicts", async () => {
    state.mergeConflict = true;
    state.workspace = {
      profile_id: 7,
      draft: { draft_id: 9, state: "open", lifecycle_version: 0, snapshot_digest: "a".repeat(64), base: { revision_id: null, plan_version: 0 } },
      parts: [{ draft_part_id: 17, base_revision_part_id: null, part_key: "bracket.stl", filename: "bracket.stl", relative_path: "bracket.stl", source_layer: "base:Source", role: "primary", quantity_inferred: 1, quantity_override: 3, quantity_effective: 3, included: true }],
      diff: { base_is_current: false, added: [], removed: [], changed: [] },
      reconciliation: { kind: "ready", reused_units: 0, new_units: 0, surplus_units: 0 },
    };
    renderPlan();
    expect(screen.getByText("bracket.stl")).toBeTruthy();
    expect(screen.getByDisplayValue("3")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Save pending choices" }));
    await waitFor(() => expect(state.edit).toHaveBeenCalledWith([{ kind: "set_included", draft_part_ids: [17], value: false }]));
    await waitFor(() => expect(state.prepare).toHaveBeenCalledOnce());
    expect(state.discard).not.toHaveBeenCalled();
  });
  it("does not offer discarding for an ordinary save failure", () => {
    renderPlan();
    expect(screen.getByRole("button", { name: "Retry save" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Discard pending edits and use saved Plan" })).toBeNull();
    expect(state.discard).not.toHaveBeenCalled();
  });

  it("offers the destructive choice only for a merge conflict and requires a click", async () => {
    state.mergeConflict = true;
    renderPlan();
    expect(screen.getByRole("alert").textContent).toContain("Your pending choices remain below.");
    expect(screen.getByRole("alert").textContent).toContain("Finished print progress is kept.");
    const discard = screen.getByRole("button", { name: "Discard pending edits and use saved Plan" });
    expect(state.discard).not.toHaveBeenCalled();
    fireEvent.click(discard);
    await waitFor(() => expect(state.discard).toHaveBeenCalledExactlyOnceWith());
    expect(state.prepare).not.toHaveBeenCalled();
  });

  it("disables retry and discard while a save is in flight", () => {
    state.mergeConflict = true;
    state.saving = true;
    renderPlan();
    const discard = screen.getByRole("button", { name: "Discard pending edits and use saved Plan" });
    expect(discard).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Retry save" })).toHaveProperty("disabled", true);
    fireEvent.click(discard);
    expect(state.discard).not.toHaveBeenCalled();
  });

  it("keeps a failed discard visible for recovery", async () => {
    state.mergeConflict = true;
    state.discard.mockRejectedValueOnce(new Error("Connection interrupted"));
    renderPlan();
    fireEvent.click(screen.getByRole("button", { name: "Discard pending edits and use saved Plan" }));
    await waitFor(() => expect(state.discard).toHaveBeenCalledOnce());
    expect(screen.getByRole("alert").textContent).toContain("Could not combine these pending edits");
    expect(screen.getByRole("status").textContent).toBe("Not saved");
    expect(state.prepare).not.toHaveBeenCalled();
  });
});
