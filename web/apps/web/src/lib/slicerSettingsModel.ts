import type { SlicerDialect, SlicerInstanceKind } from "../api/endpoints/slicers";

export type SlicerAddDraft = {
  name: string;
  kind: SlicerInstanceKind;
  dialect: SlicerDialect;
  guiUrl: string;
  watchPath: string;
};

export type SlicerPresetKind = Exclude<SlicerInstanceKind, "custom">;

export type SlicerPresetOption = {
  kind: SlicerPresetKind;
  label: string;
};

export const SLICER_PRESET_KINDS: SlicerPresetOption[] = [
  { kind: "orca", label: "OrcaSlicer" },
  { kind: "prusa", label: "PrusaSlicer" },
  { kind: "bambu", label: "BambuStudio" },
];

export function defaultSlicerDialect(kind: SlicerInstanceKind): SlicerDialect {
  if (kind === "prusa") return "prusa_ini";
  if (kind === "bambu") return "bambu_json";
  return "orca_json";
}

export function isSafeSlicerGuiUrl(raw: string): boolean {
  const value = raw.trim();
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function slicerCreatePayloadFromDraft(draft: SlicerAddDraft) {
  const fallbackName =
    SLICER_PRESET_KINDS.find((preset) => preset.kind === draft.kind)?.label ?? "Slicer";
  return {
    name: draft.name.trim() || fallbackName,
    kind: draft.kind,
    dialect: draft.kind === "custom" ? draft.dialect : defaultSlicerDialect(draft.kind),
    gui_url: draft.guiUrl.trim(),
    watch_path: draft.watchPath.trim(),
    enabled: true,
  };
}
