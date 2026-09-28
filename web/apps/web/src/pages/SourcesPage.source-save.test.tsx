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

  async function openArchiveWizard() {
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
  }

  it.each(["before Save", "during Save"])(
    "retries a failed upload against the same Source when the archive is chosen %s",
    async (selectionTime) => {
      const archive = new File(["archive"], "models.zip", { type: "application/zip" });
      browserFiles.pickZipArchive.mockResolvedValue(archive);
      artifacts.importSourceArchive
        .mockRejectedValueOnce(new Error("upload interrupted"))
        .mockResolvedValueOnce({ imported_files: 2, stl_count: 2 });
      await openArchiveWizard();
      if (selectionTime === "before Save") {
        fireEvent.click(screen.getByRole("button", { name: "Choose ZIP…" }));
        expect(await screen.findByText("models.zip")).toBeTruthy();
      }

      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      expect((await screen.findByRole("alert")).textContent).toContain(
        "The Source was created, but its files were not uploaded. upload interrupted Select Save to retry.",
      );
      expect(screen.getByRole("heading", { name: "Edit source" })).toBeTruthy();
      expect(screen.getByText("models.zip")).toBeTruthy();
      expect(api.createSource).toHaveBeenCalledTimes(1);
      expect(artifacts.importSourceArchive).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(artifacts.importSourceArchive).toHaveBeenCalledTimes(2);
      });
      expect(api.createSource).toHaveBeenCalledTimes(1);
      expect(api.updateSource).toHaveBeenCalledWith(12, expect.any(Object));
      expect(browserFiles.pickZipArchive).toHaveBeenCalledTimes(1);
      expect(artifacts.importSourceArchive).toHaveBeenNthCalledWith(1, 12, archive);
      expect(artifacts.importSourceArchive).toHaveBeenNthCalledWith(2, 12, archive);
      await waitFor(() => {
        expect(screen.queryByRole("heading", { name: "Edit source" })).toBeNull();
      });
    },
  );

  it("keeps the draft open when the Save-time archive picker is cancelled", async () => {
    const archive = new File(["archive"], "models.zip", { type: "application/zip" });
    browserFiles.pickZipArchive.mockResolvedValueOnce(null).mockResolvedValueOnce(archive);
    artifacts.importSourceArchive.mockResolvedValue({ imported_files: 2, stl_count: 2 });
    await openArchiveWizard();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect((await screen.findByRole("alert")).textContent).toContain("A ZIP archive is required");
    expect(api.createSource).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Add source" })).toBeTruthy();
    expect(api.updateSource).not.toHaveBeenCalled();
    expect(artifacts.importSourceArchive).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(artifacts.importSourceArchive).toHaveBeenCalledWith(12, archive);
    });
    expect(browserFiles.pickZipArchive).toHaveBeenCalledTimes(2);
    expect(api.createSource).toHaveBeenCalledTimes(1);
    expect(api.updateSource).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Add source" })).toBeNull();
    });
  });
});
