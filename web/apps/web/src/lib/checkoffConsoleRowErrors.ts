/**
 * Row-level failures for Checkoff progress mutations.
 *
 * A toast disappears while the operator is still holding a part. A failed
 * checkoff must stay visible on the row it broke, with a Retry that reruns the
 * same operation and keeps the operator's choices.
 */

export type CheckoffRowError = {
  /** What failed, in the operator's words. */
  message: string;
  /** Label for the retry control, naming the action it repeats. */
  retryLabel: string;
  at: string;
};

export type CheckoffRowErrors = Readonly<Record<string, CheckoffRowError>>;

export const NO_CHECKOFF_ROW_ERRORS: CheckoffRowErrors = {};

export function checkoffRowErrorKey(partId: number): string {
  return `part:${partId}`;
}

/** Verification failures belong to the printer job, not to one part. */
export function checkoffLinkErrorKey(linkId: string): string {
  return `link:${linkId}`;
}

export function setCheckoffRowError(
  errors: CheckoffRowErrors,
  key: string,
  error: CheckoffRowError,
): CheckoffRowErrors {
  return { ...errors, [key]: error };
}

export function clearCheckoffRowError(
  errors: CheckoffRowErrors,
  key: string,
): CheckoffRowErrors {
  if (!(key in errors)) return errors;
  const next = { ...errors };
  delete next[key];
  return next;
}

export function getCheckoffRowError(
  errors: CheckoffRowErrors,
  key: string,
): CheckoffRowError | null {
  return errors[key] ?? null;
}

export function hasCheckoffRowErrors(errors: CheckoffRowErrors): boolean {
  return Object.keys(errors).length > 0;
}

/** Newest first, so the error summary reads like the operator's last action. */
export function checkoffRowErrorSummary(
  errors: CheckoffRowErrors,
): { key: string; message: string }[] {
  return Object.entries(errors)
    .sort(([, a], [, b]) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .map(([key, error]) => ({ key, message: error.message }));
}

export type CheckoffMutationAction =
  | "checkoff"
  | "correction"
  | "assembly"
  | "verification"
  | "rejection"
  | "dismissal";

const FAILED_ACTION: Record<CheckoffMutationAction, string> = {
  checkoff: "save the printed count",
  correction: "save the correction",
  assembly: "save assembly state",
  verification: "confirm the printed units",
  rejection: "save the reject",
  dismissal: "dismiss this job",
};

export function describeCheckoffMutationFailure(input: {
  action: CheckoffMutationAction;
  filename: string;
  cause: unknown;
}): string {
  const reason =
    input.cause instanceof Error ? input.cause.message : String(input.cause);
  return `Could not ${FAILED_ACTION[input.action]} for ${input.filename}: ${reason}`;
}
