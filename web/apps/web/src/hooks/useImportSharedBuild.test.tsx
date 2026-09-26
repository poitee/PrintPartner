// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router-dom";
import { useImportSharedBuild } from "./useImportSharedBuild";
import BuildSaveNavigationGuard from "../components/BuildSaveNavigationGuard";
import { LibraryDraftProvider } from "../context/LibraryDraftContext";

const deps = vi.hoisted(() => ({
  pick: vi.fn(),
  flush: vi.fn(),
  upload: vi.fn(),
  reload: vi.fn(),
  select: vi.fn(),
}));

vi.mock("../api/endpoints/browserFiles", () => ({ pickKitBundle: deps.pick }));
vi.mock("../api/endpoints/imports", () => ({ uploadKitBundle: deps.upload }));
vi.mock("../hooks/useFlushBuildPageSaves", () => ({ useFlushBuildPageSaves: () => deps.flush }));
vi.mock("../context/ProfileContext", () => ({
  useProfileSelection: () => ({ reloadProfiles: deps.reload, setSelectedProfileId: deps.select }),
}));

function Probe() {
  const importBuild = useImportSharedBuild();
  const location = useLocation();
  return (
    <>
      <BuildSaveNavigationGuard />
      <button onClick={() => void importBuild()}>Import Build</button>
      <output data-testid="route">{location.pathname}{location.search}</output>
      <output data-testid="import-state">{location.state?.kitImport?.profile_id ?? "none"}</output>
    </>
  );
}

function renderImport() {
  const router = createMemoryRouter([{ path: "*", element: <Probe /> }], {
    initialEntries: ["/sources?profile=1"],
  });
  render(<LibraryDraftProvider><RouterProvider router={router} /></LibraryDraftProvider>);
}

describe("useImportSharedBuild", () => {
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    Object.values(deps).forEach((mock) => mock.mockReset());
  });

  it("waits for the current Build save before uploading or changing route", async () => {
    let finishSave!: () => void;
    deps.pick.mockResolvedValue(new File(["kit"], "shared.zip"));
    deps.flush.mockReturnValue(new Promise<void>((resolve) => { finishSave = resolve; }));
    deps.upload.mockResolvedValue({ profile_id: 2, profile_name: "Imported", parts_imported: 1, layers_imported: 0 });
    deps.reload.mockResolvedValue(undefined);
    renderImport();

    fireEvent.click(screen.getByRole("button", { name: "Import Build" }));
    await waitFor(() => expect(deps.flush).toHaveBeenCalledTimes(1));
    expect(deps.upload).not.toHaveBeenCalled();
    expect(screen.getByTestId("route").textContent).toBe("/sources?profile=1");

    await act(async () => finishSave());
    await waitFor(() => expect(screen.getByTestId("route").textContent).toBe("/sources?profile=2"));
    expect(screen.getByTestId("import-state").textContent).toBe("2");
    expect(deps.select).not.toHaveBeenCalled();
    expect(deps.upload.mock.invocationCallOrder[0]).toBeLessThan(deps.reload.mock.invocationCallOrder[0] ?? 0);
  });

  it("does not upload when the current Build save fails", async () => {
    deps.pick.mockResolvedValue(new File(["kit"], "shared.zip"));
    deps.flush.mockRejectedValue(new Error("offline"));
    renderImport();

    fireEvent.click(screen.getByRole("button", { name: "Import Build" }));
    await waitFor(() => expect(deps.flush).toHaveBeenCalledTimes(1));
    expect(deps.upload).not.toHaveBeenCalled();
    expect(screen.getByTestId("route").textContent).toBe("/sources?profile=1");
  });
});
