/**
 * DnD ids for dragging Library / Plan sources (or files inside a source)
 * onto a category drop target. Category is still source-level — dropping a
 * file assigns that file's parent source.
 */

export const UNCATEGORISED_DROP_ID = "__uncategorised__";

export function categoryDropTargetId(category: string | null): string {
  return category == null
    ? `cat-drop:${UNCATEGORISED_DROP_ID}`
    : `cat-drop:${category}`;
}

export function parseCategoryDropTargetId(
  raw: string | number,
): { category: string | null } | null {
  const s = String(raw);
  if (!s.startsWith("cat-drop:")) return null;
  const name = s.slice("cat-drop:".length);
  if (!name || name === "all") return null;
  if (name === UNCATEGORISED_DROP_ID) return { category: null };
  return { category: name };
}

export function librarySourceDragId(sourceId: number): string {
  return `lib-source:${sourceId}`;
}

export function libraryFileDragId(sourceId: number, relativePath: string): string {
  return `lib-file:${sourceId}:${relativePath}`;
}

export function parseLibraryDragPayload(
  raw: string | number,
):
  | { kind: "source"; sourceId: number }
  | { kind: "file"; sourceId: number; relativePath: string }
  | null {
  const s = String(raw);
  if (s.startsWith("lib-source:")) {
    const id = Number(s.slice("lib-source:".length));
    return Number.isFinite(id) ? { kind: "source", sourceId: id } : null;
  }
  if (s.startsWith("lib-file:")) {
    const rest = s.slice("lib-file:".length);
    const colon = rest.indexOf(":");
    if (colon <= 0) return null;
    const id = Number(rest.slice(0, colon));
    const relativePath = rest.slice(colon + 1);
    if (!Number.isFinite(id) || !relativePath) return null;
    return { kind: "file", sourceId: id, relativePath };
  }
  return null;
}
