// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import type { PlanReview, ReviewPart } from "../api/endpoints/planManifests";
import type { PlanPhaseManifestResponse } from "../api/endpoints/planVariants";
import CheckoffPage from "./CheckoffPage";

const state = vi.hoisted(() => ({
  completed: false,
  reviewParts: null as ReviewPart[] | null,
  phaseManifest: null as PlanPhaseManifestResponse | null,
  selectedProfileId: 7,
  toggleUnit: vi.fn().mockResolvedValue(undefined),
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
vi.mock("../components/build/BuildSummaryHeader", () => ({
  default: () => null,
}));
vi.mock("../queries/buildWorkflow", () => ({
  useBuildWorkflowQuery: () => ({ data: undefined, error: null }),
}));
vi.mock("../context/ProfileContext", () => ({
  useProfileSelection: () => ({
    selectedProfileId: state.selectedProfileId,
    profiles: state.profiles,
    loading: state.profilesLoading,
    error: state.profilesError,
    reloadProfiles: vi.fn(),
  }),
}));
vi.mock("../context/PlanWorkspaceContext", () => ({
  usePlanWorkspace: () => {
    const secondBuild = state.selectedProfileId === 8;
    const defaultPart = {
      id: secondBuild ? 22 : 11,
      match_key: secondBuild ? "badge" : "gantry",
      relative_path: secondBuild ? "parts/badge.stl" : "parts/gantry.stl",
      filename: secondBuild ? "badge.stl" : "gantry.stl",
      source_layer: "base:kit",
      status: "ok",
      role: "primary",
      requirement: null,
      option_group_id: null,
      included: true,
      filament_color_id: null,
      quantity_auto: 1,
      quantity_override: null,
      quantity_effective: state.completed ? 4 : 1,
      print_units: state.completed ? [true, true, true, true] : [false],
      printed_count: state.completed ? 4 : 0,
      missing: !state.completed,
      filament_display: "ABS",
    };
    const parts = state.reviewParts ?? [defaultPart];
    return {
      review: {
        profile_id: state.selectedProfileId,
        plan_name: secondBuild ? "Switchwire" : "Voron",
        layers: [],
        totals: {
          included_parts: parts.length,
          total_print_units: parts.reduce((total, part) => total + part.quantity_effective, 0),
          by_role: {},
          by_filament: {},
        },
        issues: [],
        has_blockers: false,
        part_groups: [
          {
            folder: "(root)",
            source_layer: "base:kit",
            parts,
          },
        ],
      } as unknown as PlanReview,
      loading: false,
      error: null,
      refresh: vi.fn(),
      toggleUnit: state.toggleUnit,
      toggleAssembled: vi.fn(),
      busyPartId: null,
    };
  },
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

vi.mock("../api/endpoints/planVariants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/endpoints/planVariants")>();
  return {
    ...actual,
    fetchPlanPhaseManifest: vi.fn(async () => state.phaseManifest),
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
  default: ({ part, onSetAllPrinted }: { part: ReviewPart; onSetAllPrinted: (part: ReviewPart, completed: boolean) => void }) => (
    <div>
      <span>{part.filename}</span>
      <button onClick={() => onSetAllPrinted(part, false)}>Clear all test copies</button>
    </div>
  ),
}));
vi.mock("../components/checkoff/PhaseProgressView", () => ({
  default: ({
    phases,
  }: {
    phases: Array<{ phase: { name: string }; parts: ReviewPart[] }>;
  }) => (
    <section aria-label="Phase progress">
      {phases.map(({ phase, parts }) => (
        <div key={phase.name}>
          <h2>{phase.name}</h2>
          {parts.map((part) => (
            <span key={part.id}>{part.filename}</span>
          ))}
        </div>
      ))}
    </section>
  ),
}));
vi.mock("../components/checkoff/PastPrintIntakePanel", () => ({
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
vi.mock("../components/PlanSpecialRequestLine", () => ({
  default: () => null,
}));

function PastPrintRouteControls() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="location">
        {location.pathname}
        {location.search}
      </output>
      <button data-testid="follow-checkoff-link" onClick={() => navigate("/progress?profile=7")}>
        Follow Checkoff link
      </button>
      <button data-testid="back" onClick={() => navigate(-1)}>
        Back
      </button>
      <button data-testid="forward" onClick={() => navigate(1)}>
        Forward
      </button>
    </>
  );
}

describe("CheckoffPage accessibility", () => {
  afterEach(cleanup);

  beforeEach(() => {
    state.completed = false;
    state.reviewParts = null;
    state.phaseManifest = null;
    state.selectedProfileId = 7;
    state.toggleUnit.mockReset().mockResolvedValue(undefined);
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

  it("requires a correction reason before clearing all tracked copies", async () => {
    state.completed = true;
    localStorage.setItem("print-partner.checkoff.console.v1", JSON.stringify({ view: "completed" }));
    render(<MemoryRouter><CheckoffPage /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: /^Completed/ }));
    fireEvent.click(await screen.findByText("Clear all test copies"));
    expect(screen.getByRole("dialog").textContent).toContain("Clear all printed copies of gantry.stl");
    expect(state.toggleUnit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
    expect(state.toggleUnit).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "recount" } });
    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
    await waitFor(() => expect(state.toggleUnit).toHaveBeenCalledExactlyOnceWith(11, 0, false));
    expect(localStorage.getItem("print-partner.checkoff.console.v1")).toContain('"reason":"recount"');
  });

  it("keeps a failed correction draft available and records it only after retry succeeds", async () => {
    state.completed = true;
    state.toggleUnit
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined);
    localStorage.setItem("print-partner.checkoff.console.v1", JSON.stringify({ view: "completed" }));
    render(<MemoryRouter><CheckoffPage /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: /^Completed/ }));
    fireEvent.click(await screen.findByText("Clear all test copies"));
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "wrong_row" },
    });
    fireEvent.change(screen.getByLabelText("Note (optional)"), {
      target: { value: "Badge was another Build" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));

    const failedDialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(within(failedDialog).getByRole("alert").textContent).toContain(
        "Could not save the correction for gantry.stl: offline",
      ),
    );
    expect((screen.getByLabelText("Reason") as HTMLSelectElement).value).toBe("wrong_row");
    expect((screen.getByLabelText("Note (optional)") as HTMLInputElement).value).toBe(
      "Badge was another Build",
    );
    expect(localStorage.getItem("print-partner.checkoff.console.v1")).not.toContain(
      '"reason":"wrong_row"',
    );

    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(state.toggleUnit).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem("print-partner.checkoff.console.v1")).toContain(
      '"reason":"wrong_row"',
    );
    expect(localStorage.getItem("print-partner.checkoff.console.v1")).toContain(
      '"note":"Badge was another Build"',
    );
  });

  it("ignores a late failed save after switching Builds and opening another correction", async () => {
    state.completed = true;
    let rejectSave = (_error: Error) => {};
    state.toggleUnit.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSave = reject;
        }),
    );
    state.profiles = [
      ...state.profiles,
      {
        id: 8,
        name: "Switchwire",
        archived_at: null,
        part_count: 1,
        accepted_progress: { kind: "ready" as const, remaining_units: 0, total_units: 4 },
        build_stale: false,
        special_request: null,
      },
    ];
    localStorage.setItem("print-partner.checkoff.console.v1", JSON.stringify({ view: "completed" }));
    const { rerender } = render(<MemoryRouter><CheckoffPage /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: /^Completed/ }));
    fireEvent.click(await screen.findByText("Clear all test copies"));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "recount" } });
    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
    await waitFor(() => expect(state.toggleUnit).toHaveBeenCalledOnce());

    state.selectedProfileId = 8;
    rerender(<MemoryRouter><CheckoffPage /></MemoryRouter>);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /^Completed/ }));
    fireEvent.click(await screen.findByText("Clear all test copies"));
    expect(screen.getByRole("dialog").textContent).toContain(
      "Clear all printed copies of badge.stl",
    );

    await act(async () => rejectSave(new Error("old Build offline")));

    const currentDialog = screen.getByRole("dialog");
    expect(currentDialog.textContent).toContain("Clear all printed copies of badge.stl");
    expect(within(currentDialog).queryByRole("alert")).toBeNull();
    expect((within(currentDialog).getByLabelText("Reason") as HTMLSelectElement).value).toBe("");
    expect(localStorage.getItem("print-partner.checkoff.console.v1")).not.toContain(
      '"reason":"recount"',
    );
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

  it("uses the filtered Remaining worklist while searching a phased Build", async () => {
    state.reviewParts = [
      {
        id: 11,
        match_key: "accessory-badge",
        relative_path: "foundation/accessory_badge.stl",
        filename: "accessory_badge.stl",
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
      {
        id: 12,
        match_key: "frame",
        relative_path: "assembly/frame.stl",
        filename: "frame.stl",
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
      {
        id: 13,
        match_key: "accessory-badge-finished",
        relative_path: "assembly/accessory_badge_finished.stl",
        filename: "accessory_badge_finished.stl",
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
        filament_display: "ABS",
      },
    ];
    state.phaseManifest = {
      profile_id: 7,
      has_phases: true,
      phases: [
        {
          name: "Foundation",
          order: 1,
          folders: ["foundation"],
          depends_on: [],
        },
        {
          name: "Assembly",
          order: 2,
          folders: ["assembly"],
          depends_on: ["Foundation"],
        },
      ],
    };
    localStorage.setItem(
      "print-partner.checkoff.console.v1",
      JSON.stringify({ view: "remaining", sort: "manual" }),
    );

    render(
      <MemoryRouter>
        <CheckoffPage />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("region", { name: "Phase progress" })).toBeTruthy();

    const search = screen.getByRole("searchbox", { name: "Search progress parts" });
    fireEvent.change(search, { target: { value: "badge" } });

    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Phase progress" })).toBeNull(),
    );
    expect(screen.getByText("accessory_badge.stl")).toBeTruthy();
    expect(screen.queryByText("frame.stl")).toBeNull();
    expect(screen.queryByText("accessory_badge_finished.stl")).toBeNull();

    fireEvent.change(search, { target: { value: "no-match" } });
    expect(await screen.findByText("No parts match")).toBeTruthy();

    fireEvent.change(search, { target: { value: "" } });
    expect(await screen.findByRole("region", { name: "Phase progress" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Foundation" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Assembly" })).toBeTruthy();
  });

  it("keeps the past-print dialog synchronized with route navigation and explicit close", async () => {
    render(
      <MemoryRouter initialEntries={["/progress?profile=7&add=past-print"]}>
        <CheckoffPage />
        <PastPrintRouteControls />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("heading", { name: "Add a past print to Voron" }),
    ).toBeTruthy();

    fireEvent.click(screen.getByTestId("follow-checkoff-link"));
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "Add a past print to Voron" }),
      ).toBeNull(),
    );

    fireEvent.click(screen.getByTestId("back"));
    expect(
      await screen.findByRole("heading", { name: "Add a past print to Voron" }),
    ).toBeTruthy();

    fireEvent.click(screen.getByTestId("forward"));
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "Add a past print to Voron" }),
      ).toBeNull(),
    );

    fireEvent.click(screen.getByTestId("back"));
    fireEvent.click(await screen.findByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe("/progress?profile=7");
      expect(
        screen.queryByRole("heading", { name: "Add a past print to Voron" }),
      ).toBeNull();
    });
  });

  it("persists source/directory sorting and restores manual bag controls", () => {
    const { unmount } = render(<MemoryRouter><CheckoffPage /></MemoryRouter>);
    const sort = screen.getByRole("combobox", { name: "Sort by" });
    fireEvent.change(sort, { target: { value: "directory" } });
    expect(screen.queryByRole("button", { name: "Add bag" })).toBeNull();
    expect(state.toggleUnit).not.toHaveBeenCalled();
    unmount();
    render(<MemoryRouter><CheckoffPage /></MemoryRouter>);
    const restored = screen.getByRole("combobox", { name: "Sort by" });
    if (!(restored instanceof HTMLSelectElement)) throw new Error("Expected a sort selector");
    expect(restored.value).toBe("directory");
    fireEvent.change(screen.getByRole("combobox", { name: "Sort by" }), { target: { value: "manual" } });
    expect(screen.getByRole("button", { name: "Add bag" })).toBeTruthy();
  });

  it("keeps the accepted Checkoff sheet printable when the current view filters out every row", () => {
    state.profiles[0]!.build_stale = true;
    localStorage.setItem(
      "print-partner.checkoff.console.v1",
      JSON.stringify({
        view: "remaining",
        searchByPlanId: { "7": "no matching accepted part" },
        completedAtByPlanId: {},
        correctionsByPlanId: {},
      }),
    );

    const { container } = render(
      <MemoryRouter>
        <CheckoffPage />
      </MemoryRouter>,
    );

    expect(
      (screen.getByRole("button", { name: "Print sheet" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(container.querySelector(".sheet-title")?.textContent).toBe("Voron");
    expect(container.querySelector(".sheet-row")).not.toBeNull();
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
