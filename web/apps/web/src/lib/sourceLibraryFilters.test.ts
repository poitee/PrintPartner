import { describe, expect, it } from "vitest";
import type { SourceSummary } from "@print-partner/contracts";
import { filterSourceLibrary, matchesSourceLibraryFilters } from "./sourceLibraryFilters";

function source(partial: Partial<SourceSummary> & Pick<SourceSummary, "id" | "name">): SourceSummary {
  return {
    id: partial.id,
    name: partial.name,
    url: partial.url ?? "https://github.com/example/source",
    source_kind: partial.source_kind ?? "github",
    source_type: partial.source_type ?? "github",
    role: partial.role ?? "",
    category: partial.category ?? null,
    branch: partial.branch ?? "main",
    tag: partial.tag ?? null,
    local_path: partial.local_path ?? null,
    last_synced_at: partial.last_synced_at ?? null,
    last_commit_sha: partial.last_commit_sha ?? null,
    current_source_revision_id: partial.current_source_revision_id ?? null,
    docs_url: partial.docs_url ?? null,
    manifest_community_slug: partial.manifest_community_slug ?? null,
    metadata: partial.metadata ?? {},
    update_status: partial.update_status ?? "unknown",
    update_checked_at: partial.update_checked_at ?? null,
    doc_count: partial.doc_count ?? 0,
  } satisfies SourceSummary;
}

describe("source library filters", () => {
  it("matches search, Library category, sync state, and platform", () => {
    const voron = source({
      id: 1,
      name: "Voron Trident",
      category: "Printers/Voron",
      last_synced_at: "2026-08-25T00:00:00.000Z",
      source_kind: "github",
    });

    expect(
      matchesSourceLibraryFilters(voron, {
        search: "trident",
        categoryFilter: "Printers",
        syncFilter: "synced",
        platformFilter: "github",
      }),
    ).toBe(true);
    expect(
      matchesSourceLibraryFilters(voron, {
        search: "rat rig",
        categoryFilter: "Printers",
        syncFilter: "synced",
        platformFilter: "github",
      }),
    ).toBe(false);
    expect(
      matchesSourceLibraryFilters(voron, {
        search: "",
        categoryFilter: "Printers/RatRig",
        syncFilter: "synced",
        platformFilter: "github",
      }),
    ).toBe(false);
    expect(
      matchesSourceLibraryFilters(voron, {
        search: "",
        categoryFilter: "Printers",
        syncFilter: "unsynced",
        platformFilter: "github",
      }),
    ).toBe(false);
  });

  it("filters a Source list", () => {
    const filtered = filterSourceLibrary(
      [
        source({ id: 1, name: "Voron", category: "Printers" }),
        source({ id: 2, name: "Filament notes", category: "Docs", source_kind: "local" }),
      ],
      { search: "", categoryFilter: "Printers", syncFilter: "all", platformFilter: "all" },
    );

    expect(filtered.map((item) => item.name)).toEqual(["Voron"]);
  });
});
