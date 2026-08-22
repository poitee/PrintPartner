import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  coverCacheIsFresh,
  downloadRemoteImage,
  ensureSourceCover,
  extractOgImageUrl,
  findRepoCoverPath,
  githubOpengraphImageUrl,
  githubRepoSlug,
  resolveCoverCandidates,
} from "./source-cover.js";

// Keep tests hermetic: the SSRF guard resolves hostnames before fetching.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "140.82.112.3", family: 4 }]),
}));

describe("source cover resolution", () => {
  it("parses GitHub repo slugs", () => {
    expect(githubRepoSlug("https://github.com/VoronDesign/Voron-2")).toEqual([
      "VoronDesign",
      "Voron-2",
    ]);
    expect(githubRepoSlug("https://github.com/org/repo.git")).toEqual(["org", "repo"]);
    expect(githubRepoSlug("https://printables.com/model/123")).toBeNull();
  });

  it("builds GitHub opengraph URL", () => {
    expect(githubOpengraphImageUrl("https://github.com/octocat/Hello-World")).toBe(
      "https://opengraph.githubassets.com/1/octocat/Hello-World",
    );
  });

  it("extracts og:image from HTML", () => {
    const html = '<meta property="og:image" content="https://cdn.example.com/hero.jpg" />';
    expect(extractOgImageUrl(html)).toBe("https://cdn.example.com/hero.jpg");
  });

  it("finds cover image from README", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-cover-"));
    writeFileSync(join(dir, "README.md"), "# Kit\n\n![hero](./images/preview.png)\n", "utf8");
    const imgDir = join(dir, "images");
    mkdirSync(imgDir);
    writeFileSync(join(imgDir, "preview.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(findRepoCoverPath(dir)).toBe(join(imgDir, "preview.png"));
    rmSync(dir, { recursive: true, force: true });
  });

  it("orders candidates: metadata, github og, repo file", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-cover-cand-"));
    writeFileSync(join(dir, "cover.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const project = {
      id: 1,
      url: "https://github.com/a/b",
      sourceKind: "github",
      sourceType: "git",
      localPath: dir,
      metadataJson: JSON.stringify({ image_url: "https://cdn.example.com/meta.jpg" }),
    };
    const names = resolveCoverCandidates(project).map((c) => c.resolvedFrom);
    expect(names[0]).toBe("metadata");
    expect(names).toContain("github_og");
    expect(names).toContain("repo_file");
    rmSync(dir, { recursive: true, force: true });
  });

  it("caches downloaded cover and reuses fresh cache", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pp-cover-cache-"));
    const coversRoot = join(dataDir, "covers");
    mkdirSync(coversRoot, { recursive: true });
    const project = {
      id: 42,
      url: "https://github.com/a/b",
      sourceKind: "github",
      sourceType: "git",
      lastSyncedAt: "2026-01-01T00:00:00.000Z",
      metadataJson: null,
    };

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        headers: { get: (k: string) => (k === "content-type" ? "image/png" : null) },
        arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
      })),
    );

    const path = await ensureSourceCover(coversRoot, project);
    expect(path).toBe(join(coversRoot, "source_42.img"));
    expect(coverCacheIsFresh(coversRoot, project)).toBe(true);

    vi.unstubAllGlobals();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("refuses to download covers from private or metadata addresses", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    expect(await downloadRemoteImage("http://127.0.0.1:8080/cover.png")).toBeNull();
    expect(await downloadRemoteImage("http://169.254.169.254/latest/meta-data/")).toBeNull();
    expect(await downloadRemoteImage("http://192.168.1.10/cover.png")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});
