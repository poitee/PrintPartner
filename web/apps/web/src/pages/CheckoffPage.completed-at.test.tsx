// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { PlanReview } from "../api/endpoints/planManifests";
import {
  CHECKOFF_CONSOLE_STORAGE_KEY,
  parseCheckoffConsolePreferences,
} from "../lib/checkoffConsolePreferences";
import CheckoffPage from "./CheckoffPage";

const workspace = vi.hoisted(() => ({
  review: null as PlanReview | null,
  loading: true,
}));

vi.mock("../hooks/useEngineHealth", () => ({
  useEngineHealth: () => ({ health: { ok: true }, error: null, loading: false }),
}));
vi.mock("../components/build/BuildSummaryHeader", () => ({
  default: () => null,
}));
vi.mock("../queries/buildWorkflow", () => ({
  useBuildWorkflowQuery: () => ({ data: undefined, error: null }),
}));
vi.mock("../context/ProfileContext", () => ({
  useProfileSelection: () => ({
    selectedProfileId: 7,
    profiles: [
      {
        id: 7,
        name: "Voron",
        archived_at: null,
        part_count: 1,
        accepted_progress: { kind: "ready" as const, remaining_units: 0, total_units: 1 },
        build_stale: false,
        special_request: null,
      },
    ],
    loading: false,
    error: null,
    reloadProfiles: vi.fn(),
  }),
}));
vi.mock("../context/PlanWorkspaceContext", () => ({
  usePlanWorkspace: () => ({
    review: workspace.review,
    loading: workspace.loading,
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
vi.mock("../api/endpoints/checkoff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/endpoints/checkoff")>();
  return {
    ...actual,
    fetchUnattributedPrints: vi.fn().mockResolvedValue([]),
    fetchPrinterCheckoffLinks: vi.fn().mockResolvedValue({ links: [] }),
  };
});
vi.mock("../api/endpoints/planManifests", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/endpoints/planManifests")>();
  return {
    ...actual,
    fetchPlanPhaseManifest: vi.fn().mockResolvedValue(null),
  };
});
vi.mock("../api/endpoints/productionSend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/endpoints/productionSend")>();
  return {
    ...actual,
    fetchPrinterQueueSuggestions: vi.fn().mockResolvedValue({ suggestions: [] }),
  };
});
vi.mock("../components/checkoff/PrinterLiveStrip", () => ({
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
vi.mock("../components/pwa/PwaInstallBanner", () => ({
  default: () => null,
}));
vi.mock("../components/PlanSpecialRequestLine", () => ({
  default: () => null,
}));

const completedAt = "2026-08-27T10:00:00.000Z";

describe("CheckoffPage completed-at persistence", () => {
  afterEach(cleanup);

  beforeEach(() => {
    workspace.review = null;
    workspace.loading = true;
    localStorage.clear();
    localStorage.setItem(
      CHECKOFF_CONSOLE_STORAGE_KEY,
      JSON.stringify({
        view: null,
        searchByPlanId: {},
        completedAtByPlanId: { "7": completedAt },
        correctionsByPlanId: {},
      }),
    );
  });

  it("does not clear the recorded completion time while the review is still loading", async () => {
    render(
      <MemoryRouter>
        <CheckoffPage />
      </MemoryRouter>,
    );

    expect(screen.getByText("Loading progress…")).toBeTruthy();
    expect(
      parseCheckoffConsolePreferences(localStorage.getItem(CHECKOFF_CONSOLE_STORAGE_KEY))
        .completedAtByPlanId["7"],
    ).toBe(completedAt);
  });
});
