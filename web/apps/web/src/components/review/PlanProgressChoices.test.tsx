// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanDraftWorkspace } from "@print-partner/contracts";
import PlanProgressChoices from "./PlanProgressChoices";

const mocks = vi.hoisted(() => ({ reconcile: vi.fn(), prepare: vi.fn() }));
vi.mock("../../context/PlanWorkspaceContext", () => ({
  usePlanWorkspace: () => ({ reconcileActivePlanDraft: mocks.reconcile, preparePlan: mocks.prepare }),
}));

const part: PlanDraftWorkspace["parts"][number] = {
  draft_part_id: 17,
  base_revision_part_id: 42,
  part_key: "bracket.stl",
  filename: "bracket.stl",
  relative_path: "frame/bracket.stl",
  source_layer: "base:Voron",
  role: "primary",
  quantity_inferred: 2,
  quantity_override: null,
  quantity_effective: 2,
  included: true,
};
const workspace: PlanDraftWorkspace = {
  profile_id: 7,
  draft: { draft_id: 9, state: "open", lifecycle_version: 0, snapshot_digest: "a".repeat(64), base: { revision_id: 3, plan_version: 1 } },
  parts: [part],
  diff: {
    base_is_current: true,
    added: [],
    removed: [{ revision_part_id: 43, filename: "other-bracket.stl", relative_path: "other-bracket.stl", source_layer: "base:Voron" }],
    changed: [{
      before: { revision_part_id: 42, filename: "previous-bracket.stl", relative_path: "frame/bracket.stl", source_layer: "base:Voron" },
      after: part,
      fields: ["checksum"],
    }],
  },
  reconciliation: { kind: "unresolved", conflicts: [{ kind: "unsafe_predecessor", target_draft_part_id: 17, predecessor_revision_part_id: 42 }] },
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.reconcile.mockResolvedValue(undefined);
  mocks.prepare.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("PlanProgressChoices", () => {
  it("stays out of normal Plan editing", () => {
    const { rerender } = render(<PlanProgressChoices workspace={{ ...workspace, reconciliation: { kind: "ready", reused_units: 2, new_units: 0, surplus_units: 0 } }} />);
    expect(screen.queryByRole("heading")).toBeNull();
    rerender(<PlanProgressChoices workspace={{ ...workspace, reconciliation: { kind: "unresolved", conflicts: [] } }} />);
    expect(screen.queryByRole("heading")).toBeNull();
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });

  it("never defaults to resetting progress and saves an explicit keep decision first", async () => {
    let finishReconcile: (() => void) | undefined;
    mocks.reconcile.mockImplementation(() => new Promise<void>((resolve) => { finishReconcile = resolve; }));
    render(<PlanProgressChoices workspace={workspace} />);
    const selection = screen.getByRole("combobox", { name: "bracket.stl" });
    const save = screen.getByRole("button", { name: "Save choices" });
    expect(selection).toHaveProperty("value", "");
    expect(save).toHaveProperty("disabled", true);
    fireEvent.change(selection, { target: { value: "42" } });
    fireEvent.click(save);

    await waitFor(() => expect(mocks.reconcile).toHaveBeenCalledWith([{ kind: "accept_prior_completion", target_draft_part_id: 17, predecessor_revision_part_id: 42 }]));
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(selection).toHaveProperty("disabled", true);
    finishReconcile?.();
    await waitFor(() => expect(mocks.prepare).toHaveBeenCalledOnce());
  });

  it("allows printing again only after the user chooses it", async () => {
    render(<PlanProgressChoices workspace={workspace} />);
    fireEvent.change(screen.getByRole("combobox", { name: "bracket.stl" }), { target: { value: "replace" } });
    fireEvent.click(screen.getByRole("button", { name: "Save choices" }));
    await waitFor(() => expect(mocks.reconcile).toHaveBeenCalledWith([{ kind: "replace", target_draft_part_id: 17 }]));
    await waitFor(() => expect(mocks.prepare).toHaveBeenCalledOnce());
  });

  it("names ambiguous predecessors and sends only the chosen identity", async () => {
    render(<PlanProgressChoices workspace={{ ...workspace, reconciliation: { kind: "unresolved", conflicts: [{ kind: "ambiguous_exact_match", target_draft_part_id: 17, candidate_revision_part_ids: [42, 43] }] } }} />);
    expect(screen.getByRole("option", { name: "Keep progress from previous-bracket.stl" })).toHaveProperty("value", "42");
    expect(screen.getByRole("option", { name: "Keep progress from other-bracket.stl" })).toHaveProperty("value", "43");
    fireEvent.change(screen.getByRole("combobox", { name: "bracket.stl" }), { target: { value: "43" } });
    fireEvent.click(screen.getByRole("button", { name: "Save choices" }));
    await waitFor(() => expect(mocks.reconcile).toHaveBeenCalledWith([{ kind: "select_exact_predecessor", target_draft_part_id: 17, predecessor_revision_part_id: 43 }]));
  });

  it("does not save the Plan after a failed progress decision", async () => {
    mocks.reconcile.mockRejectedValueOnce(new Error("Could not preserve previous prints"));
    render(<PlanProgressChoices workspace={workspace} />);
    const selection = screen.getByRole("combobox", { name: "bracket.stl" });
    fireEvent.change(selection, { target: { value: "42" } });
    fireEvent.click(screen.getByRole("button", { name: "Save choices" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Could not preserve previous prints");
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(selection).toHaveProperty("value", "42");
    expect(screen.getByRole("button", { name: "Save choices" })).toHaveProperty("disabled", false);
  });

  it("keeps a failed Plan save visible without changing the user's progress choice", async () => {
    mocks.prepare.mockRejectedValueOnce(new Error("Plan save failed"));
    render(<PlanProgressChoices workspace={workspace} />);
    const selection = screen.getByRole("combobox", { name: "bracket.stl" });
    fireEvent.change(selection, { target: { value: "42" } });
    fireEvent.click(screen.getByRole("button", { name: "Save choices" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Plan save failed");
    expect(selection).toHaveProperty("value", "42");
  });
});
