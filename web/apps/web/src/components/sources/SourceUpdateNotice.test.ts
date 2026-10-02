import { describe, expect, it } from "vitest";
import { sourceUpdateNotice } from "./SourceUpdateNotice";

describe("sourceUpdateNotice", () => {
  it("stops announcing a historical update once no source needs it", () => {
    const latestActivity = {
      id: 12,
      at: "2026-10-01T22:30:00.000Z",
      kind: "source.update_available" as const,
      source_id: 2,
      source_name: "Beta",
      detail: null,
    };

    expect(sourceUpdateNotice({ updateIds: [2], latestActivity })).toMatchObject({
      signature: "updates:2",
      title: "1 source update ready",
    });
    expect(sourceUpdateNotice({ updateIds: [], latestActivity })).toBeNull();
  });

  it("prioritises sources that still need review", () => {
    expect(
      sourceUpdateNotice({
        updateIds: [9, 2],
        latestActivity: {
          id: 3,
          at: "2026-08-31T10:00:00.000Z",
          kind: "source.updated",
          source_id: 2,
          source_name: "Voron",
          detail: null,
        },
      }),
    ).toMatchObject({
      signature: "updates:2,9",
      title: "2 source updates ready",
    });
  });

  it("turns a failed automatic refresh into a persistent app notice", () => {
    expect(
      sourceUpdateNotice({
        updateIds: [],
        latestActivity: {
          id: 11,
          at: "2026-08-31T10:00:00.000Z",
          kind: "source.sync_failed",
          source_id: 4,
          source_name: "Toolhead",
          detail: "Remote unavailable",
        },
      }),
    ).toEqual({
      signature: "event:11",
      title: "Toolhead could not refresh",
      detail: "Remote unavailable",
      tone: "failure",
    });
  });

  it("keeps the notice after an automatic refresh", () => {
    expect(
      sourceUpdateNotice({
        updateIds: [],
        latestActivity: {
          id: 13,
          at: "2026-10-01T22:30:00.000Z",
          kind: "source.updated",
          source_id: 2,
          source_name: "Beta",
          detail: null,
        },
      }),
    ).toMatchObject({
      signature: "event:13",
      title: "Beta refreshed automatically",
      tone: "update",
    });
  });
});
