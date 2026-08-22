import { describe, expect, it } from "vitest";
import type {
  PlanRevisionInputSet,
  SourceRevision,
} from "./index.js";

describe("source revision contracts", () => {
  it("preserves immutable revision identity across JSON serialization", () => {
    const revision: SourceRevision = {
      id: 41,
      source_id: 7,
      upstream_revision_key: "8f4d6a1",
      manifest_digest: "a".repeat(64),
      snapshot_locator: "sources/default/7/revisions/8f4d6a1",
      synced_at: "2026-08-20T10:00:00.000Z",
      completeness: "complete",
    };

    expect(JSON.parse(JSON.stringify(revision))).toEqual(revision);
  });

  it("serializes a published Plan input set with its copied manifest digest", () => {
    const inputSet: PlanRevisionInputSet = {
      id: 12,
      plan_id: 3,
      recorded_at: "2026-08-20T10:01:00.000Z",
      published_at: "2026-08-20T10:01:01.000Z",
      format_version: 2,
      inputs: [
        {
          source_id: 7,
          source_layer: "base:Voron",
          layer_order: 0,
          tracking_kind: "revision",
          source_revision_id: 41,
          manifest_digest: "a".repeat(64),
          effective_naming_digest: "b".repeat(64),
        },
      ],
    };

    expect(JSON.parse(JSON.stringify(inputSet))).toEqual(inputSet);
  });
});
