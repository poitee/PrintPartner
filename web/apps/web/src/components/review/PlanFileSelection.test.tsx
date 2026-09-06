// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ setFilesIncluded: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../queries/planLayers", () => ({ usePlanLayersQuery: () => ({ data: [
  { id: 1, project_id: 4, project_name: "Voron", layer_type: "base", layer_order: 0 },
  { id: 2, project_id: 44, project_name: "A4T", layer_type: "addon", layer_order: 1 },
] }) }));
vi.mock("../../queries/planReview", () => ({ usePlanReviewQuery: () => ({ data: { part_groups: [
  { source_layer: "base:Voron", folder: "STLs/Skirt/350", parts: [
    { id: 1, match_key: "a", filename: "left.stl", relative_path: "STLs/Skirt/350/left.stl", included: true },
    { id: 2, match_key: "b", filename: "right.stl", relative_path: "STLs/Skirt/350/right.stl", included: false },
  ] },
] } }) }));
vi.mock("../../context/PlanWorkspaceContext", () => ({ usePlanWorkspace: () => ({
  setFilesIncluded: state.setFilesIncluded, draftWorkspace: null,
}) }));
import PlanFileSelection from "./PlanFileSelection";
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("shows attached sources even when no printable files reached Plan", () => {
  render(<PlanFileSelection profileId={8} disabled={false} />);
  expect(screen.getByText("A4T")).toBeTruthy();
  expect(screen.getByText(/No printable files/)).toBeTruthy();
});

it("selects a nested folder in one Build-local operation", () => {
  render(<PlanFileSelection profileId={8} disabled={false} />);
  const folder = screen.getByRole("checkbox", { name: /STLs\/Skirt\/350/ });
  expect(folder.getAttribute("aria-checked")).toBe("mixed");
  fireEvent.click(folder);
  expect(state.setFilesIncluded).toHaveBeenCalledOnce();
  expect(state.setFilesIncluded.mock.calls[0]?.[0]).toHaveLength(2);
  expect(state.setFilesIncluded.mock.calls[0]?.[1]).toBe(true);
});

it("limits a searched folder action to the displayed files", () => {
  render(<PlanFileSelection profileId={8} disabled={false} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Find files" }), { target: { value: "right.stl" } });
  fireEvent.click(screen.getByRole("checkbox", { name: /STLs\/Skirt\/350/ }));
  expect(state.setFilesIncluded.mock.calls[0]?.[0]).toEqual([expect.objectContaining({ filename: "right.stl" })]);
});
