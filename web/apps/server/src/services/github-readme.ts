import { Octokit } from "@octokit/rest";
import { parseGithubUrl } from "./github-sync.js";
import { readReadmeText } from "../lib/repo-readme.js";

type CacheEntry = { markdown: string; fetchedAt: number; source: "live" | "disk" };

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

function cacheKey(owner: string, repo: string, ref?: string | null): string {
  return `${owner}/${repo}@${ref ?? "default"}`;
}

export type GithubReadmeResult = {
  markdown: string;
  source: "live" | "disk" | "empty";
  cached: boolean;
  path: string | null;
};

/**
 * Live GitHub README via Octokit `GET /repos/{owner}/{repo}/readme`,
 * with short in-memory TTL cache. Falls back to on-disk synced copy.
 */
export async function fetchGithubReadme(options: {
  url: string;
  branch?: string | null;
  tag?: string | null;
  token?: string | null;
  localPath?: string | null;
  live?: boolean;
}): Promise<GithubReadmeResult> {
  const ref = parseGithubUrl(options.url);
  const diskFallback = (): GithubReadmeResult => {
    if (options.localPath) {
      const text = readReadmeText(options.localPath);
      if (text != null) {
        return { markdown: text, source: "disk", cached: false, path: "README.md" };
      }
    }
    return { markdown: "", source: "empty", cached: false, path: null };
  };

  if (!ref) return diskFallback();

  const refName = options.tag?.trim() || options.branch?.trim() || ref.branch;
  const key = cacheKey(ref.owner, ref.repo, refName);
  const wantLive = options.live !== false;

  if (wantLive) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) {
      return {
        markdown: hit.markdown,
        source: hit.source,
        cached: true,
        path: "README.md",
      };
    }

    try {
      const octokit = new Octokit(options.token ? { auth: options.token } : {});
      const res = await octokit.repos.getReadme({
        owner: ref.owner,
        repo: ref.repo,
        ref: refName,
        mediaType: { format: "raw" },
      });
      const markdown =
        typeof res.data === "string"
          ? res.data
          : Buffer.from(
              (res.data as { content?: string; encoding?: string }).content ?? "",
              ((res.data as { encoding?: string }).encoding as BufferEncoding) || "base64",
            ).toString("utf8");
      cache.set(key, { markdown, fetchedAt: Date.now(), source: "live" });
      return { markdown, source: "live", cached: false, path: "README.md" };
    } catch {
      /* fall through to disk */
    }
  }

  return diskFallback();
}

/** Test helper: clear the in-memory README cache. */
export function clearGithubReadmeCache(): void {
  cache.clear();
}
