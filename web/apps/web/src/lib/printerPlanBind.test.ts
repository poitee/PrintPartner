import { describe, expect, it } from "vitest";
import {
  findPlanNameForLiveJob,
  liveJobPlanCaption,
  resolvePlanIdForPrinterFetch,
  sendPlanBindCopy,
} from "./printerPlanBind";

describe("sendPlanBindCopy", () => {
  it("shows For [Plan] when a plan is active", () => {
    expect(sendPlanBindCopy("Voron Trident")).toEqual({
      line: "For Voron Trident.",
      canSend: true,
    });
  });

  it("disables send when no plan", () => {
    expect(sendPlanBindCopy(null)).toEqual({
      line: "Pick a plan to bind this send.",
      canSend: false,
    });
    expect(sendPlanBindCopy("  ")).toEqual({
      line: "Pick a plan to bind this send.",
      canSend: false,
    });
  });
});

describe("liveJobPlanCaption", () => {
  it("shows plan name or No plan.", () => {
    expect(liveJobPlanCaption("Shop kit")).toBe("Shop kit");
    expect(liveJobPlanCaption(null)).toBe("No plan.");
    expect(liveJobPlanCaption("")).toBe("No plan.");
  });
});

describe("findPlanNameForLiveJob", () => {
  const links = [
    {
      printer_id: "p1",
      filename: "plate.gcode",
      profile_id: 10,
      state: "watching" as const,
    },
    {
      printer_id: "p2",
      filename: "other.gcode",
      remote_path: "gcodes/other.gcode",
      profile_id: 20,
      state: "awaiting_verify" as const,
    },
  ];
  const names = new Map<number, string>([
    [10, "Alpha"],
    [20, "Beta"],
  ]);

  it("resolves plan name from matching link", () => {
    expect(
      findPlanNameForLiveJob({
        printerId: "p1",
        filename: "plate.gcode",
        links,
        planNameById: names,
      }),
    ).toBe("Alpha");
  });

  it("matches remote_path basename", () => {
    expect(
      findPlanNameForLiveJob({
        printerId: "p2",
        filename: "other.gcode",
        links,
        planNameById: names,
      }),
    ).toBe("Beta");
  });

  it("returns null when unbound", () => {
    expect(
      findPlanNameForLiveJob({
        printerId: "p1",
        filename: "unknown.gcode",
        links,
        planNameById: names,
      }),
    ).toBeNull();
  });

  it("prefers watching / awaiting_verify over stale terminal same-filename", () => {
    const mixed = [
      {
        printer_id: "p1",
        filename: "plate.gcode",
        profile_id: 10,
        state: "verified" as const,
      },
      {
        printer_id: "p1",
        filename: "plate.gcode",
        profile_id: 20,
        state: "watching" as const,
      },
    ];
    expect(
      findPlanNameForLiveJob({
        printerId: "p1",
        filename: "plate.gcode",
        links: mixed,
        planNameById: names,
      }),
    ).toBe("Beta");
  });
});

describe("resolvePlanIdForPrinterFetch", () => {
  it("never steals a bound job", () => {
    expect(resolvePlanIdForPrinterFetch(5, 9)).toBe(5);
  });

  it("binds unbound once to active spine", () => {
    expect(resolvePlanIdForPrinterFetch(null, 9)).toBe(9);
  });
});
