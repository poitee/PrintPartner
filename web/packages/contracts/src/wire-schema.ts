import { z } from "zod";

/** Explicit opt-in for a custom check which JSON Schema cannot represent.
 * The generator rejects plain custom checks and unknown adapter names.
 * Changing this callback requires updating the matching Rust boundary/corpus.
 */
export const boundaryAdapter = Symbol.for("print-partner.wire-boundary-adapter");
export function boundaryRefinement<T>(adapter: string, fn: (value: T, context: z.RefinementCtx<T>) => void) {
  return Object.assign(z.superRefine(fn), { [boundaryAdapter]: adapter });
}
