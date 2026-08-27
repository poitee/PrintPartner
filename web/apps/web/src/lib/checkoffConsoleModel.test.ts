import { describe, expect, it } from "vitest";
import {
  buildCheckoffAttentionItems,
  checkoffConsoleHeadline,
  checkoffPrinterSummary,
  checkoffViewCounts,
  formatAcceptedRevisionLine,
  formatCompletedAt,
  isCheckoffViewId,
  partsForCheckoffView,
  pendingLinkUnitCount,
  resolveCheckoffCompletion,
  resolveCheckoffView,
} from "./checkoffConsoleModel";

const awaitingLink = {
  id: "link-1",
  host_name: "Core One",
  filename: "gantry.bgcode",
  units: [
    { part_id: 1, unit_index: 0 },
    { part_id: 1, unit_index: 1 },
  ],
};

describe("pendingLinkUnitCount", () => {
  it("counts only units no operator decision resolved", () => {
    expect(pendingLinkUnitCount(awaitingLink)).toBe(2);
    expect(
      pendingLinkUnitCount({
        ...awaitingLink,
        resolved_units: [{ part_id: 1, unit_index: 0 }],
      }),
    ).toBe(1);
  });
});

describe("buildCheckoffAttentionItems", () => {
  it("orders verification before failures before unmatched activity", () => {
    const items = buildCheckoffAttentionItems({
      awaitingLinks: [awaitingLink],
      failedLinks: [
        {
          id: "link-2",
          host_name: "Voron A",
          filename: "belt.gcode",
          host_outcome: "failed",
          units: [{ part_id: 2, unit_index: 0 }],
        },
      ],
      unattributedPrints: [
        {
          id: "print-9",
          host_name: "Core One",
          filename: "cube.bgcode",
          candidates: [{ matching_filenames: ["cube.stl"] }],
        },
      ],
    });

    expect(items.map((item) => item.kind)).toEqual([
      "awaiting_verification",
      "failed_print",
      "unmatched_activity",
    ]);
    expect(items[0]?.statusLabel).toBe("Needs verification");
    expect(items[0]?.hint).toContain("Core One finished 2 units");
    expect(items[1]?.statusLabel).toBe("Failed, retry available");
    expect(items[2]?.statusLabel).toBe("Needs your decision");
  });

  it("names a cancelled job as cancelled", () => {
    const [item] = buildCheckoffAttentionItems({
      awaitingLinks: [],
      failedLinks: [
        {
          id: "link-3",
          host_name: "Voron A",
          filename: "belt.gcode",
          host_outcome: "cancelled",
          units: [{ part_id: 2, unit_index: 0 }],
        },
      ],
      unattributedPrints: [],
    });

    expect(item?.statusLabel).toBe("Cancelled, retry available");
    expect(item?.hint).toContain("cancelled this job");
  });

  it("reports unmatched activity with no candidate match", () => {
    const [item] = buildCheckoffAttentionItems({
      awaitingLinks: [],
      failedLinks: [],
      unattributedPrints: [{ id: "p1", host_name: "Core One", filename: "x.bgcode" }],
    });

    expect(item?.hint).toContain("no Required unit claims");
    expect(item?.unitCount).toBe(0);
  });
});

describe("checkoffViewCounts and partsForCheckoffView", () => {
  const parts = [
    { id: 1, missing: true },
    { id: 2, missing: false },
    { id: 3, missing: true },
  ];

  it("splits remaining from completed", () => {
    expect(checkoffViewCounts({ attentionItems: [{ id: "a" }], parts })).toEqual({
      attention: 1,
      remaining: 2,
      completed: 1,
    });
    expect(partsForCheckoffView({ parts, view: "remaining" }).map((p) => p.id)).toEqual([1, 3]);
    expect(partsForCheckoffView({ parts, view: "completed" }).map((p) => p.id)).toEqual([2]);
    expect(partsForCheckoffView({ parts, view: "attention" })).toHaveLength(3);
  });
});

