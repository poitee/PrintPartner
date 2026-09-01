import { EngineHttpError } from "../api/engineTransport";

export type WorkingPlanRecovery = "refreshed" | "rebuilt_from_sources";

const WORKING_PLAN_CHANGED_MESSAGES: Readonly<Record<WorkingPlanRecovery, string>> = {
  refreshed:
    "Another change reached this Working Plan before it was published. Review the updated quantities and choices, then publish again.",
  rebuilt_from_sources:
    "Sources changed after this Working Plan was created. PrintPartner rebuilt it from the current Sources. Review the updated parts and quantities, then publish again.",
};

export const WORKING_PLAN_CHANGED_MESSAGE = WORKING_PLAN_CHANGED_MESSAGES.refreshed;

export function workingPlanChangedMessage(recovery: WorkingPlanRecovery): string {
  return WORKING_PLAN_CHANGED_MESSAGES[recovery];
}

export function isWorkingPlanInputsChanged(error: unknown): boolean {
  return error instanceof EngineHttpError &&
    error.status === 409 &&
    typeof error.body === "object" &&
    error.body !== null &&
    "code" in error.body &&
    error.body.code === "inputs_changed";
}

export class WorkingPlanChangedError extends Error {
  constructor(
    readonly recovery: WorkingPlanRecovery = "refreshed",
    options?: ErrorOptions,
  ) {
    super(workingPlanChangedMessage(recovery), options);
    this.name = "WorkingPlanChangedError";
  }
}
