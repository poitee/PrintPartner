import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { readReadmeText } from "./repo-readme.js";
import { safeOutboundFetch } from "./outbound-url.js";

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"]);
const IMG_MD_RE = /!\[[^\]]*\]\(([^)]+)\)/g;
const IMG_HTML_RE = /<img[^>]+src=["']([^"']+)["']/gi;
const OG_IMAGE_RE =
  /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i;
const OG_IMAGE_RE_ALT =
  /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i;
const USER_AGENT = "PrintPartner/2.0 (source cover)";
const MAX_BYTES = 3_000_000;

export type SourceCoverProject = {
  id: number;
  url: string;
  sourceKind?: string | null;
  sourceType?: string | null;
  localPath?: string | null;
  lastSyncedAt?: string | null;
  metadataJson?: string | null;
};

export function coversDir(dataDir: string): string {
  const path = join(dataDir, "covers");
  mkdirSync(path, { recursive: true });
  return path;
}

function coverImagePath(coversRoot: string, sourceId: number): string {
  return join(coversRoot, `source_${sourceId}.img`);
}

function coverMetaPath(coversRoot: string, sourceId: number): string {
  return join(coversRoot, `source_${sourceId}.meta.json`);
}

export function extractOgImageUrl(html: string): string | null {
  for (const pattern of [OG_IMAGE_RE, OG_IMAGE_RE_ALT]) {
    const match = pattern.exec(html);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return null;
}

export function githubRepoSlug(url: string): [string, string] | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") return null;
  const parts = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  if (parts.length < 2) return null;
  let repo = parts[1];
  if (repo.endsWith(".git")) repo = repo.slice(0, -4);
  return [parts[0], repo];
}

export function githubOpengraphImageUrl(url: string): string | null {
  const slug = githubRepoSlug(url);
  if (!slug) return null;
  const [owner, repo] = slug;
  return `https://opengraph.githubassets.com/1/${owner}/${repo}`;
}

function resolveImageRef(repoRoot: string, ref: string): string | null {
  const cleaned = ref.trim().split(/\s+/)[0] ?? "";
  if (!cleaned || cleaned.startsWith("data:")) return null;
  if (cleaned.startsWith("http://") || cleaned.startsWith("https://")) return null;
  const root = resolve(repoRoot);
  const candidate = resolve(root, cleaned.replace(/^\.\//, ""));
  if (candidate !== root && !candidate.startsWith(`${root}/`)) return null;
  try {
    if (!statSync(candidate).isFile()) return null;
  } catch {
    return null;
  }
  const ext = candidate.slice(candidate.lastIndexOf(".")).toLowerCase();
  return IMAGE_EXTS.has(ext) ? candidate : null;
}

export function findRepoCoverPath(repoRoot: string): string | null {
  if (!existsSync(repoRoot)) return null;

  const text = readReadmeText(repoRoot);
  if (text) {
    for (const pattern of [IMG_MD_RE, IMG_HTML_RE]) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        const resolved = resolveImageRef(repoRoot, match[1] ?? "");
        if (resolved) return resolved;
      }
    }
  }

  for (const name of [
    "cover.png",
    "cover.jpg",
    "preview.png",
    "preview.jpg",
    "hero.png",
    "hero.jpg",
    "banner.png",
    "thumbnail.png",
  ]) {
    const candidate = join(repoRoot, name);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* skip */
    }
  }

  for (const sub of ["assets", "images", "img", ".github"]) {
    const folder = join(repoRoot, sub);
    if (!existsSync(folder)) continue;
    let entries: string[];
    try {
      entries = readdirSync(folder);
    } catch {
      continue;
    }
    entries.sort();
    for (const entry of entries) {
      const path = join(folder, entry);
      try {
        if (!statSync(path).isFile()) continue;
      } catch {
        continue;
      }
      const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
      if (IMAGE_EXTS.has(ext)) return path;
    }
  }
  return null;
}

export function metadataImageUrl(project: SourceCoverProject): string | null {
  const raw = project.metadataJson;
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as unknown;
    if (!data || typeof data !== "object") return null;
    const image = (data as Record<string, unknown>).image_url;
    return image != null ? String(image).trim() : null;
  } catch {
    return null;
  }
}

