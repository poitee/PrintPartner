import type { JobSnapshot } from "@print-partner/contracts";
import { engineFetch } from "../engineTransport";

const JOB_TERMINAL = new Set(["done", "error", "cancelled"]);

export type StlPackGroupBy = "color" | "color_dir";

export type ExportStlPackOptions = {
  profile_id: number;
  missing_only?: boolean;
  group_by?: StlPackGroupBy;
  /**
   * Required-unit tokens the pack is limited to, in the branded `ppu_` spelling
   * the Accepted Plan uses. Omitted or empty means every included part, which
   * is what every caller before the Production route choice asked for. The
   * server ANDs this with `missing_only`.
   */
  unit_tokens?: readonly string[];
};

export async function startSync(projectIds?: number[]): Promise<string> {
  const body = await engineFetch<{ job_id: string }>("/jobs/sync", {
    method: "POST",
    body: JSON.stringify(projectIds && projectIds.length ? { project_ids: projectIds } : {}),
  });
  return body.job_id;
}

export async function startExportKitBundle(
  profileId: number,
  includePrintProgress = false,
): Promise<string> {
  const body = await engineFetch<{ job_id: string }>("/jobs/export-kit-bundle", {
    method: "POST",
    body: JSON.stringify({
      profile_id: profileId,
      include_print_progress: includePrintProgress,
    }),
  });
  return body.job_id;
}

export async function startExportStlPack(
  profileId: number,
  options?: Pick<ExportStlPackOptions, "missing_only" | "group_by" | "unit_tokens">,
): Promise<string> {
  const body = await engineFetch<{ job_id: string }>("/jobs/export-stl-pack", {
    method: "POST",
    body: JSON.stringify({
      profile_id: profileId,
      missing_only: options?.missing_only ?? false,
      group_by: options?.group_by ?? "color_dir",
      ...(options?.unit_tokens?.length ? { unit_tokens: [...options.unit_tokens] } : {}),
    }),
  });
  return body.job_id;
}

export async function startExportChecklistHtml(profileId: number): Promise<string> {
  const body = await engineFetch<{ job_id: string }>("/jobs/export-checklist-html", {
    method: "POST",
    body: JSON.stringify({ profile_id: profileId }),
  });
  return body.job_id;
}

export async function fetchJob(jobId: string): Promise<JobSnapshot> {
  return engineFetch<JobSnapshot>(`/jobs/${jobId}`);
}

export async function waitForJobDone(jobId: string): Promise<JobSnapshot> {
  for (;;) {
    const snap = await fetchJob(jobId);
    if (JOB_TERMINAL.has(snap.status)) return snap;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}
