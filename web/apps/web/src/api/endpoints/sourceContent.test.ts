import { describe, expect, it } from "vitest";
import { jsonResponse, createEndpointTestHttp } from "../endpointTestHttp";
import {
  createSourceNote,
  deleteSourceNote,
  fetchGitHubPatSettings,
  fetchGithubBranches,
  fetchGithubTags,
  fetchSourceDocMarkdown,
  fetchSourceDocs,
  fetchSourceNotes,
  fetchSourceReadme,
  fetchSourceUpdateCheckSettings,
  saveGitHubPat,
  saveSourceUpdateCheckInterval,
  startCheckSourceUpdates,
  updateSourceNote,
} from "./sourceContent";

const http = createEndpointTestHttp();

describe("source content endpoints", () => {
  it("fetches GitHub branch and tag refs", async () => {
    http
      .respond(
        jsonResponse({
          owner: "o",
          repo: "r",
          default_branch: "main",
          branches: ["main"],
        }),
      )
      .respond(jsonResponse({ owner: "o", repo: "r", tags: ["v1"] }));

    await fetchGithubBranches(" https://github.com/o/r ");
    await fetchGithubTags("https://github.com/o/r");

    expect(http.calls[0]?.[0]).toContain("/sources/github-branches");
    expect(http.calls[0]?.[0]).toContain(
      "url=https%3A%2F%2Fgithub.com%2Fo%2Fr",
    );
    expect(http.calls[1]?.[0]).toContain("/sources/github-tags");
  });

  it("rejects blank GitHub ref URLs and surfaces server details", async () => {
    await expect(fetchGithubBranches(" ")).rejects.toThrow(
      "GitHub repository URL is required",
    );
    http.respond(jsonResponse({ detail: "Bad repo" }, 400));
    await expect(fetchGithubTags("https://example.test")).rejects.toThrow(
      "Bad repo",
    );
  });

  it("reads and writes source update and PAT settings", async () => {
    http
      .respond(jsonResponse({ configured: true, masked: "ghp_***" }))
      .respond(jsonResponse({ configured: true, masked: "ghp_***" }))
      .respond(jsonResponse({ interval_hours: 24 }))
      .respond(jsonResponse({ interval_hours: 12 }))
      .respond(jsonResponse({ job_id: "job-1" }));

    await fetchGitHubPatSettings();
    await saveGitHubPat("token");
    await fetchSourceUpdateCheckSettings();
    await saveSourceUpdateCheckInterval(12);
    await expect(startCheckSourceUpdates()).resolves.toBe("job-1");

    expect(http.requestJson(1)).toEqual({ token: "token" });
    expect(http.requestJson(3)).toEqual({ interval_hours: 12 });
  });

  it("reads source docs and notes", async () => {
    http
      .respond(jsonResponse({ docs: [{ path: "README.md", title: "README" }] }))
      .respond(jsonResponse({ markdown: "# Readme" }))
      .respond(
        jsonResponse({ markdown: "live", source: "remote", cached: false }),
      )
      .respond(jsonResponse({ notes: [] }));

    await expect(fetchSourceDocs(7)).resolves.toEqual([
      { path: "README.md", title: "README" },
    ]);
    await expect(fetchSourceDocMarkdown(7, "docs/Guide.md")).resolves.toBe(
      "# Readme",
    );
    await expect(fetchSourceReadme(7, true)).resolves.toMatchObject({
      markdown: "live",
    });
    await expect(fetchSourceNotes(7, 3)).resolves.toEqual([]);

    expect(http.calls[1]?.[0]).toContain("/sources/7/docs/docs/Guide.md");
    expect(http.calls[2]?.[0]).toContain("/sources/7/readme?live=1");
    expect(http.calls[3]?.[0]).toContain("/sources/7/notes?profile_id=3");
  });

  it("creates, updates, and deletes source notes", async () => {
    http
      .respond(jsonResponse({ id: 1 }))
      .respond(jsonResponse({ id: 1 }))
      .respond(jsonResponse({ ok: true }));

    await createSourceNote(7, {
      title: "Guide",
      body_markdown: "body",
      profile_id: 3,
    });
    await updateSourceNote(7, 1, { body_markdown: "new" });
    await deleteSourceNote(7, 1);

    expect(http.requestJson(0)).toEqual({
      title: "Guide",
      body_markdown: "body",
      profile_id: 3,
    });
    expect(http.requestJson(1)).toEqual({ body_markdown: "new" });
    expect(http.calls[2]?.[0]).toContain("/sources/7/notes/1");
  });
});