function cacheKey(project: SourceCoverProject): string {
  const synced = project.lastSyncedAt ?? "";
  const payload = `${project.url}|${synced}|${project.metadataJson ?? ""}`;
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

export function coverCacheIsFresh(coversRoot: string, project: SourceCoverProject): boolean {
  const metaPath = coverMetaPath(coversRoot, project.id);
  const imagePath = coverImagePath(coversRoot, project.id);
  if (!existsSync(metaPath) || !existsSync(imagePath)) return false;
  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { cache_key?: string };
    return meta.cache_key === cacheKey(project);
  } catch {
    return false;
  }
}

function writeCache(
  coversRoot: string,
  project: SourceCoverProject,
  imageBytes: Buffer,
  resolvedFrom: string,
): string {
  const imagePath = coverImagePath(coversRoot, project.id);
  const metaPath = coverMetaPath(coversRoot, project.id);
  writeFileSync(imagePath, imageBytes);
  writeFileSync(
    metaPath,
    JSON.stringify({
      cache_key: cacheKey(project),
      resolved_from: resolvedFrom,
      source_id: project.id,
    }),
  );
  return imagePath;
}

function copyLocalImage(
  coversRoot: string,
  project: SourceCoverProject,
  path: string,
  resolvedFrom: string,
): string | null {
  let data: Buffer;
  try {
    data = readFileSync(path);
  } catch {
    return null;
  }
  if (!data.length || data.length > MAX_BYTES) return null;
  return writeCache(coversRoot, project, data, resolvedFrom);
}

export async function downloadRemoteImage(url: string): Promise<Buffer | null> {
  try {
    // SSRF guard: cover URLs are user-influenced; redirects are validated per hop.
    const response = await safeOutboundFetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return null;
    const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!contentType.startsWith("image/")) return null;
    const data = Buffer.from(await response.arrayBuffer());
    if (!data.length || data.length > MAX_BYTES) return null;
    return data;
  } catch {
    return null;
  }
}

async function downloadToCache(
  coversRoot: string,
  project: SourceCoverProject,
  url: string,
  resolvedFrom: string,
): Promise<string | null> {
  const data = await downloadRemoteImage(url);
  if (!data) return null;
  return writeCache(coversRoot, project, data, resolvedFrom);
}

export type CoverCandidate = { resolvedFrom: string; target: string };

export function resolveCoverCandidates(project: SourceCoverProject): CoverCandidate[] {
  const candidates: CoverCandidate[] = [];

  const metaUrl = metadataImageUrl(project);
  if (metaUrl) candidates.push({ resolvedFrom: "metadata", target: metaUrl });

  const kind = project.sourceKind ?? "github";
  if (kind === "github" || (project.sourceType ?? "git") === "git") {
    const og = githubOpengraphImageUrl(project.url ?? "");
    if (og) candidates.push({ resolvedFrom: "github_og", target: og });
  }

  if (project.localPath) {
    const local = findRepoCoverPath(project.localPath);
    if (local) candidates.push({ resolvedFrom: "repo_file", target: local });
  }

  if (["printables", "makerworld", "self"].includes(kind) && project.url && !metaUrl) {
    candidates.push({ resolvedFrom: "page_refetch", target: project.url.trim() });
  }

  return candidates;
}

export async function ensureSourceCover(
  coversRoot: string,
  project: SourceCoverProject,
  options?: { force?: boolean },
): Promise<string | null> {
  if (!options?.force && coverCacheIsFresh(coversRoot, project)) {
    return coverImagePath(coversRoot, project.id);
  }

  for (const { resolvedFrom, target } of resolveCoverCandidates(project)) {
    if (resolvedFrom === "page_refetch") {
      try {
        const response = await safeOutboundFetch(target, {
          headers: { "User-Agent": USER_AGENT },
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) continue;
        const imageUrl = extractOgImageUrl(await response.text());
        if (imageUrl) {
          const cached = await downloadToCache(coversRoot, project, imageUrl, "og_image");
          if (cached) return cached;
        }
      } catch {
        /* try next candidate */
      }
      continue;
    }

    if (resolvedFrom === "repo_file") {
      const cached = copyLocalImage(coversRoot, project, target, resolvedFrom);
      if (cached) return cached;
      continue;
    }

    const cached = await downloadToCache(coversRoot, project, target, resolvedFrom);
    if (cached) return cached;
  }

  return null;
}

export function coverMediaType(path: string): string {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".svg") return "image/svg+xml";
  return "image/png";
}
