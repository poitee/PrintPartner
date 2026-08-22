/** STL filename conventions (ported from Python parsers.py). */

import type { NamingProfile } from "./stl-naming.js";
import { getDefaultNamingProfile } from "./stl-naming.js";

export type PartRole = "primary" | "accent" | "clear" | "opaque";

export type ParsedPart = {
  role: PartRole;
  quantity: number;
  partSlug: string;
  filename: string;
};

function resolveProfile(profile?: NamingProfile | null): NamingProfile {
  return profile ?? getDefaultNamingProfile();
}

function roleFromId(roleId: string): PartRole {
  if (roleId === "accent" || roleId === "clear" || roleId === "opaque") return roleId;
  return "primary";
}

function checkRoleInText(text: string, profile: NamingProfile): PartRole | null {
  const lower = text.toLowerCase();
  for (const [marker, roleId] of profile.markerRoleMap) {
    if (lower.includes(marker.toLowerCase())) return roleFromId(roleId);
  }
  return null;
}

function folderRole(relativePath: string, profile: NamingProfile): PartRole | null {
  const posix = relativePath.replace(/\\/g, "/").toLowerCase();
  for (const rule of profile.folderRules) {
    if (posix.includes(rule.path_contains.toLowerCase())) {
      return roleFromId(rule.role_id);
    }
  }
  return null;
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

function parentParts(path: string): string[] {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/");
  parts.pop();
  return parts;
}

export function parseRole(pathOrName: string, profile?: NamingProfile | null): PartRole {
  const prof = resolveProfile(profile);
  const foundFolder = folderRole(pathOrName, prof);
  if (foundFolder) return foundFolder;
  const segments = [...parentParts(pathOrName), basename(pathOrName)];
  for (const segment of segments) {
    const found = checkRoleInText(segment, prof);
    if (found) return found;
  }
  return "primary";
}

export function parseQuantity(filename: string, profile?: NamingProfile | null): number {
  const prof = resolveProfile(profile);
  const m = prof.quantityRe.exec(filename);
  if (m?.[1]) return Math.max(1, parseInt(m[1], 10));
  return Math.max(1, prof.quantityDefault);
}

export function parsePartSlug(filename: string, profile?: NamingProfile | null): string {
  const prof = resolveProfile(profile);
  let name = basename(filename);
  if (name.toLowerCase().endsWith(".stl")) name = name.slice(0, -4);
  let stem = name;
  if (prof.slugStripMarkers) {
    for (const prefixRe of prof.rolePrefixRes) {
      stem = stem.replace(prefixRe, "");
    }
  }
  if (prof.slugStripQuantity && prof.quantityStripRe) {
    stem = stem.replace(prof.quantityStripRe, "");
  }
  return stem || name;
}

export function parseStlPath(
  relativePath: string,
  profile?: NamingProfile | null,
): ParsedPart {
  const prof = resolveProfile(profile);
  const filename = basename(relativePath.replace(/\\/g, "/"));
  return {
    role: parseRole(relativePath, prof),
    quantity: parseQuantity(filename, prof),
    partSlug: parsePartSlug(filename, prof),
    filename,
  };
}

export function previewParse(
  relativePath: string,
  profile?: NamingProfile | null,
): { role: string; quantity: number; part_slug: string; filename: string } {
  const parsed = parseStlPath(relativePath, profile ?? undefined);
  return {
    role: parsed.role,
    quantity: parsed.quantity,
    part_slug: parsed.partSlug,
    filename: parsed.filename,
  };
}
