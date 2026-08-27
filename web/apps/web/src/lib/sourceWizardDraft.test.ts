import { describe, expect, it } from "vitest";
import type { SourceSummary } from "@print-partner/contracts";
import {
  isSourceKind,
  newSourceWizardDraft,
  sourceWizardDraftFromSource,
} from "./sourceWizardDraft";

function source(overrides: Partial<SourceSummary> = {}): SourceSummary {
  return {
    id: 1,
    name: "Voron",
    url: "https://example.test/repo",
    branch: "main",
    tag: null,
    source_kind: "github",
    source_type: "git",
    role: "",
    category: null,
    local_path: null,
    last_synced_at: null,
    last_commit_sha: null,
    current_source_revision_id: null,
    docs_url: null,
    manifest_community_slug: null,
    metadata: {},
    update_status: "unknown",
    update_checked_at: null,
    doc_count: 0,
    ...overrides,
  };
}

describe("source wizard draft", () => {
  it("creates a new draft with category and optional kind", () => {
    expect(newSourceWizardDraft(["Printers"], "archive")).toMatchObject({
      source_kind: "archive",
      category: "Printers",
      branch: "main",
      refType: "branch",
    });
  });

  it("creates an edit draft from a source", () => {
    expect(
      sourceWizardDraftFromSource(
        source({ tag: "v1.0", branch: "release", source_kind: "printables", category: "Mods" }),
      ),
    ).toMatchObject({
      name: "Voron",
      refType: "tag",
      branch: "release",
      tag: "v1.0",
      source_kind: "printables",
      category: "Mods",
    });
  });

  it("falls back to GitHub for unknown source kinds", () => {
    expect(isSourceKind("makerworld")).toBe(true);
    expect(isSourceKind("other")).toBe(false);
    expect(sourceWizardDraftFromSource(source({ source_kind: "other" })).source_kind).toBe("github");
  });
});
