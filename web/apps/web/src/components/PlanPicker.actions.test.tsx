// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import {
  PlanActionsProvider,
  usePlanActions,
} from "../context/PlanActionsContext";
import PlanPicker from "./PlanPicker";

const profileState = vi.hoisted(() => ({
  selectedProfileId: 1,
  profiles: [
    {
      id: 1,
      name: "Build 1",
      archived_at: null,
      part_count: 3,
      last_used_at: null,
    },
    {
      id: 2,
      name: "Build 2",
      archived_at: null,
      part_count: 2,
      last_used_at: null,
    },
  ],
}));

vi.mock("../context/ProfileContext", () => ({
  useProfileSelection: () => ({
    profiles: profileState.profiles,
    selectedProfileId: profileState.selectedProfileId,
    setSelectedProfileId: vi.fn(),
    loading: false,
  }),
}));

vi.mock("../context/BuildSaveFlushContext", () => ({
  useFlushBuildPageSaves: () => vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));

vi.mock("../queries/profiles", () => {
  const mutation = () => ({
    isPending: false,
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
  });
  return {
    useCreateProfileMutation: mutation,
    useUpdateProfileMutation: mutation,
    useDeleteProfileMutation: mutation,
    useDuplicateProfileMutation: mutation,
    useArchiveProfileMutation: mutation,
    useTouchProfileLastUsedMutation: mutation,
  };
});

function ActionButtons() {
  const {
    openCreatePlan,
    openRenamePlan,
    openDuplicatePlan,
    openDeletePlan,
    openArchivePlan,
  } = usePlanActions();

  return (
    <>
      <button type="button" onClick={openCreatePlan}>Open create</button>
      <button type="button" onClick={() => openRenamePlan(1)}>Open rename</button>
      <button type="button" onClick={() => openDuplicatePlan(1)}>Open duplicate</button>
      <button type="button" onClick={() => openDeletePlan(1)}>Open delete</button>
      <button type="button" onClick={() => openArchivePlan(1)}>Open archive</button>
    </>
  );
}

function TwoPickerHarness() {
  const [drawerOpen, setDrawerOpen] = useState(true);

  return (
    <PlanActionsProvider>
      <PlanPicker />
      {drawerOpen ? <PlanPicker /> : null}
      <button type="button" onClick={() => setDrawerOpen(false)}>
        Close navigation drawer
      </button>
      <ActionButtons />
    </PlanActionsProvider>
  );
}

function TestApp() {
  return (
    <MemoryRouter initialEntries={["/builds"]}>
      <TwoPickerHarness />
    </MemoryRouter>
  );
}

function closeDialog() {
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
}

describe("PlanPicker action registration", () => {
  beforeEach(() => {
    profileState.selectedProfileId = 1;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("keeps every action available after a second picker rerenders and unmounts", () => {
    const view = render(<TestApp />);

    profileState.selectedProfileId = 2;
    view.rerender(<TestApp />);
    fireEvent.click(screen.getByRole("button", { name: "Close navigation drawer" }));

    fireEvent.click(screen.getByRole("button", { name: "Open create" }));
    expect(screen.getByRole("dialog", { name: "New Build" })).toBeTruthy();
    closeDialog();

    fireEvent.click(screen.getByRole("button", { name: "Open rename" }));
    const renameDialog = screen.getByRole("dialog", { name: "Rename Build" });
    expect(within(renameDialog).getByLabelText("Name").getAttribute("value")).toBe("Build 1");
    closeDialog();

    fireEvent.click(screen.getByRole("button", { name: "Open duplicate" }));
    const duplicateDialog = screen.getByRole("dialog", { name: "Duplicate Build" });
    expect(within(duplicateDialog).getByLabelText("Name").getAttribute("value")).toContain("Build 1");
    closeDialog();

    fireEvent.click(screen.getByRole("button", { name: "Open delete" }));
    const deleteDialog = screen.getByRole("alertdialog", { name: "Delete Build?" });
    expect(deleteDialog.textContent).toContain("Build 1");
    closeDialog();

    fireEvent.click(screen.getByRole("button", { name: "Open archive" }));
    const archiveDialog = screen.getByRole("dialog", { name: "Archive Build?" });
    expect(archiveDialog.textContent).toContain("Build 1");
    closeDialog();
  });
});
