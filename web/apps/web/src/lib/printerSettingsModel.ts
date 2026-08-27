import type { PrinterHostStatus } from "@print-partner/contracts";
import type { IntegrationSummary } from "../api/endpoints/integrations";
import type {
  PrinterDetailsInput,
  PrinterMachine,
  PrinterPreset,
} from "../api/endpoints/printers";

export type HostType = "moonraker" | "prusalink" | "bambu";
export type SlicerOverride = "orca" | "prusa" | "bambu";

export const DEFAULT_PRINTER_HOST_URLS: Record<"moonraker" | "prusalink", string> = {
  moonraker: "http://192.168.1.40:7125",
  prusalink: "http://192.168.1.50",
};

export const PRINTER_HOST_TYPE_LABELS: Record<HostType, string> = {
  moonraker: "Klipper",
  prusalink: "Prusa",
  bambu: "Bambu",
};

export const PRINTER_HOST_TYPES: readonly HostType[] = ["moonraker", "prusalink", "bambu"];

export const SLICER_OVERRIDES: readonly SlicerOverride[] = ["orca", "prusa", "bambu"];

export const SLICER_OVERRIDE_LABELS: Record<SlicerOverride, string> = {
  orca: "OrcaSlicer",
  prusa: "PrusaSlicer",
  bambu: "BambuStudio",
};

const PRINTER_HOST_TYPE_SET = new Set<HostType>(PRINTER_HOST_TYPES);

export function isPrinterHostType(value: unknown): value is HostType {
  return typeof value === "string" && PRINTER_HOST_TYPE_SET.has(value as HostType);
}

export type PrinterDetailsDraft = {
  name: string;
  model: string;
  bedWidth: string;
  bedDepth: string;
  bedHeight: string;
  margin: string;
  maxFilamentSlots: string;
  presetId: string | null;
};

export function printerDetailsDraft(printer: PrinterMachine): PrinterDetailsDraft {
  return {
    name: printer.name,
    model: printer.model,
    bedWidth: String(printer.bed_width_mm),
    bedDepth: String(printer.bed_depth_mm),
    bedHeight: printer.bed_height_mm == null ? "" : String(printer.bed_height_mm),
    margin: String(printer.margin_mm),
    maxFilamentSlots: String(printer.max_filament_slots),
    presetId: printer.preset_id?.trim() || null,
  };
}

export function parsePrinterDetailsDraft(draft: PrinterDetailsDraft): PrinterDetailsInput {
  const name = draft.name.trim();
  if (!name) throw new Error("Enter a printer name.");
  const model = draft.model.trim();
  if (!model) throw new Error("Enter a printer model.");
  const bedWidth = Number(draft.bedWidth);
  const bedDepth = Number(draft.bedDepth);
  if (
    !Number.isFinite(bedWidth) ||
    bedWidth <= 0 ||
    !Number.isFinite(bedDepth) ||
    bedDepth <= 0
  ) {
    throw new Error("Bed width and depth must be greater than 0.");
  }
  const bedHeight = draft.bedHeight.trim() ? Number(draft.bedHeight) : null;
  if (bedHeight !== null && (!Number.isFinite(bedHeight) || bedHeight <= 0)) {
    throw new Error("Bed height must be blank or greater than 0.");
  }
  const margin = Number(draft.margin);
  if (!Number.isFinite(margin) || margin < 0) {
    throw new Error("Bed margin must be 0 or greater.");
  }
  if (margin * 2 >= Math.min(bedWidth, bedDepth)) {
    throw new Error("Bed margin must be less than half of bed width and depth.");
  }
  const maxFilamentSlots = Number(draft.maxFilamentSlots);
  if (
    !Number.isInteger(maxFilamentSlots) ||
    maxFilamentSlots < 1 ||
    maxFilamentSlots > 4
  ) {
    throw new Error("Filament slots must be an integer from 1 to 4.");
  }
  return {
    name,
    model,
    bed_width_mm: bedWidth,
    bed_depth_mm: bedDepth,
    bed_height_mm: bedHeight,
    margin_mm: margin,
    max_filament_slots: maxFilamentSlots,
    preset_id: draft.presetId,
  };
}

export function statusPillLabel(status: PrinterHostStatus | null | undefined): string {
  if (!status) return "…";
  if (status.state === "printing" && status.progress != null) {
    return `Printing ${Math.round(status.progress)}%`;
  }
  if (status.state === "idle") return "Idle";
  if (status.state === "paused") return "Paused";
  if (status.state === "complete") return "Complete";
  if (status.state === "error") return "Error";
  if (status.state === "offline") return "Offline";
  return status.message ?? status.state;
}

export function statusPillClass(state: PrinterHostStatus["state"] | undefined): string {
  switch (state) {
    case "idle":
      return "bg-success-soft text-success";
    case "printing":
      return "bg-info-soft text-info";
    case "paused":
      return "bg-warning-soft text-warning";
    case "complete":
      return "bg-success-soft text-success";
    case "error":
      return "bg-destructive/15 text-destructive";
    case "offline":
      return "bg-muted text-muted-foreground";
    default:
      return "bg-muted text-muted-foreground";
  }
}

export function pickDefaultPresetId(
  presets: PrinterPreset[],
  fallbackPresetId: string,
): string {
  if (presets.some((preset) => preset.id === fallbackPresetId)) return fallbackPresetId;
  return presets[0]?.id ?? "";
}

export function printerSettingsCanAdd(input: {
  readonly engineReady: boolean;
  readonly busy: boolean;
  readonly name: string;
  readonly presetId: string;
  readonly customPresetId: string;
  readonly customWidth: string;
  readonly customDepth: string;
  readonly customHeight: string;
}): boolean {
  const customReady =
    Number(input.customWidth) > 0 && Number(input.customDepth) > 0 && Number(input.customHeight) > 0;
  return (
    input.engineReady &&
    !input.busy &&
    Boolean(input.name.trim()) &&
    (input.presetId === input.customPresetId ? customReady : Boolean(input.presetId))
  );
}

export function printerHostConnectionReady(input: {
  readonly hostType: HostType;
  readonly url: string;
  readonly password: string;
  readonly bambuHost: string;
  readonly accessCode: string;
  readonly serial: string;
}): boolean {
  return input.hostType === "bambu"
    ? Boolean(input.bambuHost.trim()) &&
        Boolean(input.accessCode.trim()) &&
        Boolean(input.serial.trim())
    : Boolean(input.url.trim()) &&
        (input.hostType === "moonraker" || Boolean(input.password.trim()));
}

export function linkedPrinters(
  printers: readonly PrinterMachine[],
  hostsById: ReadonlyMap<string, IntegrationSummary>,
): PrinterMachine[] {
  return printers.filter((printer) => {
    const id = printer.integration_id?.trim();
    if (!id) return false;
    const host = hostsById.get(id);
    return Boolean(host && isPrinterHostType(host.type));
  });
}

export function orphanPrinters(
  printers: readonly PrinterMachine[],
  hostsById: ReadonlyMap<string, IntegrationSummary>,
): PrinterMachine[] {
  return printers.filter((printer) => {
    const id = printer.integration_id?.trim();
    if (!id) return true;
    return !hostsById.has(id);
  });
}
