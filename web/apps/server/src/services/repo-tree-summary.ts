/**
 * Pure repo-tree analysis: folder summaries + variant/option folder detection.
 *
 * Works on plain blob paths so it can run on a GitHub tree listing (pre-sync,
 * no downloads) or on locally synced STL paths. Feeds:
 * - `inspect_repo_tree` / `detect_build_decisions` assistant tools
 * - the sibling-folder option-group fallback in plan-manifest-builder
 */

import type { ManifestOptionGroup, ManifestVariant } from "./manifest-apply.js";

export type RepoTreeSubdirSummary = {
  name: string;
  path: string;
  /** Recursive counts. */
  stl_count: number;
  file_count: number;
};

export type RepoTreeDirSummary = {
  path: string;
  stl_count: number;
  doc_count: number;
  file_count: number;
  subdirs: RepoTreeSubdirSummary[];
};

export type RepoVariantOption = {
  id: string;
  label: string;
  path: string;
  stl_count: number;
  file_count: number;
  deprecated?: boolean;
};

export type RepoVariantCandidate = {
  group_id: string;
  dir: string;
  kind: "variant" | "optional_mod" | "config";
  options: RepoVariantOption[];
  reason: string;
  /** Option id to suggest (e.g. "default" when deprecated alternatives exist). */
  suggested_option?: string;
};

export type RepoTreeSummary = {
  total_files: number;
  total_stls: number;
  total_docs: number;
  top_level_dirs: RepoTreeDirSummary[];
  root_file_count: number;
  variant_candidates: RepoVariantCandidate[];
  truncated: boolean;
};

const MAX_TOP_DIRS = 30;
const MAX_SUBDIRS = 20;
const MAX_CANDIDATES = 12;
const MAX_OPTIONS = 16;

/** Folder names that are file-format/media buckets, not build choices. */
const STRUCTURAL_DIR_RE =
  /^(cad|step|stp|3mf|stl|stls|images?|img|pics?|pictures|assets?|gerbers?|3d|archives?|docs?|manuals?|pdf|src|source|step files)$/i;

const MODS_CONTAINER_RE = /^(user[_\s-]?)?mods?$/i;
const OPTIONS_CONTAINER_RE = /\b(options?|recommended|variants?|alternatives?|choose)\b/i;
const OPTIONAL_DIR_RE = /^\(?optional\)?$|\(options?\)|^optional[_\s-]/i;
const VERSION_DIR_RE = /\bversion\b/i;
const DEPRECATED_RE = /deprecated|obsolete|legacy/i;

