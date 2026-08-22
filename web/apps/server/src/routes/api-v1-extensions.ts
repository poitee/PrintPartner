import type { FastifyInstance } from "fastify";
import type { ExportArtifact } from "@print-partner/contracts";
import type { AppRepository } from "../db/repository.js";
import { sendProblem } from "../lib/api-error.js";
import type { InProcessJobRunner } from "./jobs.js";

type RouteDeps = { repo: AppRepository; jobs: InProcessJobRunner };

function artifactsFromJobs(
  jobs: InProcessJobRunner,
  profileId: number,
  tenantId: string,
): ExportArtifact[] {
  const listed = jobs.listJobs({ profile_id: profileId }, tenantId);
  const artifacts: ExportArtifact[] = [];
  for (const snap of listed) {
    if (snap.status !== "done" || !snap.result) continue;
    const result = snap.result;
    const downloadUrl =
      typeof result.download_url === "string" ? result.download_url : null;
    const path =
      typeof result.path === "string"
        ? result.path
        : typeof result.root_path === "string"
          ? result.root_path
          : undefined;
    if (!downloadUrl && !path) continue;
    artifacts.push({
      job_id: snap.job_id,
      kind: snap.kind,
      path,
      download_url: downloadUrl,
      manifest_path:
        typeof result.manifest_path === "string" ? result.manifest_path : undefined,
      created_at: snap.updated_at ?? new Date().toISOString(),
    });
  }
  return artifacts;
}

export async function registerApiV1ExtensionRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
): Promise<void> {
  app.get("/plans/:id/artifacts", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!deps.repo.getOwnedProfileIdentity(id)) {
      return sendProblem(reply, 404, "Not Found", "Profile not found");
    }
    return {
      profile_id: id,
      artifacts: artifactsFromJobs(deps.jobs, id, request.tenantId),
    };
  });

  app.get("/jobs", async (request) => {
    const query = request.query as {
      status?: string;
      since?: string;
      profile_id?: string;
    };
    const jobs = deps.jobs.listJobs({
      status: query.status,
      since: query.since,
      profile_id: query.profile_id ? Number(query.profile_id) : undefined,
    }, request.tenantId);
    return { jobs };
  });
}
