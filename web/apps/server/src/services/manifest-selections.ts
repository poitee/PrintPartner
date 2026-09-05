import type { ManifestSelection, ManifestSelections } from "@print-partner/contracts";

export type { ManifestSelection, ManifestSelections } from "@print-partner/contracts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function parseVariantId(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value.trim();
}

export function parseManifestSelections(
  raw: unknown,
  path = "selections",
): ManifestSelections {
  if (!isRecord(raw)) throw new Error(`${path} must be an object`);

  const selections: ManifestSelections = {};
  for (const [groupId, value] of Object.entries(raw)) {
    if (!groupId.trim()) throw new Error(`${path} group ids must not be empty`);
    if (Array.isArray(value)) {
      const ids = value.map((entry, index) =>
        parseVariantId(entry, `${path}.${groupId}[${index}]`),
      );
      if (new Set(ids).size !== ids.length) {
        throw new Error(`${path}.${groupId} must not contain duplicate variant ids`);
      }
      selections[groupId] = ids;
      continue;
    }
    selections[groupId] = parseVariantId(value, `${path}.${groupId}`);
  }
  return selections;
}

export function cloneManifestSelections(
  selections: Readonly<ManifestSelections>,
): ManifestSelections {
  return Object.fromEntries(
    Object.entries(selections).map(([groupId, selection]) => [
      groupId,
      Array.isArray(selection) ? [...selection] : selection,
    ]),
  );
}

export function selectedVariantIds(selection: ManifestSelection | undefined): string[] {
  if (selection == null) return [];
  return [...new Set(Array.isArray(selection) ? selection : [selection])];
}

export function manifestSelectionEqual(
  left: ManifestSelection,
  right: ManifestSelection,
): boolean {
  const leftIds = selectedVariantIds(left).sort();
  const rightIds = selectedVariantIds(right).sort();
  return (
    leftIds.length === rightIds.length &&
    leftIds.every((variantId, index) => variantId === rightIds[index])
  );
}

export function formatManifestSelection(selection: ManifestSelection): string {
  return selectedVariantIds(selection).join(", ");
}
