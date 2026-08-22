import { randomUUID } from "node:crypto";
import type { AssistantProposedAction } from "@print-partner/contracts";

export type SyncActionParams = {
  planId: number;
  projectIds?: number[];
  sourceName?: string | null;
};

export function buildSyncAction(params: SyncActionParams): AssistantProposedAction {
  const projectIds = (params.projectIds ?? []).filter(
    (id) => Number.isFinite(id) && id > 0,
  );
  const sourceName = params.sourceName?.trim() || undefined;
  const syncParams: Record<string, unknown> = {};
  if (projectIds.length > 0) syncParams.project_ids = [...new Set(projectIds)];
  if (sourceName) syncParams.source_name = sourceName;

  const who =
    sourceName ??
    (projectIds.length === 1
      ? `source #${projectIds[0]}`
      : projectIds.length > 1
        ? `${projectIds.length} sources`
        : "sources");

  return {
    id: randomUUID(),
    type: "start_sync",
    plan_id: params.planId,
    label: sourceName ? `Sync ${sourceName}` : "Sync sources",
    summary: `Sync ${who}. Review plan #${params.planId} before rebuilding its parts.`,
    params: syncParams,
  };
}
