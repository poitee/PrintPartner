import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A view whose contents are fetched once and can fail.
 *
 * One union rather than parallel `loading` / `error` / `data` fields: "loading,
 * holding stale rows, and also failed" is not a state this workspace has, and
 * a union makes it unrepresentable instead of merely unlikely.
 */
export type AsyncView<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "failed"; message: string };

/**
 * What to show an operator for a thrown value.
 *
 * Every failure in this workspace ends up on screen as persistent copy, and
 * they must all read the same way, so the five call sites share one rule
 * instead of each rewriting the `instanceof Error` ternary.
 */
export function failureMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Run `request` on mount and again whenever `reload` is called.
 *
 * `reload` is what a failed view's Retry calls. It reruns the same request in
 * place rather than remounting, so the choices an operator already made
 * elsewhere in the sheet survive the failure.
 *
 * `request` must be memoized, because a new function identity restarts the
 * request. That is how the caller asks for a different resource: change the
 * closure, and this reloads.
 */
export function useAsyncView<T>({
  request,
  fallbackMessage,
}: {
  request: () => Promise<T>;
  fallbackMessage: string;
}): { view: AsyncView<T>; reload: () => void } {
  const [view, setView] = useState<AsyncView<T>>({ status: "loading" });
  const latestAttempt = useRef(0);

  const reload = useCallback(() => {
    const attempt = ++latestAttempt.current;
    setView({ status: "loading" });
    void request().then(
      (data) => {
        if (attempt === latestAttempt.current) setView({ status: "ready", data });
      },
      (error: unknown) => {
        if (attempt === latestAttempt.current) {
          setView({ status: "failed", message: failureMessage(error, fallbackMessage) });
        }
      },
    );
  }, [request, fallbackMessage]);

  useEffect(() => {
    reload();
    // Discard a reply that arrives after the caller moved on.
    return () => {
      latestAttempt.current += 1;
    };
  }, [reload]);

  return { view, reload };
}
