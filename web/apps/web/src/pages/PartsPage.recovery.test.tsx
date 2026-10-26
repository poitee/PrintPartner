// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PartsPage from "./PartsPage";
import type { PlanDraftWorkspace } from "@print-partner/contracts";
import PlanSpecialRequestField, { resetSpecialRequestSaveStateForTests } from "../components/PlanSpecialRequestField";
import { BuildSaveFlushProvider } from "../context/BuildSaveFlushContext";
import { resetAuxiliarySaveIntentForTests, retryFailedAuxiliarySaves } from "../lib/planAuxiliarySaveIntent";

const state = vi.hoisted(() => ({
  draftError: "Could not combine these pending edits" as string | null,
  mergeConflict: false,
  saving: false,
  prepare: vi.fn(),
  retry: vi.fn(),
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
    retryPlanSave: state.retry,
    saving: state.saving,
    refresh: vi.fn(),
    mergeConflict: state.mergeConflict,
    discardPendingEdits: state.discard,
    editActivePlanDraft: state.edit,
  }),
}));
vi.mock("../queries/planLayers", () => ({ usePlanLayersQuery: () => ({ data: [], isLoading: false }) }));
vi.mock("../api/endpoints/stlNaming", () => ({ fetchStlNaming: async () => ({ folder_rules: [] }) }));
vi.mock("../components/plan/PlanFeaturesCard", () => ({ default: () => null }));
const updateProfile = vi.hoisted(() => vi.fn());
vi.mock("../queries/profiles", () => ({
  useUpdateProfileMutation: () => ({ mutateAsync: updateProfile, isPending: false }),
}));

function renderPlan(options?: { specialRequestField?: boolean }) {
  return render(
    <MemoryRouter>
      <BuildSaveFlushProvider>
        {options?.specialRequestField && <PlanSpecialRequestField profileId={7} value={null} />}
        <PartsPage />
      </BuildSaveFlushProvider>
    </MemoryRouter>,
  );
}

async function failSpecialRequestSave(text: string) {
  updateProfile.mockRejectedValueOnce(new Error("Server refused the special request"));
  const input = screen.getByRole("textbox", { name: "Special request" });
  fireEvent.change(input, { target: { value: text } });
  fireEvent.blur(input);
  await waitFor(() => expect(updateProfile).toHaveBeenCalledOnce());
}

function planRecoveryAlert() {
  const alert = screen.getAllByRole("alert").find((node) => node.textContent?.includes("Server refused the special request") && !node.textContent.includes("Special request was not saved"));
  if (!alert) throw new Error("Plan recovery alert is not shown");
  return alert;
}

beforeEach(() => {
  vi.resetAllMocks();
  state.draftError = "Could not combine these pending edits";
  state.mergeConflict = false;
  state.saving = false;
  state.workspace = null;
  state.prepare.mockResolvedValue(undefined);
  // Mirrors retryPlanSave: the deliberate Plan retry also resends retained auxiliary saves.
  state.retry.mockImplementation(() => retryFailedAuxiliarySaves(7));
  updateProfile.mockResolvedValue(undefined);
  state.discard.mockResolvedValue(undefined);
  state.edit.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  resetSpecialRequestSaveStateForTests();
  resetAuxiliarySaveIntentForTests();
});

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
    const retry = screen.getByRole("button", { name: "Retry save" });
    expect(retry.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(discard);
    fireEvent.click(retry);
    expect(state.discard).not.toHaveBeenCalled();
    expect(state.retry).not.toHaveBeenCalled();
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

  it("parts_retry_uses_retained_save", async () => {
    state.draftError = null;
    renderPlan({ specialRequestField: true });
    await failSpecialRequestSave("Call before printing");
    const failedBody = updateProfile.mock.calls[0]?.[0];
    expect(failedBody).toEqual({ id: 7, special_request: "Call before printing" });

    const alert = planRecoveryAlert();
    expect(screen.getByRole("status").textContent).toBe("Not saved");
    fireEvent.click(within(alert).getByRole("button", { name: "Retry save" }));

    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(2));
    expect(updateProfile.mock.calls[1]?.[0]).toEqual(failedBody);
    // With no failed ordinary Save, retryPlanSave would prepare a new Plan draft.
    expect(state.retry).not.toHaveBeenCalled();
    expect(state.prepare).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(updateProfile).toHaveBeenCalledTimes(2);
  });

  it("keeps focus and the error on Retry when the retained save is refused again", async () => {
    state.draftError = null;
    renderPlan({ specialRequestField: true });
    await failSpecialRequestSave("Call before printing");
    const retry = within(planRecoveryAlert()).getByRole("button", { name: "Retry save" });
    retry.focus();
    let refuse!: (reason: Error) => void;
    updateProfile.mockImplementationOnce(() => new Promise((_resolve, reject) => { refuse = reject; }));
    fireEvent.click(retry);

    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(2));
    expect(retry.getAttribute("aria-disabled")).toBe("true");
    expect(retry).toHaveProperty("disabled", false);
    expect(document.activeElement).toBe(retry);
    fireEvent.click(retry);
    expect(updateProfile).toHaveBeenCalledTimes(2);

    refuse(new Error("Server refused the special request"));
    await waitFor(() => expect(retry.getAttribute("aria-disabled")).toBe("false"));
    expect(document.activeElement).toBe(retry);
    expect(planRecoveryAlert()).toBeTruthy();
    expect(updateProfile).toHaveBeenCalledTimes(2);
    expect(state.retry).not.toHaveBeenCalled();
    expect(state.prepare).not.toHaveBeenCalled();
  });

  it("retries a failed ordinary Save and its retained special request once each", async () => {
    renderPlan({ specialRequestField: true });
    await failSpecialRequestSave("Call before printing");
    const failedBody = updateProfile.mock.calls[0]?.[0];
    const alert = screen.getAllByRole("alert").find((node) => node.textContent?.includes("Could not combine these pending edits"));
    fireEvent.click(within(alert!).getByRole("button", { name: "Retry save" }));

    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(2));
    expect(updateProfile.mock.calls[1]?.[0]).toEqual(failedBody);
    expect(state.retry).toHaveBeenCalledExactlyOnceWith();
    expect(state.prepare).not.toHaveBeenCalled();
    expect(state.edit).not.toHaveBeenCalled();
  });
});
