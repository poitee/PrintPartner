import { normalizeRule } from "@print-partner/domain/import-rules";

export function rulesEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].map(normalizeRule).sort();
  const sortedB = [...b].map(normalizeRule).sort();
  return sortedA.every((rule, i) => rule === sortedB[i]);
}
