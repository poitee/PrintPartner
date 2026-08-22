import type { ReviewPart } from "../api/engine";
import { folderKeyFromRelativePath } from "./checkoffGroups";
import { sourceLabelFromLayer } from "./reviewParts";

const ROLE_ORDER = ["primary", "accent", "clear", "opaque"] as const;

export type PartsRoleGroup = {
  roleKey: string;
  title: string;
  meta: string;
  hex: string | null;
  parts: ReviewPart[];
};

function roleSortKey(role: string): [number, string] {
  const idx = ROLE_ORDER.indexOf(role as (typeof ROLE_ORDER)[number]);
  return [idx >= 0 ? idx : ROLE_ORDER.length, role.toLowerCase()];
}

function titleCaseRole(role: string): string {
  if (!role) return "Unassigned";
  return role.charAt(0).toUpperCase() + role.slice(1);
}

/**
 * Group parts by filament role (Primary / Accent …), titled with the common
 * filament label when present — matches the Parts mock “By role” sections.
 */
export function groupPartsByRole(parts: ReviewPart[]): PartsRoleGroup[] {
  const byRole = new Map<string, ReviewPart[]>();
  for (const p of parts) {
    const key = p.role?.trim() || "unassigned";
    if (!byRole.has(key)) byRole.set(key, []);
    byRole.get(key)!.push(p);
  }

  return [...byRole.entries()]
    .sort((a, b) => {
      const ka = roleSortKey(a[0]);
      const kb = roleSortKey(b[0]);
      return ka[0] - kb[0] || ka[1].localeCompare(kb[1]);
    })
    .map(([roleKey, roleParts]) => {
      const sorted = [...roleParts].sort((x, y) =>
        x.filename.localeCompare(y.filename, undefined, {
          numeric: true,
          sensitivity: "base",
        }),
      );
      const filamentCounts = new Map<string, number>();
      let hex: string | null = null;
      for (const p of sorted) {
        const label = (p.filament_display || "").trim();
        if (label) filamentCounts.set(label, (filamentCounts.get(label) ?? 0) + 1);
        if (!hex && p.filament_hex) hex = p.filament_hex;
      }
      let filamentLabel = "";
      if (filamentCounts.size === 1) {
        filamentLabel = [...filamentCounts.keys()][0]!;
      } else if (filamentCounts.size > 1) {
        filamentLabel = [...filamentCounts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
      }
      const uniqueFolders = new Set(
        sorted.map((p) => folderKeyFromRelativePath(p.relative_path || p.filename)),
      );
      const roleTitle = titleCaseRole(roleKey === "unassigned" ? "" : roleKey);
      const title = filamentLabel ? `${roleTitle} · ${filamentLabel}` : roleTitle;
      const meta = `${sorted.length} part${sorted.length === 1 ? "" : "s"} · ${uniqueFolders.size} folder${uniqueFolders.size === 1 ? "" : "s"}`;
      return { roleKey, title, meta, hex, parts: sorted };
    });
}

/** Compact subtitle for the Parts page header. */
export function partsSummaryLine(
  parts: ReviewPart[],
  byRole: Record<string, number>,
  warningCount: number,
): string {
  const included = parts.filter((p) => p.included);
  const roleBits = Object.entries(byRole)
    .sort((a, b) => {
      const ka = roleSortKey(a[0]);
      const kb = roleSortKey(b[0]);
      return ka[0] - kb[0] || ka[1].localeCompare(kb[1]);
    })
    .map(([role, n]) => `${n} ${role}`);
  const bits = [
    `${included.length} part${included.length === 1 ? "" : "s"}`,
    ...roleBits,
  ];
  if (warningCount > 0) {
    bits.push(`${warningCount} warning${warningCount === 1 ? "" : "s"}`);
  }
  return bits.join(" · ");
}

export function partSourceNote(part: ReviewPart): string {
  const source = sourceLabelFromLayer(part.source_layer);
  const folder = folderKeyFromRelativePath(part.relative_path || part.filename);
  if (folder && folder !== "(root)") return `${source} / ${folder}`;
  return source;
}
