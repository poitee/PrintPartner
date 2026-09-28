// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ProfileSummary, ReferenceShare, SourceSummary } from "@print-partner/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { useState } from "react";
import { ProfileProvider, useProfileSelection } from "../../context/ProfileContext";
import { useProfileUrlSync } from "../../hooks/useProfileUrlSync";
import ReferenceShareImport from "./ReferenceShareImport";
import ShareBuildExportDialog from "./ShareBuildExportDialog";

const transport = vi.hoisted(() => ({ request: vi.fn(), notifyError: vi.fn() }));
vi.mock("../../api/engineTransport", () => ({ engineFetch: transport.request }));
vi.mock("sonner", () => ({ toast: { error: transport.notifyError } }));
vi.mock("../../hooks/useEngineHealth", () => ({
  useEngineHealth: () => ({ health: { ok: true }, loading: false }),
}));
vi.mock("../../context/AuthContext", () => ({
  useAuth: () => ({ user: null, multiUser: false, loading: false }),
}));
vi.mock("../../hooks/useJobRunner", () => ({
  useJobRunner: () => ({ busy: false, runJob: vi.fn() }),
}));

function profile(id: number, name: string): ProfileSummary {
  return {
    id, name, part_count: 0, order_number: null, special_request: null,
    accepted_progress: { kind: "empty" }, build_stale: false,
    freshness: { status: "untracked", accepted_input_set_id: null, accepted_at: null,
      reasons: [{ kind: "no_accepted_inputs" }] }, archived_at: null, last_used_at: null,
  };
}

const source: SourceSummary = {
  id: 9, name: "Acquired Voron", url: "https://github.com/VoronDesign/Voron-2",
  source_kind: "github", source_type: "github", role: "", category: null,
  branch: "main", tag: null, local_path: null, last_synced_at: null,
  last_commit_sha: null, current_source_revision_id: null, docs_url: null,
  manifest_community_slug: null, metadata: null,
};

const manifest: Extract<ReferenceShare, { kind: "build" }> = {
  format: "printpartner-reference-share", version: 1, kind: "build", title: "Imported Build",
  sources: [{
    key: "source-1", name: "Voron",
    location: { kind: "publisher", url: "https://github.com/VoronDesign/Voron-2" },
    revision: { branch: "main", tag: null, commit: "a".repeat(40) },
    file_rules: ["parts/a.stl"],
  }],
  layers: [{ source: "source-1", role: "base" }], selections: {},
  include: ["parts/a.stl"], exclude: [], replacements: {},
  parts: [{ source: "source-1", path: "parts/a.stl", quantity: 1, included: true, role: "primary", color: null }],
};

function SelectedBuild() {
  useProfileUrlSync();
  const { selectedProfileId, profiles } = useProfileSelection();
  return <>
    <output data-testid="selected-build">{selectedProfileId ?? "none"}</output>
    <output data-testid="build-list">{profiles.map((entry) => entry.name).join(", ")}</output>
    <Outlet />
  </>;
}

let client: QueryClient | undefined;
afterEach(() => {
  cleanup();
  client?.clear();
  sessionStorage.clear();
  vi.clearAllMocks();
});

function PlanWithShareDialog() {
  const { selectedProfileId } = useProfileSelection();
  const [open, setOpen] = useState(true);
  return <>
    <h1>Plan</h1>
    <ShareBuildExportDialog open={open} onOpenChange={setOpen} profileId={selectedProfileId ?? 7} />
  </>;
}

