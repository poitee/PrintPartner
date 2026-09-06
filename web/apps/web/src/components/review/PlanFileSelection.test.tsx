// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ setFilesIncluded: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../queries/planLayers", () => ({ usePlanLayersQuery: () => ({ data: [
  { id: 1, project_id: 4, project_name: "Voron", layer_type: "base", layer_order: 0 },
  { id: 2, project_id: 44, project_name: "A4T", layer_type: "addon", layer_order: 1 },
  { id: 3, project_id: 45, project_name: "Empty source", layer_type: "addon", layer_order: 2 },
] }) }));
vi.mock("../../queries/planReview", () => ({ usePlanReviewQuery: () => ({ data: { part_groups: [
  { source_layer: "base:Voron", folder: "STLs/Skirt/350", parts: [
    { id: 1, match_key: "a", source_layer: "base:Voron", filename: "left.stl", relative_path: "STLs/Skirt/350/left.stl", included: true },
    { id: 2, match_key: "b", source_layer: "base:Voron", filename: "right.stl", relative_path: "STLs/Skirt/350/right.stl", included: false },
    { id: 3, match_key: "c", source_layer: "addon:A4T", filename: "mount.stl", relative_path: "STLs/Skirt/350/mount.stl", included: true },
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
  const folder = within(screen.getByRole("region", { name: "Voron" })).getByRole("checkbox", { name: /STLs\/Skirt\/350/ });
  expect(folder.getAttribute("aria-checked")).toBe("mixed");
  fireEvent.click(folder);
  expect(state.setFilesIncluded).toHaveBeenCalledOnce();
  expect(state.setFilesIncluded.mock.calls[0]?.[0]).toHaveLength(2);
  expect(state.setFilesIncluded.mock.calls[0]?.[1]).toBe(true);
});

it("keeps same-named folders from different sources in their own source trees", () => {
  render(<PlanFileSelection profileId={8} disabled={false} />);
  const addon = within(screen.getByRole("region", { name: "A4T" }));
  expect(addon.getByRole("checkbox", { name: "Include mount.stl" })).toBeTruthy();
  expect(addon.queryByRole("checkbox", { name: "Include left.stl" })).toBeNull();
  fireEvent.click(addon.getByRole("checkbox", { name: /STLs\/Skirt\/350/ }));
  expect(state.setFilesIncluded.mock.calls[0]?.[0]).toEqual([expect.objectContaining({ filename: "mount.stl" })]);
});

it("limits a searched folder action to the displayed files", () => {
  render(<PlanFileSelection profileId={8} disabled={false} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Find files" }), { target: { value: "right.stl" } });
  fireEvent.click(screen.getByRole("checkbox", { name: /STLs\/Skirt\/350/ }));
  expect(state.setFilesIncluded.mock.calls[0]?.[0]).toEqual([expect.objectContaining({ filename: "right.stl" })]);
});
