/**
 * Turn the flat category path list into pickable menu / select options that
 * still read as a tree: leaf name for the label, indentation for the depth,
 * full path as the value.
 */

import { categoryDepth, categoryLeafName, normalizeCategoryPath } from "@print-partner/contracts";
import type { CSSProperties } from "react";
import { UNCATEGORISED_FILTER } from "../components/sources/sourceLabels";

export type CategoryMenuOption = {
  /** Full path — the stored value, e.g. `"Printers/Frame"`. */
  path: string;
  /** Leaf name shown to the user, e.g. `"Frame"`. */
  label: string;
  /** Parent chain for tooltips and flat contexts, e.g. `"Printers"`. */
  parentLabel: string | null;
  depth: number;
  indentStyle: CSSProperties | undefined;
};

export function categoryMenuOptions(
  categories: readonly string[],
): CategoryMenuOption[] {
  const options: CategoryMenuOption[] = [];
  for (const raw of categories) {
    const path = normalizeCategoryPath(raw);
    // The Uncategorised sentinel is offered separately by every caller.
    if (!path || path === UNCATEGORISED_FILTER) continue;
    const depth = categoryDepth(path);
    options.push({
      path,
      label: categoryLeafName(path),
      parentLabel: depth > 0 ? path.slice(0, path.length - categoryLeafName(path).length - 1) : null,
      depth,
      indentStyle: depth > 0 ? { paddingLeft: `${0.5 + depth * 0.75}rem` } : undefined,
    });
  }
  return options;
}
