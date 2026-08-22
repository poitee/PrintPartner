import { describe, expect, it } from "vitest";
import {
  applySelectionClick,
  isAllVisibleSelected,
  isRangeClick,
  isToggleClick,
  pruneSelectionToKnownIds,
  selectAllVisible,
  selectionSummaryLabel,
  toggleSelected,
} from "./sourceSelection";

describe("sourceSelection", () => {
  it("detects modifier intents", () => {
    expect(isToggleClick({ ctrlKey: true })).toBe(true);
    expect(isToggleClick({ metaKey: true })).toBe(true);
    expect(isToggleClick({})).toBe(false);
    expect(isRangeClick({ shiftKey: true })).toBe(true);
    expect(isRangeClick({})).toBe(false);
  });

  it("toggles a single id in and out", () => {
    const a = toggleSelected(new Set(), 5);
    expect([...a]).toEqual([5]);
    const b = toggleSelected(a, 5);
    expect([...b]).toEqual([]);
  });

  it("plain click replaces selection with the clicked item", () => {
    const { selection, anchorId } = applySelectionClick({
      selected: new Set([1, 2]),
      anchorId: 1,
      clickedId: 3,
      visibleIds: [1, 2, 3, 4],
      modifiers: {},
    });
    expect([...selection]).toEqual([3]);
    expect(anchorId).toBe(3);
  });

  it("ctrl/cmd click toggles just the clicked item", () => {
    const { selection } = applySelectionClick({
      selected: new Set([1, 2]),
      anchorId: 1,
      clickedId: 2,
      visibleIds: [1, 2, 3, 4],
      modifiers: { ctrlKey: true },
    });
    expect([...selection].sort()).toEqual([1]);

    const { selection: added } = applySelectionClick({
      selected: new Set([1]),
      anchorId: 1,
      clickedId: 3,
      visibleIds: [1, 2, 3, 4],
      modifiers: { metaKey: true },
    });
    expect([...added].sort()).toEqual([1, 3]);
  });

  it("shift click selects a contiguous range from the anchor", () => {
    const { selection, anchorId } = applySelectionClick({
      selected: new Set([1]),
      anchorId: 1,
      clickedId: 4,
      visibleIds: [1, 2, 3, 4, 5],
      modifiers: { shiftKey: true },
    });
    expect([...selection].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect(anchorId).toBe(1); // anchor stays put across shift-extends

    // shift range works backwards too
    const { selection: backward } = applySelectionClick({
      selected: new Set([4]),
      anchorId: 4,
      clickedId: 2,
      visibleIds: [1, 2, 3, 4, 5],
      modifiers: { shiftKey: true },
    });
    expect([...backward].sort((a, b) => a - b)).toEqual([2, 3, 4]);
  });

  it("shift click without a usable anchor falls back to a toggle", () => {
    const { selection, anchorId } = applySelectionClick({
      selected: new Set(),
      anchorId: null,
      clickedId: 3,
      visibleIds: [1, 2, 3],
      modifiers: { shiftKey: true },
    });
    expect([...selection]).toEqual([3]);
    expect(anchorId).toBe(3);

    // anchor id no longer present in the visible set (e.g. filtered out) —
    // falls back to toggling the clicked item within the existing selection.
    const { selection: fallback } = applySelectionClick({
      selected: new Set([9]),
      anchorId: 9,
      clickedId: 3,
      visibleIds: [1, 2, 3],
      modifiers: { shiftKey: true },
    });
    expect([...fallback].sort((a, b) => a - b)).toEqual([3, 9]);
  });

  it("prunes stale ids", () => {
    const pruned = pruneSelectionToKnownIds(new Set([1, 2, 3]), [2, 3, 4]);
    expect([...pruned].sort()).toEqual([2, 3]);
  });

  it("selects all visible ids", () => {
    expect([...selectAllVisible([1, 2, 3])].sort()).toEqual([1, 2, 3]);
  });

  it("reports whether every visible id is selected", () => {
    expect(isAllVisibleSelected(new Set([1, 2, 3]), [1, 2, 3])).toBe(true);
    expect(isAllVisibleSelected(new Set([1, 2]), [1, 2, 3])).toBe(false);
    expect(isAllVisibleSelected(new Set(), [])).toBe(false);
  });

  it("labels selection counts", () => {
    expect(selectionSummaryLabel(1)).toBe("1 source selected");
    expect(selectionSummaryLabel(2)).toBe("2 sources selected");
    expect(selectionSummaryLabel(0)).toBe("0 sources selected");
  });
});
