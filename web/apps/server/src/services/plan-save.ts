import type { PlanSnapshotPart } from "./plan-drafts.js";

type ChoiceTarget = Readonly<{ partKey: string; relativePath: string; sourceLayer: string | null }>;
export type PlanChoiceChange =
  | Readonly<{ target: ChoiceTarget; kind: "set_included"; value: boolean }>
  | Readonly<{ target: ChoiceTarget; kind: "set_quantity_override"; value: number | null }>;

function normalizedPath(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase().replace(/^\/+|\/+$/g, "");
}

export function applyPlanChoiceChanges<T extends PlanSnapshotPart>(
  parts: readonly T[],
  changes: readonly PlanChoiceChange[],
): { kind: "ready"; parts: readonly T[] } | { kind: "part_not_found" | "part_ambiguous" } {
  const byKey = new Map<string, number[]>();
  const byLayerPath = new Map<string, number[]>();
  const byPath = new Map<string, number[]>();
  const byNormalizedKey = new Map<string, number[]>();
  const add = (index: Map<string, number[]>, key: string, position: number) => {
    const matches = index.get(key);
    if (matches) matches.push(position);
    else index.set(key, [position]);
  };
  parts.forEach((part, position) => {
    const path = normalizedPath(part.relativePath);
    add(byKey, part.partKey, position);
    add(byLayerPath, JSON.stringify([part.sourceLayer, path]), position);
    add(byPath, path, position);
    add(byNormalizedKey, normalizedPath(part.partKey), position);
  });
  const next = [...parts];
  const touched = new Set<string>();
  for (const change of changes) {
    const keyMatches = byKey.get(change.target.partKey) ?? [];
    const restrict = (matches: readonly number[] | undefined) => keyMatches.length > 0
      ? (matches ?? []).filter((position) => keyMatches.includes(position))
      : (matches ?? []);
    const path = normalizedPath(change.target.relativePath);
    const matches = [
      keyMatches,
      restrict(byLayerPath.get(JSON.stringify([change.target.sourceLayer ?? "", path]))),
      restrict(byPath.get(path)),
      restrict(byNormalizedKey.get(normalizedPath(change.target.partKey))),
    ].find((candidates) => candidates.length === 1);
    const position = matches?.[0];
    if (position == null) return { kind: keyMatches.length > 1 ? "part_ambiguous" : "part_not_found" };
    const part = next[position];
    if (!part) throw new Error("Resolved Plan choice is missing");
    const field = `${position}:${change.kind}`;
    if (touched.has(field)) return { kind: "part_ambiguous" };
    touched.add(field);
    next[position] = change.kind === "set_included"
      ? { ...part, included: change.value }
      : { ...part, quantityOverride: change.value, quantityEffective: change.value ?? part.quantityInferred };
  }
  return { kind: "ready", parts: next };
}
