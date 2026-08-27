import type { PlanDraftWorkspace } from "@print-partner/contracts";
import { EngineHttpError } from "../api/engineTransport";

export type ProductionBlock = {
  readonly checkoffLinkCount: number;
  readonly sendQueueItemCount: number;
};

export function planDraftProductionBlockFromError(caught: unknown): ProductionBlock | null {
  if (!(caught instanceof EngineHttpError) || caught.status !== 423) return null;
  if (!caught.body || typeof caught.body !== "object") return null;
  const body = caught.body;
  if (!("code" in body) || body.code !== "production_active") return null;
  return {
    checkoffLinkCount:
      "checkoff_link_count" in body && typeof body.checkoff_link_count === "number"
        ? body.checkoff_link_count
        : 0,
    sendQueueItemCount:
      "send_queue_item_count" in body && typeof body.send_queue_item_count === "number"
        ? body.send_queue_item_count
        : 0,
  };
}

export function planDraftRevisionPartLabels(
  workspace: PlanDraftWorkspace,
): ReadonlyMap<number, string> {
  const labels = new Map<number, string>();
  for (const part of workspace.parts) {
    if (part.base_revision_part_id != null) {
      labels.set(part.base_revision_part_id, part.filename);
    }
  }
  for (const change of workspace.diff.changed) {
    labels.set(change.before.revision_part_id, change.before.filename);
  }
  for (const part of workspace.diff.removed) {
    labels.set(part.revision_part_id, part.filename);
  }
  return labels;
}
