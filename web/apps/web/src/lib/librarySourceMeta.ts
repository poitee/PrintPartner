import type { PlanReview, SourceSummary } from "../api/engine";

export type LibraryCardTone = "default" | "update" | "syncing" | "attached" | "local";

export type LibraryCardMeta = {
  slug: string;
  stateLabel: string;
  stateTone: "muted" | "warning" | "sync" | "success";
  pickLabel: string;
  barPct: number;
  barTone: LibraryCardTone;
  borderTone: LibraryCardTone;
};

/** Short path / repo slug for card subtitle. */
export function sourceSlug(source: SourceSummary): string {
  if (source.source_kind === "github") {
    const match = source.url.match(/github\.com[/:]([^/]+)\/([^/.]+)/i);
    if (match) return `${match[1]}/${match[2]}`;
  }
  if (source.source_kind === "local") {
    return source.local_path || source.url || "local folder";
  }
  if (source.source_kind === "archive") {
    const fromUrl = source.url?.split(/[/\\]/).pop();
    return fromUrl || source.name;
  }
  return source.url || "—";
}

/** Included-part counts keyed by attached source (project) id. */
export function pickCountsBySourceId(review: PlanReview | null | undefined): Map<number, number> {
  const counts = new Map<number, number>();
  if (!review) return counts;

  const resolveSourceId = (sourceLayer: string | null): number | null => {
    if (!sourceLayer) return null;
    const label = sourceLayer.includes(":")
      ? sourceLayer.split(":").slice(1).join(":").trim()
      : sourceLayer.trim();

    // Prefer exact project_name / `type:Name` label matches before substring.
    for (const layer of review.layers) {
      if (layer.project_id == null || !layer.project_name) continue;
      if (
        sourceLayer === layer.project_name ||
        label === layer.project_name ||
        sourceLayer === `${layer.layer_type}:${layer.project_name}`
      ) {
        return layer.project_id;
      }
    }

    for (const layer of review.layers) {
      if (layer.project_id == null) continue;
      if (!layer.project_name) {
        if (sourceLayer.includes(String(layer.project_id))) return layer.project_id;
        continue;
      }
      if (
        sourceLayer.includes(layer.project_name) ||
        sourceLayer.includes(String(layer.project_id))
      ) {
        return layer.project_id;
      }
    }
    return null;
  };

  for (const part of review.part_groups.flatMap((g) => g.parts)) {
    if (!part.included) continue;
    const sourceId = resolveSourceId(part.source_layer);
    if (sourceId == null) continue;
    counts.set(sourceId, (counts.get(sourceId) ?? 0) + 1);
  }
  return counts;
}

export function attachedSourceIds(review: PlanReview | null | undefined): Set<number> {
  const ids = new Set<number>();
  if (!review) return ids;
  for (const layer of review.layers) {
    if (layer.project_id != null) ids.add(layer.project_id);
  }
  return ids;
}

type BuildMetaArgs = {
  source: SourceSummary;
  attached: boolean;
  pickCount: number | null;
  syncing: boolean;
  syncProgress: number | null;
  formatDate: (iso: string | null | undefined) => string;
};

export function buildLibraryCardMeta({
  source,
  attached,
  pickCount,
  syncing,
  syncProgress,
  formatDate,
}: BuildMetaArgs): LibraryCardMeta {
  const slug = sourceSlug(source);
  const pickLabel =
    attached && pickCount != null
      ? `${pickCount} pick${pickCount === 1 ? "" : "s"}`
      : attached
        ? "attached"
        : "not attached";

  if (syncing) {
    const pct =
      syncProgress != null
        ? Math.round(Math.min(100, Math.max(0, syncProgress * 100)))
        : 56;
    return {
      slug,
      stateLabel: syncProgress != null ? `Syncing ${pct}%` : "Syncing…",
      stateTone: "sync",
      pickLabel,
      barPct: pct,
      barTone: "syncing",
      borderTone: "syncing",
    };
  }

  if (source.update_status === "updates_available") {
    return {
      slug,
      stateLabel: "Update available",
      stateTone: "warning",
      pickLabel,
      barPct: 100,
      barTone: "update",
      borderTone: "update",
    };
  }

  if (source.source_kind === "local") {
    return {
      slug,
      stateLabel: "Local, always current",
      stateTone: "muted",
      pickLabel,
      barPct: attached ? 100 : 0,
      barTone: attached ? "local" : "default",
      borderTone: "default",
    };
  }

  const synced = formatDate(source.last_synced_at);
  const stateLabel = synced
    ? `Synced ${synced}`
    : source.source_kind === "archive"
      ? "Imported"
      : "Not synced";

  return {
    slug,
    stateLabel,
    stateTone: "muted",
    pickLabel,
    barPct: attached ? 100 : 0,
    barTone: attached ? "attached" : "default",
    borderTone: "default",
  };
}

const CATEGORY_SWATCHES = [
  "hsl(222 28% 16%)",
  "hsl(199 88% 42%)",
  "hsl(152 48% 36%)",
  "hsl(33 70% 42%)",
  "hsl(262 52% 48%)",
  "hsl(340 55% 45%)",
];

export function categorySwatch(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 997;
  return CATEGORY_SWATCHES[h % CATEGORY_SWATCHES.length]!;
}
