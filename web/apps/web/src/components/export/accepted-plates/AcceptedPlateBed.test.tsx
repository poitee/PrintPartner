// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseAcceptedPlateWorkspace } from "@print-partner/contracts";
import AcceptedPlateBed from "./AcceptedPlateBed";

const digest = "a".repeat(64);
const token = `ppu_${"b".repeat(32)}`;
const workspace = parseAcceptedPlateWorkspace({
  kind: "ready",
  basis: {
    profile_id: 7,
    plan_version: 3,
    plan_revision_id: 11,
    plan_revision_digest: digest,
    required_unit_mapping_digest: digest,
  },
  plate_revision_id: 19,
  plate_revision_number: 2,
  printers: [],
  plates: [{
    plate_id: `plate_${"c".repeat(32)}`,
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
if (workspace.kind !== "ready") throw new Error("Expected ready workspace");
const plate = workspace.plates[0];
if (!plate) throw new Error("Expected Plate");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AcceptedPlateBed rejected drag", () => {
  it("consumes an expected rejection and restores persisted coordinates", async () => {
    Object.defineProperty(SVGSVGElement.prototype, "getScreenCTM", {
      configurable: true,
      value: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    });
    const onMove = vi.fn().mockRejectedValue(new Error("overlapping_units"));
    render(
      <AcceptedPlateBed
        plate={plate}
        workspace={workspace}
        revisionId={19}
        disabled={false}
        onMove={onMove}
        onStaleMove={() => Promise.resolve()}
        onPin={() => Promise.resolve()}
        onUnplace={() => Promise.resolve()}
        onTransfer={() => Promise.resolve()}
      />,
    );
    const unit = screen.getByRole("button", { name: `bracket__${token}` });
    Object.defineProperties(unit, {
      setPointerCapture: { value: vi.fn() },
      releasePointerCapture: { value: vi.fn() },
    });
    const unhandled: unknown[] = [];
    const capture = (event: PromiseRejectionEvent) => {
      event.preventDefault();
      unhandled.push(event.reason);
    };
    window.addEventListener("unhandledrejection", capture);
    fireEvent.pointerDown(unit, { pointerId: 1, clientX: 5_000, clientY: 6_000 });
    fireEvent.pointerMove(unit, { pointerId: 1, clientX: 20_000, clientY: 21_000 });
    fireEvent.pointerUp(unit, { pointerId: 1, clientX: 20_000, clientY: 21_000 });

    await waitFor(() => expect(onMove).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(unhandled).toEqual([]);
    expect(unit.getAttribute("x")).toBe("4000");
    expect(unit.getAttribute("y")).toBe("5000");
    window.removeEventListener("unhandledrejection", capture);
  });
});
