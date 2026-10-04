// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import KitManifestOptions from "./KitManifestOptions";
import ShareImportSetupPanel from "./share/ShareImportSetupPanel";

vi.mock("../api/endpoints/sources", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/endpoints/sources")>();
  return {
    ...actual,
    fetchStlTree: vi.fn().mockResolvedValue({
      selected: 0,
      total: 0,
      tree: [],
      rules: [],
    }),
  };
});

vi.mock("../api/endpoints/planManifests", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/endpoints/planManifests")>();
  return {
    ...actual,
    fetchPlanManifestBuilder: vi.fn().mockResolvedValue({
      merged_option_groups: {
        size: {
          rule: "pick_one",
          label: "Size",
          parts: [],
          variants: [{ id: "250", label: "250 mm", parts: [] }],
        },
      },
    }),
    fetchPlanKitManifest: vi.fn().mockResolvedValue({
      profile_id: 7,
      selections: { size: "250" },
    }),
  };
});
vi.mock("../context/DateFormatContext", () => ({
  useDateFormat: () => ({ formatDate: () => "today" }),
}));
vi.mock("../context/JobContext", () => ({
  useJobContext: () => ({ activeJobs: [] }),
}));
vi.mock("../context/BuildSaveFlushContext", () => ({
  useBuildSaveFlushRegistry: () => vi.fn(() => vi.fn()),
}));
vi.mock("../hooks/useKitManifestAutosave", () => ({
  useKitManifestAutosave: () => ({
    dirty: false,
    status: "idle",
    saveNow: vi.fn(),
    saveUserEdit: vi.fn(),
  }),
}));
vi.mock("./ImportRulesTree", () => ({ default: () => <div>Import rules</div> }));
vi.mock("./SourceCardCover", () => ({ default: () => null }));
vi.mock("./parts/PartPreviewDialog", () => ({ default: () => null }));
vi.mock("./Preview3D", () => ({
  default: ({ instructions }: { instructions?: string }) => (
    <div data-testid="compact-preview" data-instructions={instructions} />
  ),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

describe("Build heading hierarchy", () => {
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
  });

  it("uses an h2 for the direct share-import section", () => {
    render(
      <MemoryRouter>
        <ShareImportSetupPanel
          unmatchedSources={[]}
          warnings={["Missing source"]}
          profileId={7}
        />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("heading", { level: 2, name: "Share import setup" }).tagName,
    ).toBe("H2");
  });

  it("names the global source-management destination Source Library", () => {
    render(
      <MemoryRouter>
        <ShareImportSetupPanel
          unmatchedSources={[
            {
              name: "Voron parts",
              url: "https://github.com/example/voron-parts",
              branch: "main",
              source_kind: "github",
              role: "base",
              import_rules: [],
            },
          ]}
          warnings={[]}
          profileId={7}
        />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("link", { name: "Manage in Source Library" }).getAttribute("href"),
    ).toBe("/library");
  });

  it("provides the missing compact kit title before its option-group headings", async () => {
    render(
      <MemoryRouter>
        <KitManifestOptions profileId={7} baseSourceName="Voron" compact />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("heading", {
        level: 3,
        name: "Voron kit variants",
      }),
    ).not.toBeNull();
    expect(screen.getByRole("heading", { level: 4, name: "Size" }).tagName).toBe(
      "H4",
    );
  });
});
