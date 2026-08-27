import type { PrinterPreset } from "../../api/endpoints/printers";
import type { PrinterDetailsDraft } from "../../lib/printerSettingsModel";
import { Button } from "../ui/button";

export const CUSTOM_PRESET_ID = "custom";

export type PrinterDetailsTextField = Exclude<keyof PrinterDetailsDraft, "presetId">;

type PrinterDetailsEditorProps = {
  draft: PrinterDetailsDraft;
  presets: PrinterPreset[];
  disabled: boolean;
  onChange: (field: PrinterDetailsTextField, value: string) => void;
  onPresetChange: (presetId: string | null) => void;
  onSave: () => void;
  onCancel: () => void;
};

const INPUT_CLASS = "rounded-md border border-input bg-background px-2 py-1.5 text-sm w-full";

export default function PrinterDetailsEditor({
  draft,
  presets,
  disabled,
  onChange,
  onPresetChange,
  onSave,
  onCancel,
}: PrinterDetailsEditorProps) {
  const unavailablePresetId =
    draft.presetId && !presets.some((preset) => preset.id === draft.presetId)
      ? draft.presetId
      : null;
  return (
    <div className="space-y-3 border-t border-border pt-3">
      <label className="block text-sm">
        <span className="mb-1 block text-muted-foreground">Geometry source</span>
        <select
          className={INPUT_CLASS}
          aria-label="Edit printer preset"
          value={draft.presetId ?? CUSTOM_PRESET_ID}
          disabled={disabled}
          onChange={(event) =>
            onPresetChange(event.target.value === CUSTOM_PRESET_ID ? null : event.target.value)
          }
        >
          {unavailablePresetId && (
            <option value={unavailablePresetId}>
              Retired preset (unavailable): {unavailablePresetId}
            </option>
          )}
          {presets.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.name} ({preset.bed_width_mm}×{preset.bed_depth_mm} mm)
            </option>
          ))}
          <option value={CUSTOM_PRESET_ID}>Custom</option>
        </select>
      </label>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block text-muted-foreground">Name</span>
          <input
            className={INPUT_CLASS}
            aria-label="Edit printer name"
            value={draft.name}
            disabled={disabled}
            onChange={(event) => onChange("name", event.target.value)}
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-muted-foreground">Model</span>
          <input
            className={INPUT_CLASS}
            aria-label="Edit printer model"
            value={draft.model}
            disabled={disabled}
            onChange={(event) => onChange("model", event.target.value)}
          />
        </label>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="block text-sm">
          <span className="mb-1 block text-muted-foreground">Width (mm)</span>
          <input
            className={INPUT_CLASS}
            aria-label="Edit bed width (mm)"
            inputMode="decimal"
            value={draft.bedWidth}
            disabled={disabled}
            onChange={(event) => onChange("bedWidth", event.target.value)}
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-muted-foreground">Depth (mm)</span>
          <input
            className={INPUT_CLASS}
            aria-label="Edit bed depth (mm)"
            inputMode="decimal"
            value={draft.bedDepth}
            disabled={disabled}
            onChange={(event) => onChange("bedDepth", event.target.value)}
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-muted-foreground">Height (mm)</span>
          <input
            className={INPUT_CLASS}
            aria-label="Edit bed height (mm)"
            inputMode="decimal"
            value={draft.bedHeight}
            disabled={disabled}
            onChange={(event) => onChange("bedHeight", event.target.value)}
          />
          <span className="mt-1 block text-xs text-muted-foreground">
            Blank is send-only; Plate planning requires a positive height.
          </span>
        </label>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block text-muted-foreground">Bed margin (mm)</span>
          <input
            className={INPUT_CLASS}
            aria-label="Edit bed margin (mm)"
            inputMode="decimal"
            value={draft.margin}
            disabled={disabled}
            onChange={(event) => onChange("margin", event.target.value)}
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-muted-foreground">Filament slots</span>
          <input
            className={INPUT_CLASS}
            aria-label="Edit filament slots"
            inputMode="numeric"
            value={draft.maxFilamentSlots}
            disabled={disabled}
            onChange={(event) => onChange("maxFilamentSlots", event.target.value)}
          />
        </label>
      </div>
      <p className="text-xs text-muted-foreground">
        {draft.presetId ? `Preset reference: ${draft.presetId}` : "Custom geometry"}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={disabled} onClick={onSave}>
          Save printer details
        </Button>
        <Button variant="outline" size="sm" disabled={disabled} onClick={onCancel}>
          Cancel editing
        </Button>
      </div>
    </div>
  );
}
