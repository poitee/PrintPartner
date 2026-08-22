import { queryKeys } from "../queries/keys";

export const optimisticReviewCacheKey = queryKeys.planReview;

export type OptimisticRollback<T> =
  | { kind: "restore"; previous: T }
  | { kind: "remove" };

export function rollbackOptimisticCache<T>(previous: T | undefined): OptimisticRollback<T> {
  return previous === undefined ? { kind: "remove" } : { kind: "restore", previous };
}
