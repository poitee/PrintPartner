// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, Outlet, RouterProvider, useLocation, useNavigate } from "react-router-dom";
import BuildSaveNavigationGuard from "../components/BuildSaveNavigationGuard";
import { LibraryDraftProvider } from "../context/LibraryDraftContext";
import { ProfileProvider, useProfileSelection } from "../context/ProfileContext";
import { useProfileUrlSync } from "./useProfileUrlSync";
import { useImportSharedBuild } from "./useImportSharedBuild";

const deps = vi.hoisted(() => ({
  pick: vi.fn(),
  upload: vi.fn(),
  refetch: vi.fn(),
  profiles: [] as Array<{ id: number; name: string }>,
}));

vi.mock("../api/endpoints/browserFiles", () => ({ pickKitBundle: deps.pick }));
vi.mock("../api/endpoints/imports", () => ({ uploadKitBundle: deps.upload }));
vi.mock("./useFlushBuildPageSaves", () => ({
  useFlushBuildPageSaves: () => async () => {},
}));
vi.mock("../hooks/useEngineHealth", () => ({
  useEngineHealth: () => ({ health: { ok: true }, loading: false }),
}));
vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({ user: null, multiUser: false, loading: false }),
}));
vi.mock("../queries/profiles", () => ({
  useProfilesQuery: () => ({
    data: deps.profiles,
    isLoading: false,
    isSuccess: true,
    error: null,
    refetch: deps.refetch,
  }),
}));

function RouteShell() {
  return (
    <ProfileProvider>
      <LibraryDraftProvider>
        <BuildSaveNavigationGuard />
        <RouteContent />
      </LibraryDraftProvider>
    </ProfileProvider>
  );
}

function RouteContent() {
  useProfileUrlSync();
  return <Outlet />;
}

function Library() {
  const importBuild = useImportSharedBuild();
  return <button onClick={() => void importBuild()}>Import Build</button>;
}

function Build() {
  const location = useLocation();
  const navigate = useNavigate();
  const { selectedProfileId, setSelectedProfileId } = useProfileSelection();
  const importedId = (location.state as { kitImport?: { profile_id: number } } | null)?.kitImport?.profile_id;
  useEffect(() => {
    if (importedId != null && selectedProfileId !== importedId) setSelectedProfileId(importedId);
  }, [importedId, selectedProfileId, setSelectedProfileId]);
  return <>
    <output data-testid="build-selection">{selectedProfileId ?? "none"}</output>
    <button onClick={() => navigate("?profile=1", { replace: true })}>Choose old Build</button>
  </>;
}

describe("first Build import after a failed list reload", () => {
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    [deps.pick, deps.upload, deps.refetch].forEach((mock) => mock.mockReset());
    deps.profiles = [];
  });

  it("allows switching to a known Build while the imported Build is absent from the list", async () => {
    deps.profiles = [{ id: 1, name: "Old" }];
    deps.pick.mockResolvedValue(new File(["kit"], "shared.zip"));
    deps.upload.mockResolvedValue({ profile_id: 2, profile_name: "Imported", parts_imported: 0, layers_imported: 0 });
    deps.refetch.mockResolvedValue({ error: new Error("list unavailable") });
    const router = createMemoryRouter([{ element: <RouteShell />, children: [
      { path: "/library", element: <Library /> },
      { path: "/sources", element: <Build /> },
    ] }], { initialEntries: ["/library"] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);

    fireEvent.click(screen.getByRole("button", { name: "Import Build" }));
    await waitFor(() => expect(screen.getByTestId("build-selection").textContent).toBe("2"));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    fireEvent.click(screen.getByRole("button", { name: "Choose old Build" }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(router.state.location.search).toBe("?profile=1");
    expect(screen.getByTestId("build-selection").textContent).toBe("1");
  });

  it("stays on the created Build without a stale Library URL publish", async () => {
    deps.pick.mockResolvedValue(new File(["kit"], "shared.zip"));
    deps.upload.mockResolvedValue({
      profile_id: 1,
      profile_name: "Imported",
      parts_imported: 0,
      layers_imported: 0,
    });
    deps.refetch.mockResolvedValue({ error: new Error("list unavailable") });
    const router = createMemoryRouter([
      {
        element: <RouteShell />,
        children: [
          { path: "/library", element: <Library /> },
          { path: "/sources", element: <Build /> },
        ],
      },
    ], { initialEntries: ["/library"] });
    const paths: string[] = [];
    const unsubscribe = router.subscribe(({ location }) => {
      paths.push(`${location.pathname}${location.search}`);
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Import Build" }));
    await waitFor(() => expect(screen.getByTestId("build-selection").textContent).toBe("1"));
    expect(`${router.state.location.pathname}${router.state.location.search}`).toBe("/sources?profile=1");
    expect(paths).toContain("/sources?profile=1");
    expect(paths).not.toContain("/library?profile=1");
    await waitFor(() => expect(sessionStorage.getItem("pp-selected-profile-id")).toBe("1"));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(screen.getByTestId("build-selection").textContent).toBe("1");
    expect(sessionStorage.getItem("pp-selected-profile-id")).toBe("1");
    expect(deps.upload).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
