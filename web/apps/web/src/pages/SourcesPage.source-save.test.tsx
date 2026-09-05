// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { SourceSummary } from "@print-partner/contracts";
import SourcesPage from "./SourcesPage";

const { api, artifacts, browserFiles, createdSource } = vi.hoisted(() => {
  const createdSource: SourceSummary = {
    id: 12,
    name: "Archive Source",
    url: "",
    source_kind: "archive",
    source_type: "archive",
    role: "",
    category: null,
    branch: "main",
    tag: null,
    local_path: null,
    last_synced_at: null,
    last_commit_sha: null,
    current_source_revision_id: null,
    docs_url: null,
    manifest_community_slug: null,
    metadata: null,
  };
  return {
    createdSource,
    api: {
      fetchSources: vi.fn(),
      fetchSourceCategories: vi.fn(),
      createSource: vi.fn(),
      updateSource: vi.fn(),
    },
    artifacts: { importSourceArchive: vi.fn() },
    browserFiles: { pickZipArchive: vi.fn() },
  };
});

vi.mock("../api/endpoints/sources", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/endpoints/sources")>();
  return { ...actual, ...api };
});
vi.mock("../api/endpoints/sourceArtifacts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/endpoints/sourceArtifacts")>();
  return { ...actual, ...artifacts };
});
vi.mock("../api/endpoints/browserFiles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/endpoints/browserFiles")>();
  return { ...actual, ...browserFiles };
});
vi.mock("../hooks/useEngineHealth", () => ({
  useEngineHealth: () => ({ health: { ok: true }, error: null, loading: false }),
}));
vi.mock("../hooks/useJobRunner", () => ({
  useJobRunner: () => ({ busy: false, runJob: vi.fn() }),
}));
vi.mock("../hooks/useImportSharedBuild", () => ({
  useImportSharedBuild: () => vi.fn(),
}));
vi.mock("../context/DateFormatContext", () => ({
  useDateFormat: () => ({ formatDate: (value: string) => value }),
}));
vi.mock("../context/JobContext", () => ({
  useJobContext: () => ({ activeJobs: [] }),
}));
vi.mock("../context/PlanWorkspaceContext", () => ({
  usePlanWorkspace: () => ({ review: null }),
}));
vi.mock("../context/ProfileContext", () => ({
  useProfileSelection: () => ({ profiles: [], selectedProfileId: null }),
}));
vi.mock("../components/sources/SourceDetailSheet", () => ({ default: () => null }));
vi.mock("../components/sources/SourceWatchPanel", () => ({ default: () => null }));

describe("SourcesPage source creation", () => {
  beforeEach(() => {
    api.fetchSources.mockReset();
    api.fetchSourceCategories.mockReset();
    api.createSource.mockReset();
    api.updateSource.mockReset();
    artifacts.importSourceArchive.mockReset();
    browserFiles.pickZipArchive.mockReset();

    api.fetchSources.mockResolvedValue([]);
    api.fetchSourceCategories.mockResolvedValue([]);
    api.createSource.mockResolvedValue(createdSource);
    api.updateSource.mockResolvedValue(createdSource);
    browserFiles.pickZipArchive.mockResolvedValue(
      new File(["archive"], "models.zip", { type: "application/zip" }),
    );
  });

  afterEach(cleanup);

  it("retries a failed upload against the Source that was already created", async () => {
    artifacts.importSourceArchive
      .mockRejectedValueOnce(new Error("upload interrupted"))
      .mockResolvedValueOnce({ imported_files: 2, stl_count: 2 });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <SourcesPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    fireEvent.pointerDown(await screen.findByRole("button", { name: "Add source" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Zip upload" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Archive Source" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Choose ZIP…" }));
    expect(await screen.findByText("models.zip")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "The Source was created, but its files were not uploaded. upload interrupted Select Save to retry.",
    );
    expect(screen.getByRole("heading", { name: "Edit source" })).toBeTruthy();
    expect(api.createSource).toHaveBeenCalledTimes(1);
    expect(artifacts.importSourceArchive).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(artifacts.importSourceArchive).toHaveBeenCalledTimes(2);
    });
    expect(api.createSource).toHaveBeenCalledTimes(1);
    expect(api.updateSource).toHaveBeenCalledWith(12, expect.any(Object));
  });
});
