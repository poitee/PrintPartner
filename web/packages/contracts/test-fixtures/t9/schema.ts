import { z } from "zod";
import { boundaryRefinement } from "../../src/wire-schema.js";

// Conformance probe, not an HTTP route. Production autosave uses the frozen
// corpus alongside this probe; this isolates input/output conversion semantics.
export const semanticFixtureSchema = z.object({
  optional: z.string().optional(),
  nullable: z.string().nullable(),
  defaulted: z.number().int().min(0).max(10).default(3),
  mode: z.enum(["read", "write"]),
  integer: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  date: z.iso.date(),
  text: z.string().min(1).max(4),
}).check(boundaryRefinement("semantic-write", (value, context) => {
  if (value.mode === "write" && value.defaulted === 0) {
    context.addIssue({ code: "custom", message: "write_requires_positive_default" });
  }
}));
