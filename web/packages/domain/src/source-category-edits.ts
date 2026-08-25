/**
 * Edits on the saved category list: add, rename / re-parent, delete.
 *
 * Each helper takes the current flat path list and returns the next list plus
 * the `replacements` map `saveSourceCategories` needs to move already-filed
 * Sources along with the change. They are pure, so tools can validate an edit
 * before proposing it and replay the same computation on apply.
 */

import {
  categoryAncestorPaths,
  categoryLeafName,
  categoryParentPath,
  categoryPathSegments,
  isCategoryPathWithin,
  joinCategoryPath,
  normalizeCategoryPath,
} from "@print-partner/contracts";

export type SourceCategoryEdit = {
  categories: string[];
  replacements: Record<string, string | null>;
};

/** Case-insensitive lookup returning the saved spelling of `raw`, or `null`. */
export function findSourceCategoryPath(
  categories: readonly string[],
  raw: string | null | undefined,
): string | null {
  const wanted = normalizeCategoryPath(raw).toLowerCase();
  if (!wanted) return null;
  return categories.find((path) => path.toLowerCase() === wanted) ?? null;
}

/**
 * Add `path` (creating missing ancestors), inserted directly after its parent's
 * existing subtree so the flat list still reads as a tree.
 */
export function addSourceCategoryPath(
  categories: readonly string[],
  rawPath: string,
): SourceCategoryEdit {
  const path = normalizeCategoryPath(rawPath);
  if (!path) throw new Error("Category name is required");
  if (findSourceCategoryPath(categories, path)) {
    throw new Error(`Category already exists: ${path}`);
  }

  const next = [...categories];
  // Ancestors first, so each insert can anchor on a parent that already exists.
  for (const step of [...categoryAncestorPaths(path), path]) {
    if (findSourceCategoryPath(next, step)) continue;
    const parent = categoryParentPath(step);
    if (!parent) {
      next.push(step);
      continue;
    }
    let insertAt = next.length;
    for (let i = 0; i < next.length; i++) {
      if (isCategoryPathWithin(next[i]!, parent)) insertAt = i + 1;
    }
    next.splice(insertAt, 0, step);
  }

  return { categories: next, replacements: {} };
}

/**
 * Rename `path` and/or move it under `newParent` (`null`/`""` = top level).
 * Subcategories keep their relative position and their Sources follow.
 */
export function moveSourceCategoryPath(
  categories: readonly string[],
  rawPath: string,
  options: { newName?: string | null; newParent?: string | null },
): SourceCategoryEdit {
  const path = findSourceCategoryPath(categories, rawPath);
  if (!path) throw new Error(`Unknown category: ${normalizeCategoryPath(rawPath) || rawPath}`);

  const name = options.newName == null ? categoryLeafName(path) : options.newName.trim();
  if (!name) throw new Error("Category names cannot be empty");
  if (categoryPathSegments(name).length > 1) {
    throw new Error("new_name is a single name — use new_parent to move a category");
  }

  const reparent = options.newParent !== undefined;
  const rawParent = normalizeCategoryPath(options.newParent ?? "");
  let parent: string | null;
  if (!reparent) {
    parent = categoryParentPath(path);
  } else if (!rawParent) {
    parent = null;
  } else {
    parent = findSourceCategoryPath(categories, rawParent);
    if (!parent) throw new Error(`Unknown parent category: ${rawParent}`);
  }

  const target = joinCategoryPath([...(parent ? categoryPathSegments(parent) : []), name]);
  if (target.toLowerCase() === path.toLowerCase()) {
    return { categories: [...categories], replacements: {} };
  }
  if (isCategoryPathWithin(target, path)) {
    throw new Error(`Cannot move “${path}” inside itself`);
  }
  if (findSourceCategoryPath(categories, target)) {
    throw new Error(`Category already exists: ${target}`);
  }

  const replacements: Record<string, string | null> = {};
  const next = categories.map((candidate) => {
    if (!isCategoryPathWithin(candidate, path)) return candidate;
    const remainder = categoryPathSegments(candidate).slice(categoryPathSegments(path).length);
    const moved = joinCategoryPath([...categoryPathSegments(target), ...remainder]);
    replacements[candidate] = moved;
    return moved;
  });

  return { categories: next, replacements };
}

/**
 * Delete `path` and everything under it. Sources move to `reassignTo` when
 * given; otherwise `saveSourceCategories` drops them to the nearest surviving
 * ancestor, or Uncategorised at the top level.
 */
export function deleteSourceCategoryPath(
  categories: readonly string[],
  rawPath: string,
  reassignTo?: string | null,
): SourceCategoryEdit {
  const path = findSourceCategoryPath(categories, rawPath);
  if (!path) throw new Error(`Unknown category: ${normalizeCategoryPath(rawPath) || rawPath}`);

  const next = categories.filter((candidate) => !isCategoryPathWithin(candidate, path));
  if (!next.length) throw new Error("Keep at least one category");

  const replacements: Record<string, string | null> = {};
  const wantedTarget = normalizeCategoryPath(reassignTo ?? "");
  if (wantedTarget) {
    const target = findSourceCategoryPath(next, wantedTarget);
    if (!target) {
      throw new Error(`Cannot reassign to a category that is being deleted or does not exist: ${wantedTarget}`);
    }
    replacements[path] = target;
  } else if (reassignTo === null) {
    replacements[path] = null;
  }

  return { categories: next, replacements };
}
