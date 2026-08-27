/**
 * Resolving a Plan row to the Working Plan's Part.
 *
 * The Plan sheet renders the accepted revision; edits land on the open draft.
 * The two carry different id spaces (`ReviewPart.id` is a projection part id,
 * `PlanDraftPartView.base_revision_part_id` is a revision part id), so the row
 * has to be matched by key. `part_key` alone is not enough: it is not unique
 * within a draft (the server's own rebase index stores an array per part key)
 * and a stale draft may not carry the key at all. Fall back to the identity the
 * row actually shows — source layer + relative path — before giving up, and
 * name the failure so the caller can tell the user instead of doing nothing.
 */

export type PlanRowIdentity = {
  readonly match_key: string;
  readonly relative_path: string;
  readonly source_layer: string | null;
};

export type DraftPartCandidate = {
  readonly part_key: string;
  readonly relative_path: string;
  readonly source_layer: string | null;
};

export type DraftPartMatch<T extends DraftPartCandidate> =
  | { readonly kind: "resolved"; readonly part: T }
  | { readonly kind: "missing" }
  | { readonly kind: "ambiguous"; readonly count: number };

/** Match keys are normalized relative paths; row paths keep their original case. */
export function normalizePartPath(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase().replace(/^\/+|\/+$/g, "");
}

function only<T>(candidates: readonly T[]): T | null {
  return candidates.length === 1 ? candidates[0]! : null;
}

export function resolveDraftPart<T extends DraftPartCandidate>(
  parts: readonly T[],
  row: PlanRowIdentity,
): DraftPartMatch<T> {
  const rowPath = normalizePartPath(row.relative_path);
  const rowKey = normalizePartPath(row.match_key);

  const byKey = parts.filter((part) => part.part_key === row.match_key);
  const exact = only(byKey);
  if (exact) return { kind: "resolved", part: exact };

  // Narrow duplicates by the identity the Plan row displays.
  const pool = byKey.length > 0 ? byKey : parts;
  const byLayerAndPath = only(
    pool.filter(
      (part) =>
        (part.source_layer ?? "") === (row.source_layer ?? "") &&
        normalizePartPath(part.relative_path) === rowPath,
    ),
  );
  if (byLayerAndPath) return { kind: "resolved", part: byLayerAndPath };

  const byPath = only(pool.filter((part) => normalizePartPath(part.relative_path) === rowPath));
  if (byPath) return { kind: "resolved", part: byPath };

  // Last resort: key formats that differ only by case or slash shape.
  const byNormalizedKey = only(pool.filter((part) => normalizePartPath(part.part_key) === rowKey));
  if (byNormalizedKey) return { kind: "resolved", part: byNormalizedKey };

  if (byKey.length > 1) return { kind: "ambiguous", count: byKey.length };
  return { kind: "missing" };
}

export function draftPartMatchError(
  match: Exclude<DraftPartMatch<DraftPartCandidate>, { kind: "resolved" }>,
  filename: string,
): string {
  if (match.kind === "ambiguous") {
    return `The Working Plan has ${match.count} Parts matching ${filename}. Rebuild it from Sources to resolve the duplicate before editing.`;
  }
  return `${filename} is not in the Working Plan. Rebuild it from Sources, then retry.`;
}
