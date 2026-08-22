import { Octokit } from "@octokit/rest";
import { parseGithubUrl } from "./github-sync.js";
import type { AppRepository } from "../db/repository.js";
import { parseProjectMetadata } from "@print-partner/domain";

export const REMOTE_UPDATE_STATUS_KEY = "remote_update_status";
export const REMOTE_CHECKED_AT_KEY = "remote_checked_at";

export type RemoteUpdateStatus = "up_to_date" | "updates_available" | "unknown";

export async function remoteUpdateStatusOctokit(
  url: string,
  branch: string,
  lastSha: string | null,
  token?: string | null,
  tag?: string | null,
): Promise<RemoteUpdateStatus> {
  const ref = parseGithubUrl(url);
  if (!ref) return "unknown";
  try {
    const octokit = new Octokit(token ? { auth: token } : {});
    const refName = tag?.trim() || branch || ref.branch;
    const { data } = await octokit.repos.getCommit({
      owner: ref.owner,
      repo: ref.repo,
      ref: refName,
    });
    const remoteSha = data.sha;
    const compare = (lastSha ?? "").trim();
    if (!compare) return "unknown";
    return remoteSha === compare ? "up_to_date" : "updates_available";
  } catch {
    return "unknown";
  }
}

function isGitSource(row: {
  localPath: string | null;
  sourceKind: string;
  sourceType: string | null;
  url: string;
}): boolean {
  if (!row.localPath) return false;
  const kind = (row.sourceKind || "").toLowerCase();
  if (kind === "local" || kind === "archive") return false;
  if ((row.sourceType || "git") === "local") return false;
  if ((row.url || "").startsWith("file://")) return false;
  return true;
}

export async function checkAllSourceUpdates(repo: AppRepository): Promise<{
  checked: Array<{ source_id: number; name: string; update_status: RemoteUpdateStatus }>;
  skipped: Array<{ source_id: number; name: string; reason: string }>;
  updates_available: number;
  checked_count: number;
}> {
  const token = repo.getSetting("github_pat");
  const checked: Array<{ source_id: number; name: string; update_status: RemoteUpdateStatus }> = [];
  const skipped: Array<{ source_id: number; name: string; reason: string }> = [];

  for (const source of repo.listSources()) {
    const row = repo.getProjectRow(source.id);
    if (!row || !isGitSource(row)) {
      skipped.push({ source_id: source.id, name: source.name, reason: "not_git" });
      continue;
    }
    const status = await remoteUpdateStatusOctokit(
      row.url,
      row.branch ?? "main",
      row.lastCommitSha,
      token,
      row.tag,
    );
    const now = new Date().toISOString();
    const base = parseProjectMetadata(row.metadataJson) ?? {};
    repo.updateSource(source.id, {
      metadata: {
        ...base,
        [REMOTE_UPDATE_STATUS_KEY]: status,
        [REMOTE_CHECKED_AT_KEY]: now,
      },
    });
    checked.push({ source_id: source.id, name: source.name, update_status: status });
  }

  repo.setSetting("source_update_check_last_run_at", new Date().toISOString());
  return {
    checked,
    skipped,
    updates_available: checked.filter((c) => c.update_status === "updates_available").length,
    checked_count: checked.length,
  };
}
