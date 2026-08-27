// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AcceptedPlateExportRecord,
  AcceptedPlateWorkspace,
  RequiredUnitToken,
} from "@print-partner/contracts";
import type { PrinterCheckoffLink } from "../api/endpoints/checkoff";

const TOKEN_A = `ppu_${"a".repeat(32)}` as RequiredUnitToken;
const TOKEN_B = `ppu_${"b".repeat(32)}` as RequiredUnitToken;

const basis = {
  profile_id: 1,
  plan_version: 1,
  plan_revision_id: 5,
  plan_revision_digest: "0".repeat(64),
  required_unit_mapping_digest: "1".repeat(64),
};

const printer = {
  id: "printer-1",
  name: "Voron 350",
  model: "Voron 2.4",
  bed_width_um: 350_000,
  bed_depth_um: 350_000,
  bed_height_um: 330_000,
  margin_um: 4_000,
};

function unit(token: RequiredUnitToken) {
  return {
    token,
    object_name: `bracket__${token}`,
    filename: "bracket.stl",
    relative_path: "",
    source_directory: "",
    source_layer: "kit",
    role: "accent",
    filament_color_id: null,
    completed: false,
    x_um: 10_000,
    y_um: 10_000,
    width_um: 20_000,
    depth_um: 20_000,
    height_um: 20_000,
    placement: "auto" as const,
    pinned: false,
  };
}

const readyWorkspace = {
  kind: "ready",
  basis,
  plate_revision_id: 42,
  plate_revision_number: 2,
  arrange_undo_revision_id: null,
  printers: [printer],
  plates: [{ plate_id: "plate_1", ordinal: 1, printer, units: [unit(TOKEN_A), unit(TOKEN_B)] }],
  unplaced: [],
  unassigned: [],
} as unknown as AcceptedPlateWorkspace;

const state = {
  workspace: readyWorkspace as AcceptedPlateWorkspace | undefined,
  exportRecords: [] as AcceptedPlateExportRecord[],
  checkoffLinks: [] as PrinterCheckoffLink[],
};

vi.mock("../components/build/BuildSummaryHeader", () => ({
  default: () => <div data-testid="build-summary-header" />,
}));
vi.mock("../components/export/SlicerLinksPanel", () => ({
  default: () => <div data-testid="panel-slicer-links" />,
}));
vi.mock("../components/export/ProductionSelectionPanel", () => ({
  default: () => <div data-testid="panel-selection" />,
}));
vi.mock("../components/export/ProductionRulesPanel", () => ({
  default: () => <div data-testid="panel-rules" />,
}));
vi.mock("../components/export/SlicerHandoffPanel", () => ({
  default: () => <div data-testid="panel-handoff" />,
}));
vi.mock("../components/export/ExportActionCards", () => ({
  default: () => <div data-testid="panel-export-cards" />,
}));
vi.mock("../components/export/ExportRecentPanel", () => ({
  default: () => <div data-testid="panel-export-recent" />,
}));
vi.mock("../components/export/PartsManifestTransfer", () => ({
  default: () => <div data-testid="panel-manifest" />,
}));
vi.mock("../components/export/PrinterSendPanel", () => ({
  default: () => <div data-testid="panel-send" />,
}));
vi.mock("../components/export/accepted-plates/AcceptedPlateSection", () => ({
  default: ({ view }: { view?: string }) => <div data-testid={`panel-plates-${view ?? "all"}`} />,
}));
vi.mock("../components/share/ShareBuildExportDialog", () => ({ default: () => null }));

vi.mock("../hooks/useEngineHealth", () => ({
  useEngineHealth: () => ({ health: { ok: true }, error: null, loading: false }),
}));
vi.mock("../context/ProfileContext", () => ({
  useProfileSelection: () => ({
    selectedProfileId: 1,
    profiles: [{ id: 1, name: "Voron 2.4 Workshop" }],
    loading: false,
    error: null,
    reloadProfiles: vi.fn(),
  }),
}));
vi.mock("../context/PlanWorkspaceContext", () => ({
  usePlanWorkspace: () => ({
    review: { part_groups: [] },
    refresh: vi.fn(),
    loading: false,
    error: null,
  }),
}));
vi.mock("../queries/sources", () => ({ useSourcesQuery: () => ({ data: [] }) }));
vi.mock("../queries/roleFilaments", () => ({
  useRoleFilamentsQuery: () => ({ data: [], error: null, refetch: vi.fn() }),
}));
vi.mock("../queries/acceptedPlates", () => ({
  useAcceptedPlateWorkspaceQuery: () => ({ data: state.workspace }),
  useAcceptedPlateExportJobsQuery: () => ({ data: state.exportRecords }),
}));
vi.mock("../components/export/useProductionCheckoffLinks", () => ({
  useProductionCheckoffLinks: () => ({ data: state.checkoffLinks }),
}));
vi.mock("../components/export/useProductionSendFleet", () => ({
  useProductionSendFleet: () => ({ data: { sendCount: 1, bambuCount: 0 } }),
}));
vi.mock("../hooks/useProductionSelection", () => ({
  useProductionSelection: (units: readonly { token: RequiredUnitToken }[]) => ({
    selection: new Set(units.map((entry) => entry.token)),
    setSelection: vi.fn(),
    setup: undefined,
    setupLoading: false,
    setupSaving: false,
    setupError: null,
  }),
}));

const { default: ExportPage } = await import("./ExportPage");

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ExportPage />
    </MemoryRouter>,
  );
}

