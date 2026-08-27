/**
 * Checkoff progress mutations with per-row recovery.
 *
 * Every checkoff, correction, and assembly toggle runs through here so a
 * failure lands on the row that broke, with a Retry that reruns the same
 * operation. The operator never loses their place to a toast.
 */

import { useCallback, useRef, useState } from "react";
import type { ReviewPart } from "../api/endpoints/planManifests";
import {
  checkoffRowErrorKey,
  clearCheckoffRowError,
  describeCheckoffMutationFailure,
  NO_CHECKOFF_ROW_ERRORS,
  setCheckoffRowError,
  type CheckoffRowErrors,
} from "./checkoffConsoleRowErrors";

export type CheckoffProgressMutation = {
  part: ReviewPart;
  action: "checkoff" | "correction" | "assembly";
  run: () => Promise<unknown>;
};

export type CheckoffProgressMutations = {
  rowErrors: CheckoffRowErrors;
  runMutation: (input: CheckoffProgressMutation) => void;
  retryRow: (partId: number) => void;
  clearAll: () => void;
};

export function useCheckoffProgressMutations(): CheckoffProgressMutations {
  const [rowErrors, setRowErrors] = useState<CheckoffRowErrors>(NO_CHECKOFF_ROW_ERRORS);
  const retryHandlers = useRef(new Map<number, () => void>());
  const runRef = useRef<(input: CheckoffProgressMutation) => void>(() => {});

  const runMutation = useCallback((input: CheckoffProgressMutation) => {
    const key = checkoffRowErrorKey(input.part.id);
    retryHandlers.current.set(input.part.id, () => runRef.current(input));
    void input
      .run()
      .then(() => {
        retryHandlers.current.delete(input.part.id);
        setRowErrors((errors) => clearCheckoffRowError(errors, key));
      })
      .catch((cause: unknown) => {
        setRowErrors((errors) =>
          setCheckoffRowError(errors, key, {
            message: describeCheckoffMutationFailure({
              action: input.action,
              filename: input.part.filename,
              cause,
            }),
            retryLabel: "Retry",
            at: new Date().toISOString(),
          }),
        );
      });
  }, []);
  runRef.current = runMutation;

  const retryRow = useCallback((partId: number) => {
    retryHandlers.current.get(partId)?.();
  }, []);

  const clearAll = useCallback(() => {
    retryHandlers.current.clear();
    setRowErrors(NO_CHECKOFF_ROW_ERRORS);
  }, []);

  return { rowErrors, runMutation, retryRow, clearAll };
}
