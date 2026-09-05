import { describe, expect, it } from "vitest";
import { jsonResponse, createEndpointTestHttp } from "../endpointTestHttp";
import {
  exportCommunityManifestDraft,
  fetchManifestBuilder,
  fetchRepoManifest,
  fetchSourcesMaintenance,
  generateManifestDraft,
  importReposTxt,
  importSourceArchive,
  importSourceFiles,
  putRepoManifest,
} from "./sourceArtifacts";

const http = createEndpointTestHttp();

describe("source artifact endpoints", () => {
  it("handles repo manifest endpoints", async () => {
    http
      .respond(
        jsonResponse({
          source_id: 7,
          path: "print-partner.manifest.yaml",
          exists: true,
          manifest_kind: "yaml",
          yaml: "x",
          document: {},
        }),
      )
      .respond(
        jsonResponse({
          source_id: 7,
          path: "print-partner.manifest.yaml",
          saved: true,
          yaml: "x",
          document: {},
        }),
      )
      .respond(
        jsonResponse({
          source_id: 7,
          source: {
            id: 7,
            name: "S",
            url: "u",
            source_kind: "github",
            role: "",
            local_path: null,
          },
          exists: true,
          manifest_kind: "yaml",
          yaml: "x",
          document: {},
          scanned_parts: [],
          path: "print-partner.manifest.yaml",
        }),
      )
      .respond(jsonResponse({ project_id: 7, part_count: 2, yaml: "draft" }));

    await fetchRepoManifest(7);
    await putRepoManifest(7, { yaml: "content" });
    await fetchManifestBuilder(7);
    await generateManifestDraft(7);

    expect(http.calls[0]?.[0]).toContain("/sources/7/repo-manifest");
    expect(http.requestJson(1)).toEqual({ yaml: "content" });
    expect(http.calls[2]?.[0]).toContain("/sources/7/manifest-builder");
    expect(http.calls[3]?.[0]).toContain("/sources/7/manifest-draft");
  });

  it("exports community manifests and imports repos text", async () => {
    http
      .respond(
        jsonResponse({
          slug: "slug",
          manifest_yaml: "m",
          meta_yaml: "meta",
          issue_body: "issue",
        }),
      )
      .respond(
        jsonResponse({
          created: 1,
          updated: 0,
          skipped: 0,
          skipped_names: [],
          results: [],
        }),
      );

    await exportCommunityManifestDraft(7, "slug");
    await importReposTxt({ text: "Repo|https://example.test" });

    expect(http.requestJson(0)).toEqual({ project_id: 7, slug: "slug" });
    expect(http.requestJson(1)).toEqual({ text: "Repo|https://example.test" });
  });

  it("fetches source maintenance", async () => {
    http.respond(
      jsonResponse({
        no_manifest: [],
        catalog_orphans: [],
        empty_categories: [],
        drift: [],
      }),
    );

    await expect(fetchSourcesMaintenance()).resolves.toEqual({
      no_manifest: [],
      catalog_orphans: [],
      empty_categories: [],
      drift: [],
    });
  });

  it("uploads archives and files", async () => {
    http
      .respond(jsonResponse({ id: 7, imported_files: 1 }))
      .respond(jsonResponse({ id: 7, imported_files: 2 }));

    await importSourceArchive(7, new File(["zip"], "source.zip"));
    await importSourceFiles(7, [new File(["stl"], "part.stl")]);

    expect(http.calls[0]?.[0]).toContain("/sources/7/upload-zip");
    expect(http.requestForm(0).get("file")).toBeInstanceOf(File);
    expect(http.calls[1]?.[0]).toContain("/sources/7/upload-files");
    expect(http.requestForm(1).get("relative_paths")).toBe(
      JSON.stringify(["part.stl"]),
    );
  });

  it("rejects empty file uploads and surfaces upload details", async () => {
    await expect(importSourceFiles(7, [])).rejects.toThrow(
      "Select at least one file",
    );
    http.respond(jsonResponse({ detail: "Bad zip" }, 400));
    await expect(
      importSourceArchive(7, new File(["bad"], "bad.zip")),
    ).rejects.toThrow("Bad zip");
  });
});
