import type {
  PlanDraftIdentity,
  PlanDraftWorkspace,
} from "@print-partner/contracts";

/**
 * The draft a Plan-sheet edit should land on: the newest one still open.
 * Drafts are listed oldest first, so the newest sits at the end.
 */
export function latestOpenDraftId(
  drafts: readonly PlanDraftIdentity[] | undefined,
  excludeDraftId: number | null = null,
): number | null {
  let latest: number | null = null;
  for (const draft of drafts ?? []) {
    if (draft.state === "open" && draft.draft_id !== excludeDraftId)
      latest = draft.draft_id;
  }
  return latest;
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
