// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { PlanReview, UnattributedPrint } from "../api/engine";
import CheckoffPage from "./CheckoffPage";

const testState = vi.hoisted(() => ({
  onUnattributedUpdate: undefined as ((count?: number) => void) | undefined,
}));

const api = vi.hoisted(() => ({
  fetchUnattributedPrints: vi.fn(),
  fetchPrinterCheckoffLinks: vi.fn().mockResolvedValue({ links: [] }),
  fetchPlanPhaseManifest: vi.fn().mockResolvedValue(null),
  fetchPrinterQueueSuggestions: vi.fn().mockResolvedValue({ suggestions: [] }),
}));

const stalePrint: UnattributedPrint = {
  id: "stale-print",
  integration_id: "prusa-1",
  printer_id: "core-one",
  host_name: "Core One Fixed",
  filename: "cube.bgcode",
  completed_at: "2026-08-19T00:00:00.000Z",
  gcode_objects: ["cube"],
  candidates: [
    {
      stl_basename: "cube",
      copy_count: 1,
      matching_filenames: ["cube.stl"],
    },
  ],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

vi.mock("../hooks/useEngineHealth", () => ({
  useEngineHealth: () => ({ health: { ok: true }, error: null, loading: false }),
}));
vi.mock("../context/ProfileContext", () => ({
  useProfileSelection: () => ({
    selectedProfileId: 7,
    profiles: [
      {
        id: 7,
        name: "Core One plan",
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
    review: {
      profile_id: 7,
      plan_name: "Core One plan",
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
              match_key: "cube",
              relative_path: "parts/cube.stl",
              filename: "cube.stl",
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
              print_units: [true],
              printed_count: 1,
              missing: false,
              filament_display: "PLA",
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
  return { ...actual, ...api };
});
vi.mock("../components/checkoff/PrinterLiveStrip", () => ({
  default: (props: { onUnattributedUpdate?: (count?: number) => void }) => {
    testState.onUnattributedUpdate = props.onUnattributedUpdate;
    return null;
  },
}));
vi.mock("../components/checkoff/UnattributedPrintCard", () => ({
  default: ({ print }: { print: UnattributedPrint }) => (
    <div>Unclaimed print detected {print.host_name} · {print.filename}</div>
  ),
}));
vi.mock("../components/checkoff/SortableProgressPart", () => ({
  default: (props: {
    kind: "part" | "bag";
    suggestedPrinter?: { hostName: string; filename: string };
  }) =>
    props.kind === "part" && props.suggestedPrinter ? (
      <div>
        Possibly on {props.suggestedPrinter.hostName} ({props.suggestedPrinter.filename})
      </div>
    ) : null,
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

describe("CheckoffPage unattributed print reconciliation", () => {
  beforeEach(() => {
    testState.onUnattributedUpdate = undefined;
    api.fetchUnattributedPrints.mockReset();
    api.fetchUnattributedPrints.mockResolvedValue([stalePrint]);
    localStorage.clear();
    localStorage.setItem("print-partner.checkoff.ui.v1", JSON.stringify({ filter: "all" }));
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("keeps printer A's unclaimed print when printer B reports zero", async () => {
    render(
      <MemoryRouter>
        <CheckoffPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/Unclaimed print detected/)).toBeTruthy();
    expect(screen.getByText(/Possibly on Core One Fixed/)).toBeTruthy();

    act(() => testState.onUnattributedUpdate?.(0));

    await waitFor(() => {
      expect(api.fetchUnattributedPrints).toHaveBeenCalledTimes(2);
      expect(screen.getByText(/Unclaimed print detected/)).toBeTruthy();
      expect(screen.getByText(/Possibly on Core One Fixed/)).toBeTruthy();
    });
  });

  it("refetches open records when reconcile reports a nonzero count", async () => {
    api.fetchUnattributedPrints
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([stalePrint]);

    render(
      <MemoryRouter>
        <CheckoffPage />
      </MemoryRouter>,
    );

    await waitFor(() => expect(api.fetchUnattributedPrints).toHaveBeenCalledOnce());
    expect(screen.queryByText(/Unclaimed print detected/)).toBeNull();

    act(() => testState.onUnattributedUpdate?.(1));

    expect(await screen.findByText(/Unclaimed print detected/)).toBeTruthy();
    expect(screen.getByText(/Possibly on Core One Fixed/)).toBeTruthy();
  });

  it("ignores an older global response that resolves after a newer empty response", async () => {
    const staleResponse = deferred<UnattributedPrint[]>();
    const emptyResponse = deferred<UnattributedPrint[]>();
    api.fetchUnattributedPrints
      .mockResolvedValueOnce([])
      .mockReturnValueOnce(staleResponse.promise)
      .mockReturnValueOnce(emptyResponse.promise);

    render(
      <MemoryRouter>
        <CheckoffPage />
      </MemoryRouter>,
    );

    await waitFor(() => expect(api.fetchUnattributedPrints).toHaveBeenCalledOnce());

    act(() => testState.onUnattributedUpdate?.(1));
    await waitFor(() => expect(api.fetchUnattributedPrints).toHaveBeenCalledTimes(2));

    act(() => testState.onUnattributedUpdate?.(1));
    await waitFor(() => expect(api.fetchUnattributedPrints).toHaveBeenCalledTimes(3));

    await act(async () => {
      emptyResponse.resolve([]);
      await emptyResponse.promise;
    });
    await act(async () => {
      staleResponse.resolve([stalePrint]);
      await staleResponse.promise;
    });

    await waitFor(() => {
      expect(screen.queryByText(/Unclaimed print detected/)).toBeNull();
      expect(screen.queryByText(/Possibly on Core One Fixed/)).toBeNull();
    });
  });
});
