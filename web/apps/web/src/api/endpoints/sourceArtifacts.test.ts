import { describe, expect, it } from "vitest";
import { jsonResponse, createEndpointTestHttp } from "../endpointTestHttp";
import {
  importSourceArchive,
  importSourceFiles,
} from "./sourceArtifacts";

const http = createEndpointTestHttp();

describe("source artifact endpoints", () => {

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
