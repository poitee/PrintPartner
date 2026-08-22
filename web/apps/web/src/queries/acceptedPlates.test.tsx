// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import {
  parseAcceptedPlateWorkspace,
  parseInitializeAcceptedPlatesRequest,
  type AcceptedPlateWorkspace,
} from "@print-partner/contracts";
import {
  arrangeAcceptedPlates,
  initializeAcceptedPlates,
  moveAcceptedPlateUnit,
  pinAcceptedPlateUnit,
} from "../api/endpoints/acceptedPlates";
import { queryKeys } from "./keys";
import {
  acceptedPlateCapability,
  publishAcceptedPlateMove,
  useAcceptedPlateActionMutation,
  useInitializeAcceptedPlatesMutation,
  useMoveAcceptedPlateUnitMutation,
} from "./acceptedPlates";

vi.mock("../api/endpoints/acceptedPlates", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/endpoints/acceptedPlates")>();
  return {
    ...actual,
    initializeAcceptedPlates: vi.fn(),
    moveAcceptedPlateUnit: vi.fn(),
    pinAcceptedPlateUnit: vi.fn(),
    arrangeAcceptedPlates: vi.fn(),
  };
});

const digest = "a".repeat(64);
const token = `ppu_${"b".repeat(32)}`;
const plateId = `plate_${"c".repeat(32)}`;
const basis = {
  profile_id: 7,
  plan_version: 3,
  plan_revision_id: 11,
  plan_revision_digest: digest,
  required_unit_mapping_digest: digest,
};
const ready = parseAcceptedPlateWorkspace({
  kind: "ready",
  basis,
  plate_revision_id: 19,
  plate_revision_number: 2,
  arrange_undo_revision_id: 18,
  printers: [],
  plates: [{
    plate_id: plateId,
    ordinal: 1,
    printer: {
      id: "printer-one",
      name: "Printer One",
      model: "Model One",
      bed_width_um: 250_000,
      bed_depth_um: 210_000,
      bed_height_um: 200_000,
      margin_um: 4_000,
    },
    units: [{
      token,
      object_name: `bracket__${token}`,
      filename: "bracket.stl",
      source_layer: "Hardware",
      role: "primary",
      filament_color_id: null,
      x_um: 4_000,
      y_um: 5_000,
      width_um: 30_000,
      depth_um: 20_000,
      height_um: 10_000,
    }],
  }],
});
if (ready.kind !== "ready") throw new Error("Expected ready workspace");
const acceptedPlateId = ready.plates[0]?.plate_id;
const requiredToken = ready.plates[0]?.units[0]?.token;
if (!acceptedPlateId || !requiredToken) throw new Error("Expected accepted Plate unit");

function wrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("accepted Plate query ownership", () => {
  it("keeps cached ready state actionable during background uncertainty", () => {
    expect(acceptedPlateCapability({
      enabled: true,
      profileId: 7,
      workspace: ready,
      isPending: false,
      isError: true,
      revisionWritePending: false,
    })).toMatchObject({ kind: "ready", plateRevisionId: 19 });
    expect(acceptedPlateCapability({
      enabled: true,
      profileId: 7,
      workspace: undefined,
      isPending: false,
      isError: true,
      revisionWritePending: false,
    })).toEqual({ kind: "blocked", reason: "load_failed" });
    expect(acceptedPlateCapability({
      enabled: true,
      profileId: 7,
      workspace: ready,
      isPending: false,
      isError: false,
      revisionWritePending: true,
    })).toEqual({ kind: "blocked", reason: "revision_write_pending" });
  });

  it("blocks export and handoff capabilities while any unit is unplaced", () => {
    const unplaced = parseAcceptedPlateWorkspace({
      ...ready,
      plates: ready.plates.map((plate) => ({ ...plate, units: [] })),
      unplaced: [{
        token,
        object_name: `bracket__${token}`,
        filename: "bracket.stl",
        source_layer: "Hardware",
        role: "primary",
        filament_color_id: null,
        plate_id: plateId,
        printer_id: "printer-one",
        width_um: 30_000,
        depth_um: 20_000,
        height_um: 10_000,
      }],
    });
    expect(acceptedPlateCapability({
      enabled: true,
      profileId: 7,
      workspace: unplaced,
      isPending: false,
      isError: false,
      revisionWritePending: false,
    })).toEqual({ kind: "blocked", reason: "unplaced_units" });
  });

  it("publishes submitted coordinates and the two-field receipt", () => {
    expect(publishAcceptedPlateMove(ready, {
      plateId,
      token,
      input: {
        expected: basis,
        expected_plate_revision_id: 19,
        x_um: 12_345,
        y_um: 22_000,
      },
    }, {
      plate_revision_id: 20,
      plate_revision_number: 3,
    })).toMatchObject({
      kind: "ready",
      plate_revision_id: 20,
      plate_revision_number: 3,
      arrange_undo_revision_id: null,
      plates: [{ units: [{ x_um: 12_345, y_um: 22_000 }] }],
    });
  });

  it("serializes initialize and move for one Build while another Build remains independent", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let resolveInitialize: ((workspace: AcceptedPlateWorkspace) => void) | undefined;
    vi.mocked(initializeAcceptedPlates).mockImplementationOnce(() => new Promise((resolve) => {
      resolveInitialize = resolve;
    }));
    vi.mocked(moveAcceptedPlateUnit).mockResolvedValue({
      plate_revision_id: 20,
      plate_revision_number: 3,
    });
    const { result } = renderHook(() => ({
      initialize: useInitializeAcceptedPlatesMutation(7),
      sameBuildMove: useMoveAcceptedPlateUnitMutation(7),
      otherBuildMove: useMoveAcceptedPlateUnitMutation(8),
    }), { wrapper: wrapper(queryClient) });
    let initializePromise: Promise<AcceptedPlateWorkspace>;
    let sameBuildPromise: Promise<unknown>;
    let otherBuildPromise: Promise<unknown>;
    act(() => {
      initializePromise = result.current.initialize.mutateAsync(parseInitializeAcceptedPlatesRequest({
        expected: basis,
        expected_plate_revision_id: null,
        assignments: [{ token, printer_id: "printer-one" }],
      }));
      sameBuildPromise = result.current.sameBuildMove.mutateAsync({
        plateId,
        token,
        input: { expected: basis, expected_plate_revision_id: 19, x_um: 6_000, y_um: 7_000 },
      });
      otherBuildPromise = result.current.otherBuildMove.mutateAsync({
        plateId,
        token,
        input: { expected: { ...basis, profile_id: 8 }, expected_plate_revision_id: 19, x_um: 8_000, y_um: 9_000 },
      });
    });
    await waitFor(() => expect(moveAcceptedPlateUnit).toHaveBeenCalledWith(8, plateId, token, expect.anything()));
    expect(moveAcceptedPlateUnit).not.toHaveBeenCalledWith(7, plateId, token, expect.anything());
    resolveInitialize?.(ready);
    await act(async () => {
      await Promise.all([initializePromise, sameBuildPromise, otherBuildPromise]);
    });
    expect(initializeAcceptedPlates).toHaveBeenCalledWith(7, expect.anything());
    expect(moveAcceptedPlateUnit).toHaveBeenCalledWith(7, plateId, token, expect.anything());
    expect(queryClient.getQueryData(queryKeys.acceptedPlateWorkspace(7))).toBeDefined();
  });

  it("refreshes receipt edits and publishes full arrange workspaces through one action scope", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(queryKeys.acceptedPlateWorkspace(7), ready);
    vi.mocked(pinAcceptedPlateUnit).mockResolvedValue({
      plate_revision_id: 20,
      plate_revision_number: 3,
    });
    const arranged = parseAcceptedPlateWorkspace({
      ...ready,
      plate_revision_id: 21,
      plate_revision_number: 4,
      arrange_undo_revision_id: 20,
    });
    vi.mocked(arrangeAcceptedPlates).mockResolvedValue(arranged);
    const { result } = renderHook(() => useAcceptedPlateActionMutation(7), {
      wrapper: wrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({
        kind: "pin",
        plateId: acceptedPlateId,
        token: requiredToken,
        input: { expected: basis, expected_plate_revision_id: 19, pinned: true },
      });
    });
    expect(queryClient.getQueryData(queryKeys.acceptedPlateWorkspace(7))).toMatchObject({
      plate_revision_id: 19,
      plate_revision_number: 2,
    });

    await act(async () => {
      await result.current.mutateAsync({
        kind: "arrange",
        input: { expected: basis, expected_plate_revision_id: 20, mode: "all" },
      });
    });
    expect(queryClient.getQueryData(queryKeys.acceptedPlateWorkspace(7))).toEqual(arranged);
  });
});
