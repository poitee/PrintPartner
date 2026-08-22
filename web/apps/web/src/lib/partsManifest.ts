/**
 * Parts / build manifest schema for CSV + Excel export/import.
 *
 * Stable header row (order matters for humans; parser is name-based):
 *   source_link, file_name, quantity, printed_count, filament_role,
 *   filament_display, relative_path, source_name, plan_name, match_key,
 *   part_id, included, notes
 *
 * Import matches rows to plan parts by part_id → match_key → relative_path →
 * file_name (unique only). Quantity and inclusion become saved Plan draft edits.
 */

import type {
  AcceptedPlanBasisContract,
  ReviewPart,
  SourceSummary,
} from "@print-partner/contracts";
import type {
  PlanDraftPartDecisionContract,
  PlanDraftWorkspace,
  PlanReview,
} from "../api/engine";

/** Stable column keys — keep in sync with PARTS_MANIFEST_HEADERS. */
export const PARTS_MANIFEST_HEADERS = [
  "source_link",
  "file_name",
  "quantity",
  "printed_count",
  "filament_role",
  "filament_display",
  "relative_path",
  "source_name",
  "plan_name",
  "match_key",
  "part_id",
  "included",
  "notes",
] as const;

export type PartsManifestColumn = (typeof PARTS_MANIFEST_HEADERS)[number];

export type PartsManifestRow = Record<PartsManifestColumn, string>;

export type PartsManifestBuildInput = {
  review: PlanReview;
  sources: SourceSummary[];
  /** When true, include excluded parts (default: included only). */
  includeExcluded?: boolean;
};

export type ManifestParseIssue = {
  row: number;
  message: string;
};

export type ManifestApplyOptions = {
  applyQuantity?: boolean;
  applyIncluded?: boolean;
  applyPrintedProgress?: boolean;
  draftWorkspace?: PlanDraftWorkspace | null;
  applyDraftDecisions?: (
    decisions: PlanDraftPartDecisionContract[],
  ) => Promise<PlanDraftWorkspace>;
  applyAcceptedProgress?: (
    expected: AcceptedPlanBasisContract,
    rows: Array<{ part_id: number; printed_count: number }>,
  ) => Promise<void>;
};

export type ManifestApplyResult = {
  updated: number;
  skipped: number;
  errors: ManifestParseIssue[];
};

