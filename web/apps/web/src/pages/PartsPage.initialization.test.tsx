// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import PartsPage from "./PartsPage";

const state = vi.hoisted<{
  freshness: string; pending: boolean; saving: boolean; error: string | null; prepare: ReturnType<typeof vi.fn>;
}>(() => ({
  freshness: "current", pending: false, saving: false, error: null,
  prepare: vi.fn(),
}));
vi.mock("../context/ProfileContext", () => ({ useProfileSelection: () => ({
  selectedProfileId: 8, profiles: [{ id: 8, freshness: { status: state.freshness } }],
}) }));
vi.mock("../context/PlanWorkspaceContext", () => ({ usePlanWorkspace: () => ({
  review: { accepted_basis: { plan_version: 1 }, plan_name: "Test" },
  loading: false, draftLoading: false, saving: state.saving,
  draftWorkspace: state.pending ? { profile_id: 8, draft: { snapshot_digest: "test" } } : null,
  draftError: state.error, preparePlan: state.prepare,
}) }));
vi.mock("../queries/planLayers", () => ({ usePlanLayersQuery: () => ({ data: [{ project_id: 1 }] }) }));
vi.mock("../api/endpoints/stlNaming", () => ({ fetchStlNaming: async () => ({ folder_rules: [] }) }));
vi.mock("../components/KitManifestOptions", () => ({ default: () => null }));
vi.mock("../components/review/PlanFileSelection", () => ({ default: ({ disabled }: { disabled: boolean }) => <input type="checkbox" aria-label="File selection" disabled={disabled} /> }));
vi.mock("../components/review/PlanProgressChoices", () => ({ default: () => null }));
vi.mock("../components/build/PlanRolesCard", () => ({ default: () => null }));
vi.mock("../components/review/ReviewPartsSheet", () => ({ default: () => null }));
beforeEach(() => {
  state.freshness = "current"; state.pending = false; state.saving = false; state.error = null;
  state.prepare.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);
function mount() { return render(<MemoryRouter><PartsPage /></MemoryRouter>); }
it("does not prepare or save an unchanged accepted Plan on navigation", async () => {
  mount();
  await waitFor(() => expect(state.prepare).not.toHaveBeenCalled());
});
it.each(["stale", "untracked"])("prepares when source freshness is %s", async (freshness) => {
  state.freshness = freshness; mount();
  await waitFor(() => expect(state.prepare).toHaveBeenCalledOnce());
});
it("resumes pending edits even when source inputs are current", async () => {
  state.pending = true; mount();
  await waitFor(() => expect(state.prepare).toHaveBeenCalledOnce());
});
it("does not skip recovery for a failed save", async () => {
  state.error = "Save failed"; mount();
  await waitFor(() => expect(state.prepare).toHaveBeenCalledOnce());
});
it("keeps file selection available while saving but prevents printing a pending Plan", () => {
  state.saving = true;
  mount();
  expect(screen.getByRole("checkbox", { name: "File selection" })).toHaveProperty("disabled", false);
  expect(screen.getByRole("button", { name: "Print" })).toHaveProperty("disabled", true);
});
