import type { AppUpdateCheckResponse } from "@print-partner/contracts";
import type { ServerConfig } from "../config.js";

export type UpdateCheckConfig = Pick<
  ServerConfig,
  | "version"
  | "deployMode"
  | "updateCheckEnabled"
  | "githubRepo"
  | "latestVersionOverride"
  | "updateCheckCacheHours"
>;

type GitHubRelease = {
  tag_name?: string;
  html_url?: string;
  body?: string;
};

type CacheEntry = {
  expiresAt: number;
  result: AppUpdateCheckResponse;
};

let cache: CacheEntry | null = null;

/** Strip common prefixes/suffixes so health and GitHub tags compare cleanly. */
export function normalizeAppVersion(raw: string): string {
  let v = raw.trim();
  if (/^v/i.test(v)) v = v.slice(1);
  v = v.replace(/-web$/i, "");
  const match = /^(\d+(?:\.\d+)*)/.exec(v);
  return match?.[1] ?? "0.0.0";
}

/** Semver-style numeric compare on major.minor.patch segments. */
export function compareAppVersions(a: string, b: string): -1 | 0 | 1 {
  const parse = (v: string) =>
    normalizeAppVersion(v)
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
}

export function isUpdateAvailable(current: string, latest: string): boolean {
  return compareAppVersions(current, latest) < 0;
}

function baseResponse(config: UpdateCheckConfig): AppUpdateCheckResponse {
  return {
    enabled: config.updateCheckEnabled,
    update_available: false,
    current_version: config.version,
    latest_version: null,
    release_url: null,
    release_notes_url: null,
    deploy_mode: config.deployMode,
    checked_at: null,
  };
}

function releaseNotesUrl(releaseUrl: string | null, repo: string): string | null {
  if (releaseUrl) return releaseUrl;
  return `https://github.com/${repo}/releases`;
}

async function fetchLatestFromGitHub(
  repo: string,
  fetchImpl: typeof fetch,
): Promise<{ version: string; releaseUrl: string } | null> {
  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  const res = await fetchImpl(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "PrintPartner-UpdateCheck",
    },
  });
  if (!res.ok) return null;
  const body = (await res.json()) as GitHubRelease;
  const tag = body.tag_name?.trim();
  if (!tag) return null;
  const releaseUrl = body.html_url?.trim() || `https://github.com/${repo}/releases/latest`;
  return { version: tag, releaseUrl };
}

export type CheckAppUpdateOptions = {
  fetchImpl?: typeof fetch;
  now?: () => number;
};

export async function checkAppUpdate(
  config: UpdateCheckConfig,
  options: CheckAppUpdateOptions = {},
): Promise<AppUpdateCheckResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;

  if (!config.updateCheckEnabled) {
    return baseResponse(config);
  }

  const cacheMs = Math.max(1, config.updateCheckCacheHours) * 60 * 60 * 1000;
  if (cache && cache.expiresAt > now()) {
    return {
      ...cache.result,
      current_version: config.version,
      deploy_mode: config.deployMode,
    };
  }

  const checkedAt = new Date(now()).toISOString();
  let latestVersion: string | null = null;
  let releaseUrl: string | null = null;

  try {
    if (config.latestVersionOverride) {
      latestVersion = config.latestVersionOverride;
      releaseUrl = releaseNotesUrl(null, config.githubRepo);
    } else {
      const remote = await fetchLatestFromGitHub(config.githubRepo, fetchImpl);
      if (remote) {
        latestVersion = remote.version;
        releaseUrl = remote.releaseUrl;
      }
    }
  } catch {
    /* offline or GitHub unavailable — no banner */
  }

  const result: AppUpdateCheckResponse = {
    enabled: true,
    update_available:
      latestVersion != null && isUpdateAvailable(config.version, latestVersion),
    current_version: config.version,
    latest_version: latestVersion,
    release_url: releaseUrl,
    release_notes_url: releaseNotesUrl(releaseUrl, config.githubRepo),
    deploy_mode: config.deployMode,
    checked_at: checkedAt,
  };

  cache = { expiresAt: now() + cacheMs, result };
  return result;
}

/** Test helper — clears in-memory cache between cases. */
export function resetAppUpdateCheckCache(): void {
  cache = null;
}
