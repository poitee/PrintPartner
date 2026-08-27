/**
 * Non-drag reordering for the Checkoff worklist.
 *
 * WCAG 2.2 "Dragging Movements" requires a single-pointer alternative to every
 * drag. These helpers back the Move up / Move down / Move to controls, so the
 * list is fully operable by keyboard, switch, or a gloved thumb on a phone.
 *
 * They act on the rows the operator can currently see. The page splices the
 * result back into the full plan order.
 */

import { moveItem } from "./reorderList";
import { progressRowSortableId, type ProgressRowRef } from "./progressListOrder";

export type CheckoffMoveDirection = "up" | "down";

export function checkoffRowIndex(
  rows: readonly ProgressRowRef[],
  sortableId: string,
): number {
  return rows.findIndex((row) => progressRowSortableId(row) === sortableId);
}

export function canMoveCheckoffRow(
  rows: readonly ProgressRowRef[],
  sortableId: string,
  direction: CheckoffMoveDirection,
): boolean {
  const index = checkoffRowIndex(rows, sortableId);
  if (index < 0) return false;
  return direction === "up" ? index > 0 : index < rows.length - 1;
}

export function moveCheckoffRow(
  rows: readonly ProgressRowRef[],
  sortableId: string,
  direction: CheckoffMoveDirection,
): ProgressRowRef[] {
  const index = checkoffRowIndex(rows, sortableId);
  if (index < 0) return [...rows];
  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= rows.length) return [...rows];
  return moveItem([...rows], index, target);
}

/** `position` is 1-based, the same number the operator reads on the row. */
export function moveCheckoffRowToPosition(
  rows: readonly ProgressRowRef[],
  sortableId: string,
  position: number,
): ProgressRowRef[] {
  const index = checkoffRowIndex(rows, sortableId);
  if (index < 0) return [...rows];
  if (!Number.isFinite(position)) return [...rows];
  const target = Math.min(Math.max(1, Math.trunc(position)), rows.length) - 1;
  if (target === index) return [...rows];
  return moveItem([...rows], index, target);
}

export function checkoffRowPositionOptions(
  total: number,
): { value: number; label: string }[] {
  const count = Math.max(0, Math.trunc(total));
  return Array.from({ length: count }, (_, i) => ({
    value: i + 1,
    label: `Position ${i + 1}`,
  }));
}

export function describeCheckoffRowPosition(index: number, total: number): string {
  if (index < 0 || total <= 0) return "Not in the list";
  return `Position ${index + 1} of ${total}`;
}