function mountImport(failure?: "import" | "reload", inDialog = false) {
  let serverProfiles = [profile(7, "Existing Build")];
  transport.request.mockImplementation(async (path: string) => {
    if (path === "/plans") {
      if (failure === "reload" && serverProfiles.length > 1) throw new Error("Build list unavailable");
      return { profiles: [...serverProfiles] };
    }
    if (path === "/sources") return { sources: [source] };
    if (/^\/plans\/\d+\/reference-share$/.test(path) || path === "/reference-shares/validate") {
      return { manifest, warnings: ["No model files are included."] };
    }
    if (path === "/reference-shares/dependencies") {
      return { printable: true, dependencies: [{ source_key: "source-1", path: "parts/a.stl", status: "Ready" }] };
    }
    if (path === "/reference-shares/imports") {
      if (failure === "import") throw new Error("Import unavailable");
      serverProfiles = [...serverProfiles, profile(15, "Imported Build")];
      return { profile_id: 15 };
    }
    throw new Error(`Unexpected test request: ${path}`);
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const router = createMemoryRouter([{
    element: <ProfileProvider><SelectedBuild /></ProfileProvider>,
    children: [
      { path: "/board/p1", element: <ReferenceShareImport manifest={manifest} /> },
      { path: "/plan", element: inDialog ? <PlanWithShareDialog /> : <h1>Plan</h1> },
    ],
  }], { initialEntries: [inDialog ? "/plan?profile=7" : "/board/p1?profile=7"] });
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  return { router, serverProfileIds: () => serverProfiles.map((entry) => entry.id) };
}

async function importMappedBuild() {
  await waitFor(() => expect(screen.getByTestId("selected-build").textContent).toBe("7"));
  await screen.findByRole("option", { name: "Acquired Voron" });
  fireEvent.change(screen.getByRole("combobox", { name: "Map Voron" }), { target: { value: "9" } });
  await screen.findByText("parts/a.stl: Ready");
  fireEvent.click(screen.getByRole("button", { name: "Add to my Builds" }));
}

it("opens the imported Build with real profile selection and URL synchronization", async () => {
  const { router, serverProfileIds } = mountImport();
  await importMappedBuild();
  await screen.findByRole("heading", { name: "Plan" });
  expect(serverProfileIds()).toEqual([7, 15]);
  await waitFor(() => expect({
    selected: screen.getByTestId("selected-build").textContent,
    location: `${router.state.location.pathname}${router.state.location.search}`,
    builds: screen.getByTestId("build-list").textContent,
  }).toEqual({
    selected: "15", location: "/plan?profile=15", builds: "Existing Build, Imported Build",
  }));
});

it("keeps a created Build selected when the Build list cannot refresh", async () => {
  const { router, serverProfileIds } = mountImport("reload");
  await importMappedBuild();
  await screen.findByRole("heading", { name: "Plan" });
  await waitFor(() => expect(screen.getByTestId("selected-build").textContent).toBe("15"));
  expect(serverProfileIds()).toEqual([7, 15]);
  expect(router.state.location.search).toBe("?profile=15");
  expect(sessionStorage.getItem("pp-selected-profile-id")).toBe("15");
  expect(screen.getByTestId("build-list").textContent).toBe("Existing Build");
  expect(transport.notifyError).toHaveBeenCalledWith(expect.stringContaining("Build imported, but the Build list could not refresh"));
});

it("keeps the existing Build and source choices after an import failure", async () => {
  const { router, serverProfileIds } = mountImport("import");
  await importMappedBuild();
  expect((await screen.findByRole("alert")).textContent).toBe("Import unavailable");
  expect(serverProfileIds()).toEqual([7]);
  expect(screen.getByTestId("selected-build").textContent).toBe("7");
  expect(`${router.state.location.pathname}${router.state.location.search}`).toBe("/board/p1?profile=7");
  expect(screen.getByRole("combobox", { name: "Map Voron" })).toHaveProperty("value", "9");
  expect(screen.getByRole("button", { name: "Add to my Builds" })).toHaveProperty("disabled", false);
  expect(transport.notifyError).not.toHaveBeenCalled();
});

async function receiveManifest() {
  await screen.findByRole("button", { name: "Download manifest" });
  fireEvent.click(screen.getByText("Validate a received manifest"));
  const file = new File([JSON.stringify(manifest)], "received.json", { type: "application/json" });
  Object.defineProperty(file, "text", { value: async () => JSON.stringify(manifest) });
  fireEvent.change(screen.getByLabelText("Choose reference manifest JSON"), { target: { files: [file] } });
  await screen.findByRole("combobox", { name: "Map Voron" });
}

it("closes the share dialog when importing into the already mounted Plan route", async () => {
  const { router } = mountImport(undefined, true);
  await receiveManifest();
  await importMappedBuild();
  await waitFor(() => expect(router.state.location.search).toBe("?profile=15"));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getByRole("heading", { name: "Plan", level: 1 })).toBeTruthy();
  expect(screen.getByTestId("selected-build").textContent).toBe("15");
});

it("keeps the share dialog and mapping open when import fails", async () => {
  const { router } = mountImport("import", true);
  await receiveManifest();
  await importMappedBuild();
  expect((await screen.findByRole("alert")).textContent).toBe("Import unavailable");
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(screen.getByRole("combobox", { name: "Map Voron" })).toHaveProperty("value", "9");
  expect(router.state.location.search).toBe("?profile=7");
});
