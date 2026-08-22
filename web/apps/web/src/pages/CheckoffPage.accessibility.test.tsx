// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { PlanReview } from "../api/engine";
import CheckoffPage from "./CheckoffPage";

const state = vi.hoisted(() => ({
  profiles: [
    {
      id: 7,
      name: "Voron",
      archived_at: null,
      part_count: 1,
      accepted_progress: { kind: "ready" as const, remaining_units: 1, total_units: 1 },
      build_stale: false,
      special_request: null,
    },
  ],
  profilesLoading: false,
  profilesError: null as string | null,
}));

vi.mock("../hooks/useEngineHealth", () => ({
  useEngineHealth: () => ({ health: { ok: true }, error: null, loading: false }),
}));
vi.mock("../context/ProfileContext", () => ({
  useProfileSelection: () => ({
    selectedProfileId: 7,
    profiles: state.profiles,
    loading: state.profilesLoading,
    error: state.profilesError,
    reloadProfiles: vi.fn(),
  }),
}));
vi.mock("../context/PlanWorkspaceContext", () => ({
  usePlanWorkspace: () => ({
    review: {
      profile_id: 7,
      plan_name: "Voron",
      layers: [],
      totals: {
        included_parts: 1,
        total_print_units: 1,
        by_role: {},
        by_filament: {},
      },
      issues: [],
      has_blockers: false,
      part_groups: [
        {
          folder: "(root)",
          source_layer: "base:kit",
          parts: [
            {
              id: 11,
              match_key: "gantry",
              relative_path: "parts/gantry.stl",
              filename: "gantry.stl",
              source_layer: "base:kit",
              status: "ok",
              role: "primary",
              requirement: null,
              option_group_id: null,
              included: true,
              filament_color_id: null,
              quantity_auto: 1,
              quantity_override: null,
              quantity_effective: 1,
              print_units: [false],
              printed_count: 0,
              missing: true,
              filament_display: "ABS",
            },
          ],
        },
      ],
    } as unknown as PlanReview,
    loading: false,
    error: null,
    refresh: vi.fn(),
    toggleUnit: vi.fn(),
    toggleAssembled: vi.fn(),
    busyPartId: null,
  }),
}));
vi.mock("../hooks/useJobRunner", () => ({
  useJobRunner: () => ({ busy: false, runJob: vi.fn() }),
}));
vi.mock("../hooks/useMediaQuery", () => ({
  useMediaQuery: () => false,
}));
vi.mock("../queries/buildTracking", () => ({
  useBuildTrackingSettingsQuery: () => ({
    data: { assembly_tracking: false },
    error: null,
  }),
}));
vi.mock("../lib/useSyncComplete", () => ({ useSyncComplete: vi.fn() }));
vi.mock("../api/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/engine")>();
  return {
    ...actual,
    fetchUnattributedPrints: vi.fn().mockResolvedValue([]),
    fetchPrinterCheckoffLinks: vi.fn().mockResolvedValue({ links: [] }),
    fetchPlanPhaseManifest: vi.fn().mockResolvedValue(null),
    fetchPrinterQueueSuggestions: vi.fn().mockResolvedValue({ suggestions: [] }),
  };
});
vi.mock("../components/checkoff/PrinterLiveStrip", () => ({
  default: () => null,
}));
vi.mock("../components/checkoff/PrinterQueueSuggestionBanner", () => ({
  default: () => null,
}));
vi.mock("../components/export/PrinterSendQueuePanel", () => ({
  default: () => null,
}));
vi.mock("../components/checkoff/PrintVerifyPanel", () => ({
  default: () => null,
}));
vi.mock("../components/checkoff/UnattributedPrintCard", () => ({
  default: () => null,
}));
vi.mock("../components/checkoff/SortableProgressPart", () => ({
  default: () => null,
}));
vi.mock("../components/checkoff/PhaseProgressView", () => ({
  default: () => null,
}));
vi.mock("../components/parts/PartPreviewDialog", () => ({
  default: () => null,
}));
vi.mock("../components/parts/PartThumbExpandButton", () => ({
  default: () => <button type="button">Preview</button>,
}));
vi.mock("../components/SpoolRemainingBadge", () => ({
  default: () => null,
}));
vi.mock("../components/pwa/PwaInstallBanner", () => ({
  default: () => null,
}));
vi.mock("../components/PlanFreshnessNotice", () => ({
  default: () => null,
}));
vi.mock("../components/PlanSpecialRequestLine", () => ({
  default: () => null,
}));

describe("CheckoffPage accessibility", () => {
  afterEach(cleanup);

  beforeEach(() => {
    state.profiles = [
      {
        id: 7,
        name: "Voron",
        archived_at: null,
        part_count: 1,
        accepted_progress: { kind: "ready" as const, remaining_units: 1, total_units: 1 },
        build_stale: false,
        special_request: null,
      },
    ];
    state.profilesLoading = false;
    state.profilesError = null;
    localStorage.clear();
  });

  it("names the progress parts search", () => {
    render(
      <MemoryRouter>
        <CheckoffPage />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("searchbox", { name: "Search progress parts" }).tagName,
    ).toBe("INPUT");
  });

  it("keeps the printable sheet hierarchy subordinate to the single page h1", () => {
    const { container } = render(
      <MemoryRouter>
        <CheckoffPage />
      </MemoryRouter>,
    );

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Checkoff");
    const printTitle = container.querySelector(".sheet-title");
    const repositoryTitle = container.querySelector(".sheet-repo-title");
    const folderTitle = container.querySelector(".sheet-folder-title");
    expect(printTitle?.tagName).toBe("H2");
    expect(printTitle?.textContent).toBe("Voron");
    expect(repositoryTitle?.tagName).toBe("H3");
    expect(folderTitle?.tagName).toBe("H4");
  });

  it("announces initial progress failures as alerts", () => {
    state.profiles = [];
    state.profilesError = "profiles unavailable";

    render(
      <MemoryRouter>
        <CheckoffPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "Could not load plans: profiles unavailable",
    );
  });
});