function exportRecord(): AcceptedPlateExportRecord {
  return {
    job_id: "job-1",
    kind: "export-accepted-plate-3mf",
    status: "done",
    message: "done",
    progress: 1,
    error: null,
    result: {
      format: "accepted-plate-export-job-v1",
      profile_id: 1,
      basis,
      plate_revision_id: 42,
      plate_revision_number: 2,
      layout_digest: "2".repeat(64),
      download_url: "/exports/a.3mf",
      manifest_download_url: "/exports/a.json",
      bundle_download_url: "/exports/a.zip",
      plates: [
        { plate_id: "plate_1", ordinal: 1, filename: "plate-1.3mf", download_url: "/exports/p1.3mf" },
      ],
    },
  } as AcceptedPlateExportRecord;
}

beforeEach(() => {
  state.workspace = readyWorkspace;
  state.exportRecords = [];
  state.checkoffLinks = [];
});

afterEach(cleanup);

describe("ExportPage work packages", () => {
  it("shows the shared Build header and no numbered tabs", () => {
    renderAt("/export");
    expect(screen.getByTestId("build-summary-header")).toBeTruthy();
    expect(screen.queryByText("1. Parts")).toBeNull();
    expect(screen.queryByText("2. Plates & printers")).toBeNull();
    expect(screen.queryByText("4. Send G-code")).toBeNull();
  });

  it("names one work package status and lists the four resumable tasks", () => {
    renderAt("/export");
    expect(screen.getByText("Ready to slice")).toBeTruthy();
    const list = screen.getByLabelText("Prepare this work package");
    for (const label of [
      "Prepare Plates",
      "Export for slicing",
      "Add sliced file",
      "Send or start",
    ]) {
      expect(within(list).getByText(label)).toBeTruthy();
    }
  });

  it("resumes at the first unfinished task when the URL carries no task", async () => {
    renderAt("/export");
    expect(screen.getByTestId("panel-handoff")).toBeTruthy();

    cleanup();
    state.exportRecords = [exportRecord()];
    renderAt("/export");
    expect(await screen.findByTestId("panel-send")).toBeTruthy();
  });

  it("keeps the old numbered stage links working as aliases", async () => {
    renderAt("/export?stage=parts");
    const plateBuilderNav = screen.getByRole("navigation", { name: "Plate builder" });
    expect(within(plateBuilderNav).getByRole("link", { name: /Units.*2 selected/ }).getAttribute("href"))
      .toBe("#plate-builder-units");
    expect(within(plateBuilderNav).getByRole("link", { name: /Printers.*Assigned/ }).getAttribute("href"))
      .toBe("#plate-builder-printers");
    expect(within(plateBuilderNav).getByRole("link", { name: /Plate layout.*Revision 2/ }).getAttribute("href"))
      .toBe("#plate-builder-layout");
    expect(screen.getByTestId("panel-selection")).toBeTruthy();
    expect(screen.getByTestId("panel-plates-assign")).toBeTruthy();
    expect(screen.getByTestId("panel-plates-arrange")).toBeTruthy();

    cleanup();
    renderAt("/export?stage=plates");
    expect(screen.getByTestId("panel-selection")).toBeTruthy();
    expect(screen.getByTestId("panel-plates-assign")).toBeTruthy();
    expect(screen.getByTestId("panel-plates-arrange")).toBeTruthy();

    cleanup();
    renderAt("/export?stage=export");
    expect(screen.getByTestId("panel-handoff")).toBeTruthy();

    cleanup();
    state.exportRecords = [exportRecord()];
    renderAt("/export?stage=send");
    expect(await screen.findByTestId("panel-send")).toBeTruthy();
  });

  it("opens the resume task and explains why when an old link points at a blocked task", () => {
    renderAt("/export?stage=send");
    expect(
      screen.getByText(/Send or start is not available yet\. Add a sliced file before you send\./),
    ).toBeTruthy();
    expect(screen.getByTestId("panel-handoff")).toBeTruthy();
  });

  it("lets the user jump to any available task and states why a blocked one is unavailable", () => {
    state.exportRecords = [];
    renderAt("/export");
    const list = screen.getByLabelText("Prepare this work package");
    expect(within(list).getByText("Add a sliced file before you send.")).toBeTruthy();
    fireEvent.click(within(list).getByRole("button", { name: "Review Plates" }));
    expect(screen.getByTestId("panel-selection")).toBeTruthy();
    expect(screen.getByTestId("panel-plates-assign")).toBeTruthy();
    expect(screen.getByTestId("panel-plates-arrange")).toBeTruthy();
  });

  it("shows a sent package with its status and a route to Checkoff", () => {
    state.checkoffLinks = [
      {
        id: "link-1",
        profile_id: 1,
        integration_id: "int-1",
        printer_id: "printer-1",
        host_name: "Voron 350",
        filename: "batch.gcode",
        units: [{ part_id: 1, unit_index: 0, object_name: `bracket__${TOKEN_A}` }],
        state: "awaiting_verify",
        saw_active: true,
        created_at: "2026-08-27T10:00:00.000Z",
      },
    ];
    renderAt("/export");
    const active = screen.getByLabelText("batch.gcode · Needs verification");
    expect(within(active).getByText("Needs verification")).toBeTruthy();
    expect(within(active).getByRole("link", { name: "Verify in Checkoff" }).getAttribute("href"))
      .toBe("/progress?profile=1");
  });

  it("blocks every task with a reason when the Build has no Required units", () => {
    state.workspace = { kind: "empty_plan" };
    renderAt("/export");
    expect(
      screen.getByText("Accept a Plan revision with Required units before you prepare work."),
    ).toBeTruthy();
  });
});
