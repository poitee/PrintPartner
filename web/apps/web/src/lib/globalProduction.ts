import type { PrinterCheckoffLink, PrinterCheckoffLinkState } from "../api/endpoints/checkoff";
import { productionRoute, progressRoute } from "./routes";
import { WORK_PACKAGE_STATUS_LABEL } from "./workPackageProjection";

export const GLOBAL_PRODUCTION_ACTIVE_STATES = [
  "watching",
  "awaiting_verify",
  "host_failed",
] as const satisfies readonly PrinterCheckoffLinkState[];

export type GlobalProductionJobState = (typeof GLOBAL_PRODUCTION_ACTIVE_STATES)[number];

export type GlobalProductionJob = {
  id: string;
  state: GlobalProductionJobState;
  profileId: number;
  planName: string;
  hostName: string;
  filename: string;
  checkoffHref: string;
  productionHref: string;
};

export type GlobalProductionRecentJob = {
  id: string;
  planName: string;
  filename: string;
  at: string;
  checkoffHref: string;
};

function planNameFor(profileId: number, planNameById: Map<number, string>): string {
  return planNameById.get(profileId)?.trim() || `Build ${profileId}`;
}

export function toGlobalProductionJob(
  link: Pick<
    PrinterCheckoffLink,
    "id" | "state" | "profile_id" | "host_name" | "filename"
  >,
  planNameById: Map<number, string>,
): GlobalProductionJob | null {
  if (
    link.state !== "watching" &&
    link.state !== "awaiting_verify" &&
    link.state !== "host_failed"
  ) {
    return null;
  }
  return {
    id: link.id,
    state: link.state,
    profileId: link.profile_id,
    planName: planNameFor(link.profile_id, planNameById),
    hostName: link.host_name,
    filename: link.filename,
    checkoffHref: progressRoute(link.profile_id),
    productionHref: productionRoute(link.profile_id),
  };
}

export function partitionGlobalProductionJobs(jobs: GlobalProductionJob[]): {
  watching: GlobalProductionJob[];
  awaiting: GlobalProductionJob[];
  failed: GlobalProductionJob[];
} {
  return {
    watching: jobs.filter((job) => job.state === "watching"),
    awaiting: jobs.filter((job) => job.state === "awaiting_verify"),
    failed: jobs.filter((job) => job.state === "host_failed"),
  };
}

export function recentVerifiedJobs(
  links: Array<
    Pick<
      PrinterCheckoffLink,
      | "id"
      | "state"
      | "profile_id"
      | "host_name"
      | "filename"
      | "completed_at"
      | "applied_at"
    >
  >,
  planNameById: Map<number, string>,
  limit = 8,
): GlobalProductionRecentJob[] {
  return [...links]
    .filter((link) => link.state === "verified" || link.state === "applied")
    .sort((a, b) => {
      const at = (link: typeof a) => link.applied_at ?? link.completed_at ?? "";
      return at(b).localeCompare(at(a));
    })
    .slice(0, limit)
    .map((link) => ({
      id: link.id,
      planName: planNameFor(link.profile_id, planNameById),
      filename: link.filename,
      at: link.applied_at ?? link.completed_at ?? "",
      checkoffHref: progressRoute(link.profile_id),
    }));
}

/**
 * The same status words a Production work package uses, so a job reads the same
 * whether the user looks at one Build or the whole workshop.
 */
export function globalProductionJobLabel(state: GlobalProductionJobState): string {
  switch (state) {
    case "watching":
      return WORK_PACKAGE_STATUS_LABEL.printing;
    case "awaiting_verify":
      return WORK_PACKAGE_STATUS_LABEL.needs_verification;
    case "host_failed":
      return WORK_PACKAGE_STATUS_LABEL.failed;
  }
}