export function slugifyTreePath(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

function normalizePath(raw: string): string {
  return raw.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function baseName(dirPath: string): string {
  const segs = dirPath.split("/");
  return segs[segs.length - 1] ?? dirPath;
}

function isStl(path: string): boolean {
  return path.toLowerCase().endsWith(".stl");
}

function isDoc(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".pdf");
}

type DirInfo = {
  path: string;
  name: string;
  directStls: number;
  directFiles: number;
  stls: number;
  files: number;
  docs: number;
  children: Set<string>;
};

function buildDirIndex(blobPaths: string[]): Map<string, DirInfo> {
  const dirs = new Map<string, DirInfo>();
  const ensure = (path: string): DirInfo => {
    let info = dirs.get(path);
    if (!info) {
      info = {
        path,
        name: baseName(path),
        directStls: 0,
        directFiles: 0,
        stls: 0,
        files: 0,
        docs: 0,
        children: new Set(),
      };
      dirs.set(path, info);
    }
    return info;
  };
  ensure("");

  for (const raw of blobPaths) {
    const path = normalizePath(raw);
    if (!path) continue;
    const segs = path.split("/");
    const stl = isStl(path);
    const doc = isDoc(path);
    // Walk ancestors: "" (root), seg0, seg0/seg1, …
    let parent = ensure("");
    parent.files += 1;
    if (stl) parent.stls += 1;
    if (doc) parent.docs += 1;
    for (let i = 0; i < segs.length - 1; i++) {
      const dirPath = segs.slice(0, i + 1).join("/");
      const info = ensure(dirPath);
      parent.children.add(dirPath);
      info.files += 1;
      if (stl) info.stls += 1;
      if (doc) info.docs += 1;
      parent = info;
    }
    parent.directFiles += 1;
    if (stl) parent.directStls += 1;
  }
  return dirs;
}

function optionFromDir(info: DirInfo, deprecated?: boolean): RepoVariantOption {
  return {
    id: slugifyTreePath(info.name) || slugifyTreePath(info.path),
    label: info.name,
    path: info.path,
    stl_count: info.stls,
    file_count: info.files,
    ...(deprecated ? { deprecated: true } : {}),
  };
}

function childDirInfos(dirs: Map<string, DirInfo>, info: DirInfo): DirInfo[] {
  return [...info.children]
    .map((c) => dirs.get(c))
    .filter((c): c is DirInfo => Boolean(c))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function nonStructuralChildren(dirs: Map<string, DirInfo>, info: DirInfo): DirInfo[] {
  return childDirInfos(dirs, info).filter(
    (c) => !STRUCTURAL_DIR_RE.test(c.name) && c.files > 0,
  );
}

/**
 * Detect folder-shaped decision points:
 * - mods containers (User_Mods/…) → optional mods
 * - "(options)" / "recommended" folders with sibling choices → variants
 * - lone Optional/(Option) folders → optional include
 * - "… Version" folders next to default files → variant vs default
 * - numeric sibling sets ("3 Lane" / "4 Lane") → config choice
 */
export function detectVariantFolderCandidates(blobPaths: string[]): RepoVariantCandidate[] {
  const dirs = buildDirIndex(blobPaths);
  const candidates: RepoVariantCandidate[] = [];
  const consumedOptionDirs = new Set<string>();

  const sortedDirs = [...dirs.values()]
    .filter((d) => d.path !== "")
    .sort((a, b) => a.path.localeCompare(b.path));

  const pushCandidate = (cand: RepoVariantCandidate) => {
    if (candidates.length >= MAX_CANDIDATES) return;
    if (!cand.options.length) return;
    if (candidates.some((c) => c.group_id === cand.group_id)) return;
    cand.options = cand.options.slice(0, MAX_OPTIONS);
    candidates.push(cand);
    for (const opt of cand.options) consumedOptionDirs.add(opt.path);
  };

  for (const info of sortedDirs) {
    if (DEPRECATED_RE.test(info.path) && !DEPRECATED_RE.test(info.name)) continue;
    if (/archive/i.test(info.path)) continue;
    if (consumedOptionDirs.has(info.path)) continue;

    // Rule A — mods container: each child folder is an optional mod.
    if (MODS_CONTAINER_RE.test(info.name)) {
      const options = nonStructuralChildren(dirs, info).map((c) => optionFromDir(c));
      pushCandidate({
        group_id: slugifyTreePath(info.path),
        dir: info.path,
        kind: "optional_mod",
        options,
        reason: `Mods container folder "${info.path}" — each subfolder is an optional community mod.`,
      });
      continue;
    }

    // Rule B — options container ("PCB (recommended options)", "Deprecated Options").
    if (OPTIONS_CONTAINER_RE.test(info.name) && !OPTIONAL_DIR_RE.test(info.name)) {
      const deprecated = DEPRECATED_RE.test(info.name);
      const children = nonStructuralChildren(dirs, info);
      if (children.length >= 2) {
        const parent = dirs.get(info.path.split("/").slice(0, -1).join("/"));
        const options: RepoVariantOption[] = [];
        // Deprecated alternatives to the parent's current files → offer "default" first.
        if (deprecated && parent && parent.directStls > 0) {
          options.push({
            id: "default",
            label: `Default (${parent.name})`,
            path: parent.path,
            stl_count: parent.directStls,
            file_count: parent.directFiles,
          });
        }
        options.push(...children.map((c) => optionFromDir(c, deprecated)));
        pushCandidate({
          group_id: slugifyTreePath(info.path),
          dir: info.path,
          kind: "variant",
          options,
          reason: deprecated
            ? `Folder "${info.path}" holds deprecated alternatives — default files in "${parent?.path ?? ""}" are usually preferred.`
            : `Folder "${info.path}" groups sibling choices — pick one.`,
          ...(deprecated && options[0]?.id === "default"
            ? { suggested_option: "default" }
            : {}),
        });
        continue;
      }
      if (info.directStls > 0) {
        // e.g. "STL/Stepper/Options" with loose STLs → optional include.
        pushCandidate({
          group_id: slugifyTreePath(info.path),
          dir: info.path,
          kind: "optional_mod",
          options: [optionFromDir(info)],
          reason: `Folder "${info.path}" contains optional alternative parts.`,
        });
        continue;
      }
    }

    // Rule C — explicit optional folder ("Optional", "(Option) TPU_CDR").
    if (OPTIONAL_DIR_RE.test(info.name) && info.stls > 0) {
      pushCandidate({
        group_id: slugifyTreePath(info.path),
        dir: info.path,
        kind: "optional_mod",
        options: [optionFromDir(info)],
        reason: `Folder "${info.path}" is marked optional — include only if wanted.`,
      });
      continue;
    }

    // Rule D — "… Version" alternative next to default files.
    if (VERSION_DIR_RE.test(info.name) && info.stls > 0) {
      const parent = dirs.get(info.path.split("/").slice(0, -1).join("/"));
      if (parent && parent.directStls > 0) {
        pushCandidate({
          group_id: slugifyTreePath(parent.path),
          dir: parent.path,
          kind: "variant",
          options: [
            {
              id: "default",
              label: `Default (${parent.name})`,
              path: parent.path,
              stl_count: parent.directStls,
              file_count: parent.directFiles,
            },
            optionFromDir(info),
          ],
          reason: `"${info.name}" is an alternative version of the default "${parent.path}" parts.`,
          suggested_option: "default",
        });
        continue;
      }
    }
  }

  // Rule E — numeric sibling sets ("3 Lane" / "4 Lane", "2x" / "3x") → config choice.
  for (const info of dirs.values()) {
    if (candidates.length >= MAX_CANDIDATES) break;
    const children = nonStructuralChildren(dirs, info).filter(
      (c) => !consumedOptionDirs.has(c.path) && c.stls > 0,
    );
    const bySkeleton = new Map<string, DirInfo[]>();
    for (const c of children) {
      if (!/\d/.test(c.name)) continue;
      const skeleton = c.name.toLowerCase().replace(/\d+/g, "#").trim();
      const list = bySkeleton.get(skeleton) ?? [];
      list.push(c);
      bySkeleton.set(skeleton, list);
    }
    for (const [skeleton, sibs] of bySkeleton) {
      if (sibs.length < 2) continue;
      pushCandidate({
        group_id: slugifyTreePath(`${info.path || "root"} ${skeleton.replace(/#/g, "n")}`),
        dir: info.path,
        kind: "config",
        options: sibs.map((c) => optionFromDir(c)),
        reason: `Sibling folders under "${info.path || "/"}" differ only by a number — looks like a size/count choice.`,
      });
    }
  }

  return candidates;
}

/** Summarize a repo tree (all blob paths) without downloading any blobs. */
export function summarizeRepoTreePaths(
  blobPaths: string[],
  options?: { truncated?: boolean },
): RepoTreeSummary {
  const dirs = buildDirIndex(blobPaths);
  const root = dirs.get("")!;
  const topLevel = childDirInfos(dirs, root)
    .sort((a, b) => b.stls - a.stls || a.path.localeCompare(b.path))
    .slice(0, MAX_TOP_DIRS)
    .map((d) => ({
      path: d.path,
      stl_count: d.stls,
      doc_count: d.docs,
      file_count: d.files,
      subdirs: childDirInfos(dirs, d)
        .filter((c) => c.files > 0)
        .sort((a, b) => b.stls - a.stls || a.path.localeCompare(b.path))
        .slice(0, MAX_SUBDIRS)
        .map((c) => ({
          name: c.name,
          path: c.path,
          stl_count: c.stls,
          file_count: c.files,
        })),
    }));

  return {
    total_files: root.files,
    total_stls: root.stls,
    total_docs: root.docs,
    top_level_dirs: topLevel,
    root_file_count: root.directFiles,
    variant_candidates: detectVariantFolderCandidates(blobPaths),
    truncated: options?.truncated === true,
  };
}

/**
 * Sibling-folder fallback for plan-manifest-builder: derive option groups from
 * detected variant folders when a repo has no manifest YAML and no path-hints.
 * Only uses STL-bearing options so Build pickers stay actionable.
 */
export function inferSiblingFolderOptionGroups(
  stlPaths: string[],
): Record<string, ManifestOptionGroup> {
  const groups: Record<string, ManifestOptionGroup> = {};
  const candidates = detectVariantFolderCandidates(stlPaths);
  const directStlsUnder = (dirPath: string): string[] =>
    stlPaths
      .map(normalizePath)
      .filter((p) => p.startsWith(`${dirPath}/`) && !p.slice(dirPath.length + 1).includes("/"));

  for (const cand of candidates) {
    if (cand.kind === "optional_mod" && cand.options.length > 1) {
      // One include/skip group per mod so mods stay independently selectable.
      for (const opt of cand.options) {
        if (opt.stl_count <= 0) continue;
        const gid = slugifyTreePath(opt.path);
        if (groups[gid]) continue;
        groups[gid] = {
          rule: "pick_one",
          label: `${opt.label} (optional mod)`,
          parts: [],
          variants: [
            { id: "skip", label: "Skip", parts: [] },
            { id: "include", label: `Include ${opt.label}`, parts: [`${opt.path}/*`] },
          ],
        };
      }
      continue;
    }

    const variants: ManifestVariant[] = [];
    for (const opt of cand.options) {
      if (opt.id === "default") {
        const parts = directStlsUnder(opt.path);
        variants.push({ id: "default", label: opt.label, parts });
        continue;
      }
      if (opt.stl_count <= 0) continue;
      variants.push({ id: opt.id, label: opt.label, parts: [`${opt.path}/*`] });
    }
    if (cand.kind === "optional_mod") {
      // Single optional folder → include/skip toggle.
      const only = variants[0];
      if (!only) continue;
      groups[cand.group_id] = {
        rule: "pick_one",
        label: `${baseName(cand.dir)} (optional)`,
        parts: [],
        variants: [
          { id: "skip", label: "Skip", parts: [] },
          { id: "include", label: `Include ${only.label ?? only.id}`, parts: only.parts },
        ],
      };
      continue;
    }
    if (variants.length < 2) continue;
    groups[cand.group_id] = {
      rule: "pick_one",
      label: baseName(cand.dir),
      parts: [],
      variants,
    };
  }
  return groups;
}
