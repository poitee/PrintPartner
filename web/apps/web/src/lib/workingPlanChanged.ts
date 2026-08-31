export const WORKING_PLAN_CHANGED_MESSAGE =
  "Another change reached this Working Plan before it was published. Review the updated quantities and choices, then publish again.";

export class WorkingPlanChangedError extends Error {
  constructor(options?: ErrorOptions) {
    super(WORKING_PLAN_CHANGED_MESSAGE, options);
    this.name = "WorkingPlanChangedError";
  }
}