describe("resolveCheckoffView", () => {
  it("opens on attention when something needs a decision", () => {
    expect(
      resolveCheckoffView({
        requested: null,
        counts: { attention: 2, remaining: 5, completed: 1 },
      }),
    ).toBe("attention");
  });

  it("keeps the operator's own choice", () => {
    expect(
      resolveCheckoffView({
        requested: "completed",
        counts: { attention: 2, remaining: 5, completed: 1 },
      }),
    ).toBe("completed");
  });

  it("lands on completed when nothing remains", () => {
    expect(
      resolveCheckoffView({
        requested: null,
        counts: { attention: 0, remaining: 0, completed: 4 },
      }),
    ).toBe("completed");
  });

  it("defaults to the worklist", () => {
    expect(
      resolveCheckoffView({
        requested: null,
        counts: { attention: 0, remaining: 3, completed: 0 },
      }),
    ).toBe("remaining");
  });
});

describe("checkoffConsoleHeadline", () => {
  it("names attention, then printing, then remaining, then done", () => {
    expect(
      checkoffConsoleHeadline({
        counts: { attention: 1, remaining: 2, completed: 0 },
        printingJobs: 1,
        remainingUnits: 4,
      }),
    ).toBe("1 result needs your attention");
    expect(
      checkoffConsoleHeadline({
        counts: { attention: 0, remaining: 2, completed: 0 },
        printingJobs: 2,
        remainingUnits: 4,
      }),
    ).toBe("2 jobs are printing. Nothing to verify yet.");
    expect(
      checkoffConsoleHeadline({
        counts: { attention: 0, remaining: 2, completed: 0 },
        printingJobs: 0,
        remainingUnits: 1,
      }),
    ).toBe("1 unit is still to produce.");
    expect(
      checkoffConsoleHeadline({
        counts: { attention: 0, remaining: 0, completed: 3 },
        printingJobs: 0,
        remainingUnits: 0,
      }),
    ).toBe("Every Required unit is verified.");
  });
});

describe("resolveCheckoffCompletion", () => {
  it("stays in progress while units remain", () => {
    expect(
      resolveCheckoffCompletion({
        totalUnits: 22,
        printedUnits: 2,
        partCount: 6,
        completedAt: null,
        planVersion: 1,
        revisionId: 1,
      }),
    ).toEqual({ kind: "in_progress", remainingUnits: 20 });
  });

  it("never completes an empty Build", () => {
    expect(
      resolveCheckoffCompletion({
        totalUnits: 0,
        printedUnits: 0,
        partCount: 0,
        completedAt: null,
        planVersion: null,
        revisionId: null,
      }).kind,
    ).toBe("in_progress");
  });

  it("completes when every unit is verified", () => {
    expect(
      resolveCheckoffCompletion({
        totalUnits: 22,
        printedUnits: 22,
        partCount: 6,
        completedAt: "2026-08-27T10:00:00.000Z",
        planVersion: 4,
        revisionId: 12,
      }),
    ).toEqual({
      kind: "complete",
      totalUnits: 22,
      partCount: 6,
      completedAt: "2026-08-27T10:00:00.000Z",
      planVersion: 4,
      revisionId: 12,
    });
  });
});

describe("completion copy", () => {
  it("states the accepted revision", () => {
    expect(formatAcceptedRevisionLine({ planVersion: 4, revisionId: 9 })).toBe(
      "Plan revision 4 accepted",
    );
    expect(formatAcceptedRevisionLine({ planVersion: null, revisionId: null })).toBe(
      "Accepted Plan revision unknown",
    );
  });

  it("falls back when the completion time is missing or broken", () => {
    expect(formatCompletedAt(null)).toBe("Completion time not recorded");
    expect(formatCompletedAt("not-a-date")).toBe("Completion time not recorded");
    expect(formatCompletedAt("2026-08-27T10:00:00.000Z")).toContain("Completed ");
  });
});

describe("checkoffPrinterSummary", () => {
  it("reads as status text, never as a dispatch control", () => {
    expect(checkoffPrinterSummary({ printingJobs: 0, queuedJobs: 0, failedJobs: 0 })).toEqual({
      printingLabel: "Printing now: none",
      queuedLabel: "Queued: none",
      failedLabel: null,
    });
    expect(checkoffPrinterSummary({ printingJobs: 1, queuedJobs: 3, failedJobs: 2 })).toEqual({
      printingLabel: "Printing now: 1 job",
      queuedLabel: "Queued: 3 jobs",
      failedLabel: "Failed: 2 jobs",
    });
  });
});

describe("isCheckoffViewId", () => {
  it("guards stored values", () => {
    expect(isCheckoffViewId("attention")).toBe(true);
    expect(isCheckoffViewId("nope")).toBe(false);
  });
});
