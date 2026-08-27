import { describe, expect, it } from "vitest";
import {
  globalProductionJobLabel,
  partitionGlobalProductionJobs,
  recentVerifiedJobs,
  toGlobalProductionJob,
} from "./globalProduction";

const names = new Map([
  [7, "Voron"],
  [8, "A1 Mini"],
]);

describe("toGlobalProductionJob", () => {
  it("maps active links onto Checkoff for that Build", () => {
    expect(
      toGlobalProductionJob(
        {
          id: "link-1",
          state: "awaiting_verify",
          profile_id: 7,
          host_name: "Core One",
          filename: "plate-01.gcode",
        },
        names,
      ),
    ).toEqual({
      id: "link-1",
      state: "awaiting_verify",
      profileId: 7,
      planName: "Voron",
      hostName: "Core One",
      filename: "plate-01.gcode",
      checkoffHref: "/progress?profile=7",
      productionHref: "/export?profile=7",
    });
  });

  it("drops completed links from active buckets", () => {
    expect(
      toGlobalProductionJob(
        {
          id: "done",
          state: "verified",
          profile_id: 7,
          host_name: "Core One",
          filename: "done.gcode",
        },
        names,
      ),
    ).toBeNull();
  });
});

it("partitions the three live states", () => {
  const jobs = [
    toGlobalProductionJob(
      { id: "w", state: "watching", profile_id: 7, host_name: "A", filename: "a" },
      names,
    ),
    toGlobalProductionJob(
      { id: "v", state: "awaiting_verify", profile_id: 8, host_name: "B", filename: "b" },
      names,
    ),
    toGlobalProductionJob(
      { id: "f", state: "host_failed", profile_id: 7, host_name: "C", filename: "c" },
      names,
    ),
  ].filter((job) => job != null);
  const result = partitionGlobalProductionJobs(jobs);
  expect(result.watching.map(({ id }) => id)).toEqual(["w"]);
  expect(result.awaiting.map(({ id }) => id)).toEqual(["v"]);
  expect(result.failed.map(({ id }) => id)).toEqual(["f"]);
});

it("keeps the newest verified work", () => {
  expect(
    recentVerifiedJobs(
      [
        {
          id: "old",
          state: "verified",
          profile_id: 7,
          host_name: "A",
          filename: "old.gcode",
          completed_at: "2026-08-01T00:00:00Z",
          applied_at: "2026-08-01T00:00:00Z",
        },
        {
          id: "new",
          state: "applied",
          profile_id: 8,
          host_name: "B",
          filename: "new.gcode",
          completed_at: "2026-08-20T00:00:00Z",
          applied_at: "2026-08-21T00:00:00Z",
        },
      ],
      names,
      1,
    ),
  ).toEqual([
    {
      id: "new",
      planName: "A1 Mini",
      filename: "new.gcode",
      at: "2026-08-21T00:00:00Z",
      checkoffHref: "/progress?profile=8",
    },
  ]);
});

it("labels live states", () => {
  expect(globalProductionJobLabel("watching")).toBe("Printing");
  expect(globalProductionJobLabel("awaiting_verify")).toBe("Needs verification");
  expect(globalProductionJobLabel("host_failed")).toBe("Failed");
});
