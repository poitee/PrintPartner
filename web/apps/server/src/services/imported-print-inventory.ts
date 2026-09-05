import type { AdditionalPrintDecision, AdditionalPrintResult, ImportedPrintInventory } from "@print-partner/contracts";
import { isPrintRejectReason } from "./printer-outcomes-store.js";

function readResult(raw: unknown): AdditionalPrintResult | null {
  if (!raw || typeof raw !== "object" || !("result" in raw)) return null;
  if (raw.result === "confirmed") return { result: "confirmed" };
  if (raw.result !== "rejected" || !("reason" in raw) || !isPrintRejectReason(raw.reason)) return null;
  if ("note" in raw && raw.note !== undefined && typeof raw.note !== "string") return null;
  return { result: "rejected", reason: raw.reason,
    ...("note" in raw && typeof raw.note === "string" ? { note: raw.note.trim().slice(0, 500) } : {}) };
}

export function readAdditionalDecisions(raw: unknown): AdditionalPrintDecision[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 500) return null;
  const decisions: AdditionalPrintDecision[] = [];
  const seen = new Set<number>();
  for (const value of raw) {
    const item: unknown = value;
    const result = readResult(item);
    if (!result || !item || typeof item !== "object" || !("index" in item) ||
      typeof item.index !== "number" || !Number.isInteger(item.index) || item.index < 0 || seen.has(item.index)) return null;
    seen.add(item.index);
    decisions.push({ ...result, index: item.index });
  }
  return decisions;
}

export function readImportedInventory(raw: unknown): ImportedPrintInventory | undefined {
  if (!raw || typeof raw !== "object" || !("extras" in raw) || !Array.isArray(raw.extras)) return undefined;
  const extras: ImportedPrintInventory["extras"] = [];
  for (const value of raw.extras) {
    const item: unknown = value;
    if (!item || typeof item !== "object" || !("name" in item) || typeof item.name !== "string" ||
      !("kind" in item) || (item.kind !== "object" && item.kind !== "file") || !("checkoff" in item) ||
      !item.checkoff || typeof item.checkoff !== "object" || !("result" in item.checkoff)) return undefined;
    if (item.checkoff.result === "pending") {
      extras.push({ name: item.name, kind: item.kind, checkoff: { result: "pending" } });
    } else {
      const result = readResult(item.checkoff);
      if (!result || !("checked_at" in item.checkoff) || typeof item.checkoff.checked_at !== "string") return undefined;
      extras.push({ name: item.name, kind: item.kind, checkoff: { ...result, checked_at: item.checkoff.checked_at } });
    }
  }
  return { extras };
}

export function resolveAdditionalDecisions(
  inventory: ImportedPrintInventory | undefined,
  decisions: readonly AdditionalPrintDecision[],
  checkedAt: string,
): ImportedPrintInventory | undefined | null {
  if (!decisions.length) return inventory;
  if (!inventory) return null;
  const extras = inventory.extras.map((extra) => ({ ...extra }));
  const seen = new Set<number>();
  for (const { index, ...result } of decisions) {
    const extra = extras[index];
    if (!extra || extra.checkoff.result !== "pending" || seen.has(index)) return null;
    seen.add(index);
    extras[index] = { ...extra, checkoff: { ...result, checked_at: checkedAt } };
  }
  return { extras };
}
