// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import CommandPalette from "./CommandPalette";
import PlanSpecialRequestField, { resetSpecialRequestSaveStateForTests } from "./PlanSpecialRequestField";
import { BuildSaveFlushProvider } from "../context/BuildSaveFlushContext";
import { resetAuxiliarySaveIntentForTests, retryFailedAuxiliarySaves } from "../lib/planAuxiliarySaveIntent";

const state = vi.hoisted(() => ({
  draftError: null as string | null,
  prepare: vi.fn(),
  retry: vi.fn(),
  edit: vi.fn(),
  updateProfile: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: state.toastError, success: state.toastSuccess } }));
vi.mock("../context/ProfileContext", () => ({ useProfileSelection: () => ({ selectedProfileId: 7, profiles: [] }) }));
vi.mock("../context/PlanWorkspaceContext", () => ({
  usePlanWorkspace: () => ({
    review: null,
    draftError: state.draftError,
    preparePlan: state.prepare,
    retryPlanSave: state.retry,
    editActivePlanDraft: state.edit,
  }),
}));
vi.mock("../context/PlanActionsContext", () => ({ usePlanActions: () => ({ openCreatePlan: vi.fn() }) }));
vi.mock("../hooks/useEngineHealth", () => ({ useEngineHealth: () => ({ health: null }) }));
vi.mock("../hooks/useJobRunner", () => ({ useJobRunner: () => ({ busy: false, runJob: vi.fn() }) }));
vi.mock("../hooks/useImportSharedBuild", () => ({ useImportSharedBuild: () => vi.fn() }));
vi.mock("../queries/profiles", () => ({
  useUpdateProfileMutation: () => ({ mutateAsync: state.updateProfile, isPending: false }),
}));

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView ??= () => {};
});

beforeEach(() => {
  vi.resetAllMocks();
  state.draftError = null;
  state.prepare.mockResolvedValue(undefined);
  // Mirrors retryPlanSave: the deliberate Plan retry also resends retained auxiliary saves.
  state.retry.mockImplementation(() => retryFailedAuxiliarySaves(7));
  state.updateProfile.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  resetSpecialRequestSaveStateForTests();
  resetAuxiliarySaveIntentForTests();
});

function renderPalette() {
  return render(
    <MemoryRouter initialEntries={["/plan?profile=7"]}>
      <BuildSaveFlushProvider>
        <PlanSpecialRequestField profileId={7} value={null} />
        <CommandPalette />
      </BuildSaveFlushProvider>
    </MemoryRouter>,
  );
}

async function failSpecialRequestSave(text: string) {
  state.updateProfile.mockRejectedValueOnce(new Error("Server refused the special request"));
  const input = screen.getByRole("textbox", { name: "Special request" });
  fireEvent.change(input, { target: { value: text } });
  fireEvent.blur(input);
  await waitFor(() => expect(state.updateProfile).toHaveBeenCalledOnce());
}

function openPalette() {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
  });
}

describe("CommandPalette failed Save retry", () => {
  it("command_retry_does_not_create_new_intent", async () => {
    renderPalette();
    await failSpecialRequestSave("Call before printing");
    const failedBody = state.updateProfile.mock.calls[0]?.[0];
    expect(failedBody).toEqual({ id: 7, special_request: "Call before printing" });

    openPalette();
    fireEvent.click(await screen.findByRole("option", { name: /Retry failed save/ }));

    await waitFor(() => expect(state.updateProfile).toHaveBeenCalledTimes(2));
    expect(state.updateProfile.mock.calls[1]?.[0]).toEqual(failedBody);
    // With no failed ordinary Save, retryPlanSave would prepare a new Plan draft.
    expect(state.retry).not.toHaveBeenCalled();
    expect(state.prepare).not.toHaveBeenCalled();
    expect(state.edit).not.toHaveBeenCalled();
    await waitFor(() => expect(state.toastSuccess).toHaveBeenCalledOnce());
    expect(state.toastError).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(state.updateProfile).toHaveBeenCalledTimes(2);
  });

  it("offers the retry for a failed ordinary Save and reports a refused retry with its error", async () => {
    state.draftError = "Plan changes were not saved";
    state.retry.mockRejectedValueOnce(new Error("Plan changes were not saved"));
    renderPalette();

    openPalette();
    fireEvent.click(await screen.findByRole("option", { name: /Retry failed save/ }));

    await waitFor(() => expect(state.toastError).toHaveBeenCalledExactlyOnceWith("Plan changes were not saved"));
    expect(state.retry).toHaveBeenCalledExactlyOnceWith();
    expect(state.prepare).not.toHaveBeenCalled();
    expect(state.edit).not.toHaveBeenCalled();
    expect(state.updateProfile).not.toHaveBeenCalled();
  });

  it("offers no retry when nothing failed to save", async () => {
    renderPalette();
    openPalette();
    await screen.findByRole("option", { name: /Go to Builds/ });
    expect(screen.queryByRole("option", { name: /Retry failed save/ })).toBeNull();
    expect(state.retry).not.toHaveBeenCalled();
  });
});
