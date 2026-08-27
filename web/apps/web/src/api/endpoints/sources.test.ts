import { describe, expect, it } from "vitest";
import { jsonResponse, createEndpointTestHttp } from "../endpointTestHttp";
import {
  bulkAssignSourceCategory,
  createSource,
  deleteSource,
  fetchImportRules,
  fetchSourceCategories,
  fetchSourceHasManifest,
  fetchSources,
  fetchStlTree,
  saveImportRules,
  saveSourceCategories,
  searchSourceStls,
  startImportScan,
  updateSource,
} from "./sources";

const http = createEndpointTestHttp();

describe("source endpoints", () => {
  it("fetches source lists, categories, manifests, trees, and import rules", async () => {
    http
      .respond(jsonResponse({ sources: [] }))
      .respond(jsonResponse({ categories: ["Mods"] }))
      .respond(jsonResponse({ has_manifest: true }))
      .respond(
        jsonResponse({ rules: ["include/**"], legacy_import_all: false }),
      )
      .respond(
        jsonResponse({
          project_id: 1,
          total: 0,
          selected: 0,
          legacy_import_all: false,
          nodes: [],
        }),
      );

    await expect(fetchSources()).resolves.toEqual([]);
    await expect(fetchSourceCategories()).resolves.toEqual(["Mods"]);
    await expect(fetchSourceHasManifest(7)).resolves.toEqual({
      has_manifest: true,
    });
    await expect(fetchImportRules(7)).resolves.toEqual({
      rules: ["include/**"],
      legacy_import_all: false,
    });
    await expect(fetchStlTree(7)).resolves.toMatchObject({ project_id: 1 });
  });

  it("saves categories and import rules", async () => {
    http
      .respond(jsonResponse({ categories: ["New"] }))
      .respond(jsonResponse({ rules: ["parts/**"] }));

    await saveSourceCategories({
      categories: ["New"],
      replacements: { Old: "New" },
    });
    await saveImportRules(3, ["parts/**"]);

    expect(http.requestJson(0)).toEqual({
      categories: ["New"],
      replacements: { Old: "New" },
    });
    expect(http.requestJson(1)).toEqual({ rules: ["parts/**"] });
  });

  it("searches source STLs", async () => {
    http.respond(jsonResponse({ query: "gear", results: [] }));

    await searchSourceStls("gear", 12);

    expect(http.calls[0]?.[0]).toContain("/sources/stl-search?q=gear&limit=12");
  });

  it("merges source category into create and update metadata", async () => {
    http.respond(jsonResponse({ id: 1 })).respond(jsonResponse({ id: 1 }));

    await createSource({
      name: "Source",
      source_kind: "github",
      metadata: { source_role: "base" },
      category: null,
    });
    await updateSource(1, {
      metadata: { source_role: "addon" },
      category: "Mods",
    });

    expect(http.requestJson(0)).toMatchObject({
      metadata: { source_role: "base", category: "" },
    });
    expect(http.requestJson(1)).toMatchObject({
      metadata: { source_role: "addon", category: "Mods" },
    });
  });

  it("bulk assigns categories, deletes sources, and starts import scans", async () => {
    http
      .respond(
        jsonResponse({ updated: [], results: [], succeeded: 0, failed: 0 }),
      )
      .respond(jsonResponse({ ok: true }))
      .respond(jsonResponse({ job_id: "job-1" }));

    await bulkAssignSourceCategory([1, 2], "Mods");
    await deleteSource(2);
    await expect(startImportScan(9)).resolves.toBe("job-1");

    expect(http.requestJson(0)).toEqual({
      source_ids: [1, 2],
      category: "Mods",
    });
    expect(http.calls[1]?.[0]).toContain("/sources/2");
    expect(http.requestJson(2)).toEqual({ project_id: 9 });
  });
});
