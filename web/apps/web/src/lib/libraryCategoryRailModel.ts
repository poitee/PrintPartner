import {
  buildSourceCategoryTree,
  categoryParentPath,
  flattenSourceCategoryTree,
  isCategoryPathWithin,
  type SourceCategoryNode,
} from "@print-partner/contracts";
import { moveItemById } from "./reorderList";
import { rollupCategoryCount } from "./sourceCategoryAssignment";
import { categorySwatch } from "./librarySourceMeta";
import { UNCategorized_FILTER, type SourceKind } from "../components/sources/sourceLabels";

export type LibraryAddKind = SourceKind | "plan_bundle" | "repos_txt";

export type LibraryCategoryRow = {
  id: string;
  /** Full category path; `"all"` / the Uncategorised sentinel for the fixed rows. */
  name: string;
  /** Leaf name shown in the rail. */
  label: string;
  depth: number;
  count: number;
  swatch: string;
  sortable: boolean;
  hasChildren: boolean;
  collapsed: boolean;
};

export const LIBRARY_ADD_ACTIONS: readonly {
  id: string;
  kind: LibraryAddKind;
  label: string;
}[] = [
  { id: "github", kind: "github", label: "GitHub repo" },
  { id: "local-folder", kind: "local", label: "Local folder" },
  { id: "archive", kind: "archive", label: "Zip upload" },
  { id: "printables", kind: "printables", label: "Printables model" },
  { id: "makerworld", kind: "makerworld", label: "MakerWorld model" },
  { id: "thangs", kind: "thangs", label: "Thangs model" },
  { id: "single-stl", kind: "local", label: "Single STL" },
  { id: "plan-bundle", kind: "plan_bundle", label: "Plan bundle" },
  { id: "self", kind: "self", label: "Another instance" },
];

/**
 * Rail rows for the category tree, skipping anything inside a collapsed parent.
 * Counts roll up, so "Printers" shows its own Sources plus every subcategory's.
 */
export function buildLibraryCategoryRows(
  tree: SourceCategoryNode[],
  sourcesByCategory: Map<string | null, number>,
  totalCount: number,
  collapsed: ReadonlySet<string>,
): LibraryCategoryRow[] {
  const uncategorized = sourcesByCategory.get(null) ?? 0;
  const categoryRows: LibraryCategoryRow[] = [];

  for (const node of flattenSourceCategoryTree(tree)) {
    const hiddenByParent = [...collapsed].some(
      (path) => path !== node.path && isCategoryPathWithin(node.path, path),
    );
    if (hiddenByParent) continue;
    categoryRows.push({
      id: node.path,
      name: node.path,
      label: node.name,
      depth: node.depth,
      count: rollupCategoryCount(sourcesByCategory, node.path),
      swatch: categorySwatch(node.path),
      sortable: true,
      hasChildren: node.children.length > 0,
      collapsed: collapsed.has(node.path),
    });
  }

  return [
    {
      id: "all",
      name: "all",
      label: "All sources",
      depth: 0,
      count: totalCount,
      swatch: "var(--primary)",
      sortable: false,
      hasChildren: false,
      collapsed: false,
    },
    ...categoryRows,
    {
      id: UNCategorized_FILTER,
      name: UNCategorized_FILTER,
      label: "Uncategorised",
      depth: 0,
      count: uncategorized,
      swatch: "var(--border)",
      sortable: false,
      hasChildren: false,
      collapsed: false,
    },
  ];
}

/** Reorder `active` next to `over` when both share a parent; otherwise no-op. */
export function reorderCategoriesWithinSiblings(
  categories: readonly string[],
  activePath: string,
  overPath: string,
): string[] | null {
  const parent = categoryParentPath(activePath);
  if (parent !== categoryParentPath(overPath)) return null;

  const tree = buildSourceCategoryTree(categories);
  const siblings = parent
    ? flattenSourceCategoryTree(tree).find((node) => node.path === parent)?.children
    : tree;
  if (!siblings) return null;

  const order = moveItemById(
    siblings.map((node) => node.path),
    activePath,
    overPath,
  );
  const ordered = order.map((path) => siblings.find((node) => node.path === path)!);

  const emit = (nodes: readonly SourceCategoryNode[], out: string[]) => {
    for (const node of nodes) {
      out.push(node.path);
      emit(node.children, out);
    }
  };
  const next: string[] = [];
  const walk = (nodes: readonly SourceCategoryNode[]) => {
    for (const node of nodes) {
      next.push(node.path);
      if (node.path === parent) {
        emit(ordered, next);
        continue;
      }
      walk(node.children);
    }
  };
  if (parent) walk(tree);
  else emit(ordered, next);

  return next;
}

/** Indent one level per nesting step, leaving room for the expand chevron. */
export function categoryRailIndentStyle(depth: number): { paddingLeft: string } | undefined {
  return depth > 0 ? { paddingLeft: `${depth * 0.75}rem` } : undefined;
}
