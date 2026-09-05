// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceSummary } from "@print-partner/contracts";
import BuildPage from "./BuildPage";

const mocks = vi.hoisted(() => ({
  setBase: vi.fn(),
  replace: vi.fn(),
  remove: vi.fn(),
  add: vi.fn(),
  sync: vi.fn(),
  refresh: vi.fn(),
  flush: vi.fn(),
  planning: vi.fn(),
}));

const sources: SourceSummary[] = [1, 2, 3].map((id) => ({
  id,
  name: `Project ${id}`,
  url: `https://github.com/example/project-${id}`,
  source_kind: "github",
  source_type: "git",
  role: "base",
  category: null,
  branch: "main",
  tag: null,
  local_path: null,
  content_available: true,
  last_synced_at: "2026-09-01T00:00:00Z",
  last_commit_sha: "1234567",
  current_source_revision_id: id,
  docs_url: null,
  manifest_community_slug: null,
  metadata: null,
  update_status: id === 2 ? "updates_available" : "up_to_date",
}));
const layers = [
  { id: 10, layer_order: 0, layer_type: "base", project_id: 1, project_name: "Project 1" },
  { id: 11, layer_order: 1, layer_type: "addon", project_id: 2, project_name: "Project 2" },
];

vi.mock("../context/ProfileContext", () => ({
  useProfileSelection: () => ({
    selectedProfileId: 7,
    profiles: [{ id: 7, name: "Test Build", freshness: { status: "current" } }],
    loading: false,
    error: null,
    reloadProfiles: mocks.refresh,
  }),
}));
vi.mock("../context/PlanActionsContext", () => ({
  usePlanActions: () => ({}),
}));
vi.mock("../context/PlanWorkspaceContext", () => ({
  usePlanWorkspace: () => ({ review: null, refresh: mocks.refresh }),
}));
vi.mock("../context/ImportRulesSaveContext", () => ({
  useImportRulesSaveRegistry: () => ({ flushAll: mocks.flush }),
}));
vi.mock("../context/KitManifestSaveContext", () => ({
  useKitManifestSaveRegistry: () => ({ flushAll: mocks.flush }),
}));
vi.mock("../hooks/useEngineHealth", () => ({
  useEngineHealth: () => ({ health: { ok: true }, error: null, loading: false }),
}));
vi.mock("../hooks/useJobRunner", () => ({
  useJobRunner: () => ({ busy: false, runJob: (start: () => Promise<string>) => start() }),
}));
vi.mock("../api/endpoints/jobs", () => ({ startSync: mocks.sync }));
vi.mock("../queries/sources", () => ({
  useSourcesQuery: () => ({ data: sources, isLoading: false, refetch: mocks.refresh }),
}));
vi.mock("../queries/sourceCategories", () => ({
  useSourceCategoriesQuery: () => ({ data: [] }),
}));
vi.mock("../queries/planLayers", () => ({
  usePlanLayersQuery: () => ({ data: layers, isLoading: false, refetch: mocks.refresh }),
  useSetPlanBaseLayerMutation: () => ({ mutateAsync: mocks.setBase }),
  useReplacePlanLayerMutation: () => ({ mutateAsync: mocks.replace }),
  useDeletePlanLayerMutation: () => ({ mutateAsync: mocks.remove }),
  useAddPlanAddonLayerMutation: () => ({ mutateAsync: mocks.add }),
  invalidatePlanStructure: mocks.refresh,
}));
vi.mock("../queries/externalAccess", () => ({
  useExternalAccessSettingsQuery: () => ({ data: { mode: "disabled" } }),
}));
vi.mock("../components/build/useBuildPlanningQuery", () => ({
  useBuildPlanningQuery: mocks.planning,
}));
vi.mock("../components/SourceCardCover", () => ({ default: () => null }));
vi.mock("../components/PlanSpecialRequestField", () => ({ default: () => <input aria-label="Special request" /> }));
vi.mock("../components/build/BuildRecipePanel", () => ({ default: () => null }));
vi.mock("../components/sources/SourceCategorySheet", () => ({ default: () => null }));

function renderSources() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}><BuildPage /></QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.planning.mockReturnValue({ data: null });
  mocks.sync.mockResolvedValue("sync-job");
});
afterEach(cleanup);

describe("Sources workspace", () => {
  it("puts Library attachments first and leaves print choices on Plan", () => {
    renderSources();

    expect(screen.getByRole("heading", { name: "Sources" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Attach from Library" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Plan" }).getAttribute("href")).toBe("/plan?profile=7");
    expect(screen.getByText("Add sources and their files in the Source Library, then attach them to this Build here. Choose files, quantities, and colors on Plan.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Add sources to Library" }).getAttribute("href")).toBe("/library");
    expect(screen.queryByText(/Choose print files|Materials and colors|Kit variants|Working Plan|Published revision/)).toBeNull();
    expect(mocks.planning).toHaveBeenCalledWith({ planId: 7, enabled: false });
  });

  it("replaces and removes only the selected Build attachment", async () => {
    renderSources();
    fireEvent.change(screen.getByRole("combobox", { name: "Change Project 2 source" }), { target: { value: "3" } });
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith({ layerId: 11, sourceId: 3 }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith(11));
    expect(mocks.setBase).not.toHaveBeenCalled();
  });

  it("syncs updated sources without treating hidden local paths as missing content", async () => {
    renderSources();
    fireEvent.click(screen.getByRole("button", { name: "Sync sources" }));
    await waitFor(() => expect(mocks.sync).toHaveBeenCalledWith([2]));
  });
});
