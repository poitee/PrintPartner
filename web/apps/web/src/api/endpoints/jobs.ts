import type { JobSnapshot } from "@print-partner/contracts";
import { engineFetch } from "../engineTransport";

const JOB_TERMINAL = new Set(["done", "error", "cancelled"]);

export type StlPackGroupBy = "color" | "color_dir";

export type ExportStlPackOptions = {
  profile_id: number;
  missing_only?: boolean;
  group_by?: StlPackGroupBy;
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
  options?: Pick<ExportStlPackOptions, "missing_only" | "group_by">,
): Promise<string> {
  const body = await engineFetch<{ job_id: string }>("/jobs/export-stl-pack", {
    method: "POST",
    body: JSON.stringify({
      profile_id: profileId,
      missing_only: options?.missing_only ?? false,
      group_by: options?.group_by ?? "color_dir",
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
