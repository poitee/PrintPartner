/** Immutable array move (same semantics as @dnd-kit/sortable arrayMove). */
export function moveItem<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  if (
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= items.length ||
    toIndex >= items.length ||
    fromIndex === toIndex
  ) {
    return items;
  }
  const next = items.slice();
  const [removed] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, removed!);
  return next;
}

/** Move by identity when items are primitives or unique by ===. */
export function moveItemById<T>(items: T[], activeId: T, overId: T): T[] {
  const fromIndex = items.indexOf(activeId);
  const toIndex = items.indexOf(overId);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return items;
  return moveItem(items, fromIndex, toIndex);
}
