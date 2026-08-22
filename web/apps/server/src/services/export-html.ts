import { createHash } from "node:crypto";
import { folderKeyFromRelativePath, safePlanSlug } from "@print-partner/domain";
import { formatTimestamp, type DateFormatId } from "@print-partner/contracts";
import type { AcceptedPlanBasis } from "../db/accepted-plan-progress.js";
import { readAcceptedMediaPng } from "../lib/accepted-media-cache.js";
import { acceptedPartMediaIdentity } from "./accepted-part-media.js";
import type {
  AcceptedExportPart,
  CaptureAcceptedOperationalExportResult,
} from "./accepted-operational-export.js";
import { getColorById } from "./filament-catalog.js";
import { writeAcceptedExportFile } from "./accepted-export-publication.js";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function repoSortKey(sourceLayer: string): [number, string] {
  const lower = sourceLayer.toLowerCase();
  return sourceLayer.startsWith("base:") ? [0, lower] : [1, lower];
}

function renderHex(part: AcceptedExportPart): string | null {
  const custom = part.filamentCustomHex?.trim() ?? "";
  if (/^#[0-9a-f]{6}$/i.test(custom)) return custom.toLowerCase();
  const catalog = part.filamentColorId ? getColorById(part.filamentColorId) : null;
  const catalogHex = catalog?.hex.trim() ?? "";
  return /^#[0-9a-f]{6}$/i.test(catalogHex) ? catalogHex.toLowerCase() : null;
}

function thumbnail(part: AcceptedExportPart, thumbsDir: string): Buffer | null {
  if (part.artifact.kind !== "tracked") return null;
  const { basis } = acceptedPartMediaIdentity(
    {
      artifact: part.artifact,
      effectiveRole: part.role,
      filamentColorId: part.filamentColorId,
      filamentCustomHex: part.filamentCustomHex,
    },
    "thumbnail",
  );
  return readAcceptedMediaPng({ thumbsDir, basis });
}

function renderChecklist(input: Readonly<{
  profile: Readonly<{ id: number; name: string; orderNumber: string | null }>;
  parts: readonly AcceptedExportPart[];
  thumbsDir: string;
  dateFormat: DateFormatId;
  generatedAt: string;
}>): { html: string; partCount: number; thumbCount: number } {
  const included = input.parts.filter((part) => part.included);
  const byRepo = new Map<string, Map<string, AcceptedExportPart[]>>();
  for (const part of included) {
    const repoKey = part.sourceLayer || "unknown";
    const folder = folderKeyFromRelativePath(part.relativePath);
    const folders = byRepo.get(repoKey) ?? new Map<string, AcceptedExportPart[]>();
    byRepo.set(repoKey, folders);
    const parts = folders.get(folder) ?? [];
    folders.set(folder, parts);
    parts.push(part);
  }

  const generatedAt = formatTimestamp(input.generatedAt, input.dateFormat);
  let thumbCount = 0;
  let html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(input.profile.name)} checklist</title>
<style>body{font-family:system-ui,sans-serif;margin:1.5rem;}table{border-collapse:collapse;width:100%;}th,td{border:1px solid #ccc;padding:.4rem .6rem;text-align:left;}
.swatch{display:inline-block;width:12px;height:12px;border-radius:50%;margin-right:.35rem;vertical-align:middle;}
.thumb{width:48px;height:48px;object-fit:contain;vertical-align:middle;margin-right:.35rem;}</style></head><body>`;
  html += `<h1>${escapeHtml(input.profile.name)}</h1>`;
  if (input.profile.orderNumber) {
    html += `<p><strong>Order #</strong> ${escapeHtml(input.profile.orderNumber)}</p>`;
  }
  html += `<p>${included.length} part(s) · Generated ${escapeHtml(generatedAt)}</p>`;

  const repos = [...byRepo.entries()].sort((left, right) => {
    const leftKey = repoSortKey(left[0]);
    const rightKey = repoSortKey(right[0]);
    return leftKey[0] - rightKey[0] || leftKey[1].localeCompare(rightKey[1]);
  });

  for (const [repoLabel, folders] of repos) {
    html += `<h2>${escapeHtml(repoLabel)}</h2>`;
    for (const [folder, folderParts] of [...folders.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      html += `<h3>${escapeHtml(folder)}</h3><table><thead><tr><th>Part</th><th>Qty</th><th>Printed</th><th>Notes</th></tr></thead><tbody>`;
      for (const part of folderParts) {
        const done = part.units.length === part.quantityEffective && part.units.every((unit) => unit.completed);
        const hex = renderHex(part) ?? "";
        const png = thumbnail(part, input.thumbsDir);
        const thumbHtml = png
          ? `<img class="thumb" alt="" src="data:image/png;base64,${png.toString("base64")}"/>`
          : "";
        if (png) thumbCount += 1;
        html += `<tr><td>${thumbHtml}${hex ? `<span class="swatch" style="background:${escapeHtml(hex)}"></span>` : ""}${escapeHtml(part.filename)} <small>${escapeHtml(part.role)}</small></td>`;
        html += `<td>${part.quantityEffective}</td><td>${done ? "✓" : "—"}</td><td>${escapeHtml(part.notes)}</td></tr>`;
      }
      html += "</tbody></table>";
    }
  }
  html += `<p class="no-print"><small>Print Partner · profile ${input.profile.id}</small></p></body></html>`;
  return { html, partCount: included.length, thumbCount };
}

export function materializeAcceptedChecklistHtml(input: Readonly<{
  capture: Extract<CaptureAcceptedOperationalExportResult, { readonly kind: "ready" | "empty" }>;
  tenantExportsDir: string;
  thumbsDir: string;
  dateFormat: DateFormatId;
  generatedAt: string;
}>):
  | {
      readonly kind: "materialized";
      readonly path: string;
      readonly partCount: number;
      readonly thumbCount: number;
      readonly basis: AcceptedPlanBasis | null;
    }
  | { readonly kind: "output_failure" } {
  const profile = input.capture.kind === "ready" ? input.capture.export.profile : input.capture.profile;
  const parts = input.capture.kind === "ready" ? input.capture.export.parts : [];
  const basis = input.capture.kind === "ready" ? input.capture.export.basis : null;
  try {
    const rendered = renderChecklist({
      profile,
      parts,
      thumbsDir: input.thumbsDir,
      dateFormat: input.dateFormat,
      generatedAt: input.generatedAt,
    });
    const path = writeAcceptedExportFile({
      root: input.tenantExportsDir,
      directorySegments: [
        `profile-${profile.id}-${safePlanSlug(profile.name).slice(0, 80)}`,
        "checklist",
      ],
      filename: `checklist-${createHash("sha256").update(rendered.html).digest("hex")}.html`,
      bytes: Buffer.from(rendered.html, "utf8"),
    });
    return {
      kind: "materialized",
      path,
      partCount: rendered.partCount,
      thumbCount: rendered.thumbCount,
      basis,
    };
  } catch {
    return { kind: "output_failure" };
  }
}
