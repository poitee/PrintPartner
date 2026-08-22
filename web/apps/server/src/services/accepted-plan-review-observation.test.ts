import { describe, expect, it, vi } from "vitest";
import type { AppRepository } from "../db/repository.js";
import type { AcceptedPlanOperationalSnapshot } from "../db/accepted-plan-operational.js";

const observationSpies = vi.hoisted(() => ({
  artifact: vi.fn(),
  root: vi.fn(() => ({ kind: "available" as const })),
  png: vi.fn(),
}));

vi.mock("./accepted-artifacts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./accepted-artifacts.js")>()),
  observeAcceptedArtifact: observationSpies.artifact,
  observeAcceptedSnapshotRoot: observationSpies.root,
}));

vi.mock("../lib/accepted-media-cache.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/accepted-media-cache.js")>()),
  observeAcceptedMediaPng: observationSpies.png,
}));

import { readAcceptedPlanReview } from "./accepted-plan-review.js";

describe("accepted Review observation boundary", () => {
  it("performs no artifact or cache I/O for excluded Parts", async () => {
    const snapshot: AcceptedPlanOperationalSnapshot = {
      format: "accepted-plan-operational-v1",
      profile: {
        id: 7,
        name: "Accepted",
        orderNumber: null,
        specialRequest: null,
        archivedAt: null,
      },
      planVersion: 1,
      revisionId: 1,
      revisionNumber: 1,
      revisionDigest: "a".repeat(64),
      acceptedAt: "2026-08-21T00:00:00.000Z",
      provenance: { kind: "legacy" },
      requiredUnitMappingDigest: "b".repeat(64),
      parts: [
        {
          revisionPartId: 1,
          projectionPartId: 2,
          partKey: "excluded.stl",
          relativePath: "excluded.stl",
          filename: "excluded.stl",
          sourceLayer: "source:Accepted",
          status: "ok",
          roleInferred: "primary",
          roleOverride: null,
          effectiveRole: "primary",
          filamentColorId: null,
          filamentCustomHex: null,
          spoolmanSpoolId: null,
          quantityInferred: 1,
          quantityOverride: null,
          quantityEffective: 1,
          included: false,
          notes: "",
          githubBlobUrl: null,
          geometrySame: null,
          requirement: null,
          optionGroupId: null,
          manifestSource: null,
          artifact: { kind: "unavailable", reason: "legacy" },
          units: [],
        },
      ],
    };
    const repo = {
      getOwnedProfileIdentity: vi.fn(() => ({
        id: 7,
        name: "Working",
        archivedAt: null,
      })),
      readAcceptedPlanOperationalSnapshot: vi.fn(() => ({ kind: "ready" as const, snapshot })),
    } as unknown as AppRepository;

    const result = await readAcceptedPlanReview({
      repo,
      profileId: 7,
      includeExcluded: true,
      reposDir: "/unused/repos",
      thumbsDir: "/unused/thumbs",
    });

    expect(result.kind).toBe("ready");
    expect(observationSpies.artifact).not.toHaveBeenCalled();
    expect(observationSpies.png).not.toHaveBeenCalled();
  });
});