/** Neutralize spreadsheet formula injection (=, +, -, @, tab, CR) with a leading quote. */
export function neutralizeFormulaPrefix(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function escapeCsvCell(value: string): string {
  const cell = neutralizeFormulaPrefix(value);
  if (/[",\r\n]/.test(cell)) {
    return `"${cell.replace(/"/g, '""')}"`;
  }
  return cell;
}

/** RFC-style CSV split that respects quoted fields. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  const src = text.replace(/^\uFEFF/, "");

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (ch === "\n") {
      row.push(cell);
      cell = "";
      rows.push(row);
      row = [];
      continue;
    }
    if (ch === "\r") {
      continue;
    }
    cell += ch;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export function rowsToCsv(rows: PartsManifestRow[]): string {
  const lines = [
    PARTS_MANIFEST_HEADERS.join(","),
    ...rows.map((r) => PARTS_MANIFEST_HEADERS.map((h) => escapeCsvCell(r[h] ?? "")).join(",")),
  ];
  return `${lines.join("\r\n")}\r\n`;
}

function normalizeHeader(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

const HEADER_ALIASES: Record<string, PartsManifestColumn> = {
  source_link: "source_link",
  source_url: "source_link",
  link: "source_link",
  url: "source_link",
  file_name: "file_name",
  filename: "file_name",
  name: "file_name",
  quantity: "quantity",
  qty: "quantity",
  quantity_effective: "quantity",
  printed_count: "printed_count",
  printed: "printed_count",
  filament_role: "filament_role",
  role: "filament_role",
  filament_display: "filament_display",
  filament: "filament_display",
  relative_path: "relative_path",
  path: "relative_path",
  source_name: "source_name",
  source: "source_name",
  plan_name: "plan_name",
  plan: "plan_name",
  match_key: "match_key",
  part_id: "part_id",
  id: "part_id",
  included: "included",
  notes: "notes",
  warnings: "notes",
};

export function parseManifestTable(matrix: string[][]): {
  rows: PartsManifestRow[];
  errors: ManifestParseIssue[];
} {
  const errors: ManifestParseIssue[] = [];
  if (matrix.length === 0) {
    return { rows: [], errors: [{ row: 0, message: "File is empty" }] };
  }
  const headerCells = matrix[0]!.map(normalizeHeader);
  const colMap = new Map<number, PartsManifestColumn>();
  for (let i = 0; i < headerCells.length; i++) {
    const mapped = HEADER_ALIASES[headerCells[i]!];
    if (mapped) colMap.set(i, mapped);
  }
  if (![...colMap.values()].includes("file_name") && ![...colMap.values()].includes("match_key")) {
    errors.push({
      row: 1,
      message: "Missing required header: file_name or match_key",
    });
  }

  const rows: PartsManifestRow[] = [];
  for (let r = 1; r < matrix.length; r++) {
    const line = matrix[r]!;
    const empty: PartsManifestRow = Object.fromEntries(
      PARTS_MANIFEST_HEADERS.map((h) => [h, ""]),
    ) as PartsManifestRow;
    for (const [idx, col] of colMap) {
      empty[col] = (line[idx] ?? "").trim();
    }
    if (!empty.file_name && !empty.match_key && !empty.part_id && !empty.relative_path) {
      continue;
    }
    rows.push(empty);
  }
  return { rows, errors };
}

export function parseManifestCsv(text: string): {
  rows: PartsManifestRow[];
  errors: ManifestParseIssue[];
} {
  return parseManifestTable(parseCsv(text));
}

function sourceLinkForPart(
  part: ReviewPart,
  review: PlanReview,
  sourcesById: Map<number, SourceSummary>,
): { link: string; sourceName: string } {
  const layer = review.layers.find((l) => {
    if (!part.source_layer || !l.project_name) return false;
    return (
      part.source_layer.includes(l.project_name) ||
      (l.project_id != null && part.source_layer.includes(String(l.project_id)))
    );
  });
  if (layer?.project_id != null) {
    const src = sourcesById.get(layer.project_id);
    if (src) {
      return { link: src.url || src.local_path || "", sourceName: src.name };
    }
  }
  // Fallback: match source_layer label "type:Name" against source names
  const label = (part.source_layer ?? "").split(":").slice(1).join(":").trim();
  if (label) {
    for (const src of sourcesById.values()) {
      if (src.name === label) {
        return { link: src.url || src.local_path || "", sourceName: src.name };
      }
    }
  }
  return {
    link: "",
    sourceName: label || part.source_layer || "",
  };
}

function notesForPart(part: ReviewPart, review: PlanReview): string {
  const bits: string[] = [];
  if (part.stl_missing) bits.push("missing_stl");
  if (!part.included) bits.push("excluded");
  for (const issue of review.issues) {
    if (!issue.message.includes(part.filename)) continue;
    if (bits.includes(issue.code)) continue;
    bits.push(issue.code);
  }
  return bits.join("; ");
}

export function buildPartsManifestRows(input: PartsManifestBuildInput): PartsManifestRow[] {
  const { review, sources, includeExcluded = false } = input;
  const sourcesById = new Map(sources.map((s) => [s.id, s]));
  const parts = review.part_groups.flatMap((g) => g.parts);
  const selected = includeExcluded ? parts : parts.filter((p) => p.included);

  return selected.map((part) => {
    const { link, sourceName } = sourceLinkForPart(part, review, sourcesById);
    const row: PartsManifestRow = {
      source_link: link,
      file_name: part.filename,
      quantity: String(part.quantity_effective),
      printed_count: String(part.printed_count),
      filament_role: part.role ?? "",
      filament_display: part.filament_display ?? "",
      relative_path: part.relative_path || part.filename,
      source_name: sourceName,
      plan_name: review.plan_name,
      match_key: part.match_key,
      part_id: String(part.id),
      included: part.included ? "true" : "false",
      notes: notesForPart(part, review),
    };
    return row;
  });
}

export function manifestDownloadBasename(planName: string, ext: "csv" | "xlsx"): string {
  const slug = (planName || "plan")
    .replace(/[^\w-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return `${slug || "plan"}_parts_manifest.${ext}`;
}

function findPart(
  row: PartsManifestRow,
  parts: ReviewPart[],
): { part: ReviewPart | null; error?: string } {
  if (row.part_id) {
    const id = Number(row.part_id);
    if (Number.isFinite(id)) {
      const byId = parts.find((p) => p.id === id);
      if (byId) return { part: byId };
    }
  }
  if (row.match_key) {
    const byKey = parts.filter((p) => p.match_key === row.match_key);
    if (byKey.length === 1) return { part: byKey[0]! };
    if (byKey.length > 1) return { part: null, error: `Ambiguous match_key ${row.match_key}` };
  }
  if (row.relative_path) {
    const byPath = parts.filter(
      (p) => (p.relative_path || p.filename) === row.relative_path,
    );
    if (byPath.length === 1) return { part: byPath[0]! };
    if (byPath.length > 1) {
      return { part: null, error: `Ambiguous relative_path ${row.relative_path}` };
    }
  }
  if (row.file_name) {
    const byName = parts.filter((p) => p.filename === row.file_name);
    if (byName.length === 1) return { part: byName[0]! };
    if (byName.length > 1) {
      return { part: null, error: `Ambiguous file_name ${row.file_name} — add match_key or path` };
    }
  }
  return {
    part: null,
    error: `No matching part for ${row.file_name || row.match_key || row.part_id || "row"}`,
  };
}

function parseBool(raw: string): boolean | null {
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  if (["1", "true", "yes", "y"].includes(v)) return true;
  if (["0", "false", "no", "n"].includes(v)) return false;
  return null;
}

export async function applyPartsManifest(
  rows: PartsManifestRow[],
  review: PlanReview,
  options: ManifestApplyOptions = {},
): Promise<ManifestApplyResult> {
  const applyQuantity = options.applyQuantity !== false;
  const applyIncluded = options.applyIncluded === true;
  const applyPrintedProgress = options.applyPrintedProgress === true;
  const parts = review.part_groups.flatMap((g) => g.parts);
  const errors: ManifestParseIssue[] = [];
  const matched: Array<{ row: PartsManifestRow; rowNum: number; part: ReviewPart }> = [];
  const matchedPartIds = new Set<number>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const rowNum = i + 2;
    const { part, error } = findPart(row, parts);
    if (!part) {
      errors.push({ row: rowNum, message: error || "Unmatched row" });
      continue;
    }
    if (matchedPartIds.has(part.id)) {
      errors.push({ row: rowNum, message: `Duplicate target ${part.filename}` });
      continue;
    }
    matchedPartIds.add(part.id);
    matched.push({ row, rowNum, part });
    if (applyQuantity && row.quantity.trim() !== "") {
      const quantity = Number(row.quantity);
      if (!Number.isFinite(quantity) || quantity < 1 || quantity > 10_000) {
        errors.push({ row: rowNum, message: `Invalid quantity "${row.quantity}"` });
      }
    }
    if (applyIncluded && row.included.trim() !== "" && parseBool(row.included) == null) {
      errors.push({ row: rowNum, message: `Invalid included "${row.included}"` });
    }
    if (applyPrintedProgress && row.printed_count.trim() !== "") {
      const printed = Number(row.printed_count);
      if (!Number.isSafeInteger(printed) || printed < 0 || printed > part.quantity_effective) {
        errors.push({ row: rowNum, message: `Invalid printed_count "${row.printed_count}"` });
      }
    }
  }
  if (errors.length > 0) return { updated: 0, skipped: rows.length, errors };

  const workspace = options.draftWorkspace;
  const draftPartsByKey = new Map<string, Array<PlanDraftWorkspace["parts"][number]>>();
  for (const part of workspace?.parts ?? []) {
    const matches = draftPartsByKey.get(part.part_key) ?? [];
    matches.push(part);
    draftPartsByKey.set(part.part_key, matches);
  }
  const currentPlanningPart = (part: ReviewPart) => {
    const matches = draftPartsByKey.get(part.match_key) ?? [];
    return matches.length === 1 ? matches[0]! : part;
  };
  const quantityChanges = matched.flatMap(({ row, rowNum, part }) => {
    if (!applyQuantity || row.quantity.trim() === "") return [];
    const value = Math.floor(Number(row.quantity));
    return value === currentPlanningPart(part).quantity_effective
      ? []
      : [{ rowNum, part, value }];
  });
  const inclusionChanges = matched.flatMap(({ row, rowNum, part }) => {
    if (!applyIncluded || row.included.trim() === "") return [];
    const value = parseBool(row.included)!;
    return value === currentPlanningPart(part).included ? [] : [{ rowNum, part, value }];
  });
  const progressRows = matched.flatMap(({ row, rowNum, part }) => {
    if (!applyPrintedProgress || row.printed_count.trim() === "") return [];
    const printedCount = Number(row.printed_count);
    return printedCount === part.printed_count
      ? []
      : [{ rowNum, part_id: part.id, printed_count: printedCount }];
  });
  const planningChanges = quantityChanges.length + inclusionChanges.length;
  if (planningChanges > 0 && progressRows.length > 0) {
    return {
      updated: 0,
      skipped: rows.length,
      errors: [{
        row: 0,
        message: "Quantity/inclusion and printed counts must be imported separately",
      }],
    };
  }

  const applyDraftDecisions = options.applyDraftDecisions;
  if (planningChanges > 0 && (!workspace || !applyDraftDecisions)) {
    return {
      updated: 0,
      skipped: rows.length,
      errors: [{ row: 0, message: "Rebuild the Plan to create a saved draft before importing" }],
    };
  }

  const draftPartIdsByKey = new Map<string, number[]>();
  for (const part of workspace?.parts ?? []) {
    const ids = draftPartIdsByKey.get(part.part_key) ?? [];
    ids.push(part.draft_part_id);
    draftPartIdsByKey.set(part.part_key, ids);
  }
  const quantityGroups = new Map<number, number[]>();
  const inclusionGroups = new Map<boolean, number[]>();
  const changedRows = new Set<number>();
  for (const { rowNum, part, value } of quantityChanges) {
    const draftPartIds = draftPartIdsByKey.get(part.match_key) ?? [];
    if (draftPartIds.length !== 1) {
      errors.push({ row: rowNum, message: `Saved draft does not have one match for ${part.filename}` });
      continue;
    }
    const group = quantityGroups.get(value) ?? [];
    group.push(draftPartIds[0]!);
    quantityGroups.set(value, group);
    changedRows.add(rowNum);
  }
  for (const { rowNum, part, value } of inclusionChanges) {
    const draftPartIds = draftPartIdsByKey.get(part.match_key) ?? [];
    if (draftPartIds.length !== 1) {
      errors.push({ row: rowNum, message: `Saved draft does not have one match for ${part.filename}` });
      continue;
    }
    const group = inclusionGroups.get(value) ?? [];
    group.push(draftPartIds[0]!);
    inclusionGroups.set(value, group);
    changedRows.add(rowNum);
  }
  if (errors.length > 0) return { updated: 0, skipped: rows.length, errors };

  const decisions: PlanDraftPartDecisionContract[] = [];
  for (const [value, draftPartIds] of quantityGroups) {
    decisions.push({
      kind: "set_quantity_override",
      draft_part_ids: draftPartIds,
      value,
    });
  }
  for (const [value, draftPartIds] of inclusionGroups) {
    decisions.push({
      kind: "set_included",
      draft_part_ids: draftPartIds,
      value,
    });
  }
  if (decisions.length > 0) await applyDraftDecisions!(decisions);

  if (progressRows.length > 0) {
    if (!review.accepted_basis || !options.applyAcceptedProgress) {
      return {
        updated: 0,
        skipped: rows.length,
        errors: [{ row: 0, message: "Reload the accepted Plan before importing printed counts" }],
      };
    }
    await options.applyAcceptedProgress(
      review.accepted_basis,
      progressRows.map(({ part_id, printed_count }) => ({ part_id, printed_count })),
    );
    for (const row of progressRows) changedRows.add(row.rowNum);
  }

  let updated = 0;
  let skipped = 0;
  for (const { rowNum } of matched) {
    if (changedRows.has(rowNum)) updated++;
    else skipped++;
  }

  return { updated, skipped, errors };
}

export function triggerBrowserDownload(blob: Blob, filename: string): void {
  if (typeof document === "undefined") return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
