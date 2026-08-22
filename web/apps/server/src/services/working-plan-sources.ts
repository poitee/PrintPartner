import { createHash } from "node:crypto";

export const WORKING_SOURCE_SELECTION_FORMAT = "plan-source-selection-v1";
export const MAX_WORKING_PLAN_SOURCES = 64;

export type WorkingSource = {
  readonly kind: "base" | "addon";
  readonly sourceId: number;
};

export type WorkingSourceSelection = {
  readonly format: typeof WORKING_SOURCE_SELECTION_FORMAT;
  readonly digest: string;
  readonly sources: readonly WorkingSource[];
};

export function canonicalWorkingSources(sources: readonly WorkingSource[]): readonly WorkingSource[] {
  if (sources.length > MAX_WORKING_PLAN_SOURCES) {
    throw new Error(`Working Source selection cannot exceed ${MAX_WORKING_PLAN_SOURCES} Sources`);
  }
  const seen = new Set<number>();
  let baseCount = 0;
  const canonical = sources.map((source, index): WorkingSource => {
    if (source.kind !== "base" && source.kind !== "addon") {
      throw new Error("Working Source kind is invalid");
    }
    if (!Number.isSafeInteger(source.sourceId) || source.sourceId < 1) {
      throw new Error("Working Source ID must be a positive safe integer");
    }
    if (seen.has(source.sourceId)) throw new Error("Working Source selection contains a duplicate");
    seen.add(source.sourceId);
    if (source.kind === "base") baseCount += 1;
    if ((index === 0) !== (source.kind === "base")) {
      throw new Error("A non-empty Working Source selection must start with its base Source");
    }
    return { kind: source.kind, sourceId: source.sourceId };
  });
  if (canonical.length > 0 && baseCount !== 1) {
    throw new Error("A non-empty Working Source selection requires exactly one base Source");
  }
  return canonical;
}

export function digestWorkingSources(sources: readonly WorkingSource[]): string {
  const canonical = canonicalWorkingSources(sources);
  return createHash("sha256")
    .update(
      JSON.stringify({
        format: WORKING_SOURCE_SELECTION_FORMAT,
        sources: canonical.map((source) => ({ kind: source.kind, source_id: source.sourceId })),
      }),
    )
    .digest("hex");
}

export function workingSourceSelection(
  sources: readonly WorkingSource[],
): WorkingSourceSelection {
  const canonical = canonicalWorkingSources(sources);
  return {
    format: WORKING_SOURCE_SELECTION_FORMAT,
    digest: digestWorkingSources(canonical),
    sources: canonical,
  };
}

export function workingSourcesEqual(
  left: readonly WorkingSource[],
  right: readonly WorkingSource[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (source, index) =>
        source.kind === right[index]?.kind && source.sourceId === right[index]?.sourceId,
    )
  );
}
