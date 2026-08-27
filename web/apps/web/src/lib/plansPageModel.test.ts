import { describe, expect, it } from "vitest";
import { isPlansListEmpty, plansLoadingAnnouncement } from "./plansPageModel";

describe("plansPageModel", () => {
  it("announces engine and profiles loading states", () => {
    expect(
      plansLoadingAnnouncement({ engineState: "loading", profilesState: "ready" }),
    ).toBe("Connecting to the engine…");
    expect(
      plansLoadingAnnouncement({ engineState: "ready", profilesState: "loading" }),
    ).toBe("Loading builds…");
    expect(plansLoadingAnnouncement({ engineState: "ready", profilesState: "ready" })).toBe("");
  });

  it("distinguishes no builds from no filtered results", () => {
    expect(
      isPlansListEmpty({
        engineState: "ready",
        profilesState: "ready",
        profileCount: 0,
        rowCount: 0,
      }),
    ).toEqual({ emptyAll: true, emptyFilter: false });
    expect(
      isPlansListEmpty({
        engineState: "ready",
        profilesState: "ready",
        profileCount: 2,
        rowCount: 0,
      }),
    ).toEqual({ emptyAll: false, emptyFilter: true });
  });
});
