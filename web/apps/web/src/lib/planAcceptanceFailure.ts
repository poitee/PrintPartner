import { EngineHttpError } from "../api/engineTransport";
import type { PlanAcceptanceFailure, PlanUnitOutcome } from "./planAcceptanceModel";
import { WorkingPlanChangedError } from "./workingPlanChanged";

/**
 * Turn an acceptance rejection into something the Plan page can show beside the
 * button, in the user's words. The server codes stay internal.
 */
export function planAcceptanceFailureFromError(caught: unknown): PlanAcceptanceFailure {
  if (caught instanceof WorkingPlanChangedError) {
    return { kind: "working_plan_changed", recovery: caught.recovery };
  }
  if (caught instanceof EngineHttpError && caught.body && typeof caught.body === "object") {
    const body = caught.body as Record<string, unknown>;
    if (caught.status === 423 && body.code === "production_active") {
      return {
        kind: "linked_records",
        checkoffLinkCount: typeof body.checkoff_link_count === "number" ? body.checkoff_link_count : 0,
        sendQueueItemCount:
          typeof body.send_queue_item_count === "number" ? body.send_queue_item_count : 0,
      };
    }
    if (caught.status === 422 && body.code === "checkoff_remap_unsafe") {
      const rows = Array.isArray(body.unmappable) ? body.unmappable : [];
      const units: PlanUnitOutcome[] = rows.flatMap((row) => {
        if (row == null || typeof row !== "object") return [];
        const item = row as Record<string, unknown>;
        return [{
          filename: typeof item.filename === "string" ? item.filename : "Unknown file",
          outcome:
            typeof item.reason === "string"
              ? item.reason
              : "This printed work cannot move to the new revision.",
        }];
      });
      return { kind: "unsafe_records", units };
    }
  }
  return {
    kind: "error",
    message: caught instanceof Error ? caught.message : String(caught),
  };
}

/** Units listed by a failed move, ready for the acceptance receipt. */
export function unmovedUnits(failure: PlanAcceptanceFailure | null): readonly PlanUnitOutcome[] {
  return failure?.kind === "unsafe_records" ? failure.units : [];
}
