/**
 * Multi-select state helpers for the Library/Sources page bulk category
 * assignment UX. Pure functions so the click/shift/ctrl semantics and
 * "select all" behaviors are unit-testable without mounting React.
 */

export type SelectionModifiers = {
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
};

/** Cmd/Ctrl-click toggles a single item without disturbing the rest. */
export function isToggleClick(modifiers: SelectionModifiers): boolean {
  return Boolean(modifiers.metaKey || modifiers.ctrlKey);
}

/** Shift-click extends the selection from the anchor to the clicked item. */
export function isRangeClick(modifiers: SelectionModifiers): boolean {
  return Boolean(modifiers.shiftKey);
}

/** Toggle one id in/out of a selection (checkbox click). */
export function toggleSelected(
  selected: ReadonlySet<number>,
  id: number,
): Set<number> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export type SelectionClickResult = {
  selection: Set<number>;
  anchorId: number;
};

/**
 * Compute the next selection after clicking a source card/row.
 * - shift-click: contiguous range from the last anchor to the clicked item
 *   (within `visibleIds` order); falls back to a plain toggle when there is
 *   no usable anchor.
 * - ctrl/cmd-click: toggles just the clicked item, keeping the rest.
 * - plain click: replaces the selection with just the clicked item — callers
 *   should only reach this path while already in "selection mode" (e.g. the
 *   checkbox is what enters it); a plain click with no modifiers on an idle
 *   card should open the source instead of calling this.
 */
export function applySelectionClick(params: {
  selected: ReadonlySet<number>;
  anchorId: number | null;
  clickedId: number;
  visibleIds: readonly number[];
  modifiers: SelectionModifiers;
}): SelectionClickResult {
  const { selected, anchorId, clickedId, visibleIds, modifiers } = params;

  if (isRangeClick(modifiers) && anchorId != null) {
    const from = visibleIds.indexOf(anchorId);
    const to = visibleIds.indexOf(clickedId);
    if (from === -1 || to === -1) {
      return { selection: toggleSelected(selected, clickedId), anchorId: clickedId };
    }
    const [start, end] = from <= to ? [from, to] : [to, from];
    const range = visibleIds.slice(start, end + 1);
    const next = new Set(selected);
    for (const id of range) next.add(id);
    return { selection: next, anchorId };
  }

  if (isToggleClick(modifiers)) {
    return { selection: toggleSelected(selected, clickedId), anchorId: clickedId };
  }

  return { selection: new Set([clickedId]), anchorId: clickedId };
}

/** Keep only ids that still exist (e.g. after a refresh/filter/delete). */
export function pruneSelectionToKnownIds(
  selected: ReadonlySet<number>,
  knownIds: readonly number[],
): Set<number> {
  const known = new Set(knownIds);
  const next = new Set<number>();
  for (const id of selected) {
    if (known.has(id)) next.add(id);
  }
  return next;
}

export function selectAllVisible(visibleIds: readonly number[]): Set<number> {
  return new Set(visibleIds);
}

export function isAllVisibleSelected(
  selected: ReadonlySet<number>,
  visibleIds: readonly number[],
): boolean {
  return visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
}

export function selectionSummaryLabel(count: number): string {
  return count === 1 ? "1 source selected" : `${count} sources selected`;
}
