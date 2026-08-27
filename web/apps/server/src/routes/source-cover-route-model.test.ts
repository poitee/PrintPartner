import { describe, expect, it } from "vitest";
import { toCoverProject } from "./source-cover-route-model.js";

describe("toCoverProject", () => {
  it("maps a repository project row to the source cover service input", () => {
    expect(
      toCoverProject({
        id: 7,
        url: "https://example.com/repo.git",
        sourceKind: "github",
        sourceType: "git",
        localPath: "/tmp/repo",
        lastSyncedAt: "2026-08-26T00:00:00.000Z",
        metadataJson: '{"cover":"cover.png"}',
      }),
    ).toEqual({
      id: 7,
      url: "https://example.com/repo.git",
      sourceKind: "github",
      sourceType: "git",
      localPath: "/tmp/repo",
      lastSyncedAt: "2026-08-26T00:00:00.000Z",
      metadataJson: '{"cover":"cover.png"}',
    });
  });
});
