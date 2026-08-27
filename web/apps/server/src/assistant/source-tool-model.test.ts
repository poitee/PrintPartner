import { describe, expect, it } from "vitest";
import type { AppRepository } from "../db/repository.js";
import {
  categoryNotFoundError,
  countSourcesUnderCategory,
  sourceByName,
  sourceNotFoundError,
  summarizeSourceCategories,
} from "./source-tool-model.js";

type Source = { id: number; name: string; category: string | null };

function repoStub(sources: Source[], categories: string[]): AppRepository {
  return {
    listSources: () => sources,
    getSourceCategories: () => categories,
  } as unknown as AppRepository;
}

describe("assistant source tool model", () => {
  it("resolves source names exactly, case-insensitively, and separator-insensitively", () => {
    const repo = repoStub([
      { id: 1, name: "Voron-Parts", category: null },
      { id: 2, name: "Voron-Parts R2", category: null },
    ], []);

    expect(sourceByName(repo, "Voron-Parts")?.id).toBe(1);
    expect(sourceByName(repo, "voron-parts")?.id).toBe(1);
    expect(sourceByName(repo, "Voron Parts")?.id).toBe(1);
    expect(sourceByName(repo, "Voron Parts R2 release")?.id).toBe(2);
  });

  it("summarizes nested categories with direct and recursive counts", () => {
    const repo = repoStub([
      { id: 1, name: "Base", category: "Printers" },
      { id: 2, name: "Frame", category: "Printers/Frame" },
      { id: 3, name: "Loose", category: null },
    ], ["Printers", "Printers/Frame"]);

    expect(countSourcesUnderCategory(repo, "Printers")).toBe(2);
    expect(summarizeSourceCategories(repo)).toMatchObject({
      separator: "/",
      uncategorized_sources: 1,
      categories: [
        { path: "Printers", sources: 1, sources_including_subcategories: 2 },
        { path: "Printers/Frame", sources: 1, sources_including_subcategories: 1 },
      ],
    });
  });

  it("formats Source and category errors with useful hints", () => {
    const repo = repoStub([{ id: 1, name: "Voron-Parts", category: null }], ["Printers"]);

    expect(JSON.parse(categoryNotFoundError(repo, "Unknown"))).toMatchObject({
      categories: ["Printers"],
    });
    expect(JSON.parse(sourceNotFoundError(repo, "Voron Part", "Call list_sources first.")).error).toContain(
      "Did you mean",
    );
  });
});
