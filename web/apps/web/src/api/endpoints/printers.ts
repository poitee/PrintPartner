import type {
  PrinterCamera,
  PrinterStorageListing,
  PrinterStoredFile,
} from "@print-partner/contracts";
import { engineFetch, engineFetchStream } from "../engineTransport";
import { resolveEngineUrl } from "../contractRequest";

export type PrinterMachine = {
  id: string;
  name: string;
  model: string;
  bed_width_mm: number;
  bed_depth_mm: number;
  bed_height_mm: number | null;
  margin_mm: number;
  max_filament_slots: number;
  loaded_filaments: Array<{
    slot: number;
    filament_color_id: string | null;
    label: string;
  }>;
  enabled?: boolean;
  integration_id?: string | null;
  device_id?: string | null;
  preset_id?: string | null;
  preferred_slicer?: "orca" | "prusa" | "bambu" | null;
};

export type PrinterPreset = {
  id: string;
  name: string;
  model_slug?: string;
  thumbnail?: string;
  bed_width_mm: number;
  bed_depth_mm: number;
  bed_height_mm: number | null;
  max_filament_slots: number;
};

export type AddPrinterInput =
  | {
      kind: "preset";
      name: string;
      preset_id: string;
    }
  | {
      kind: "custom";
      name: string;
      model: string;
      bed_width_mm: number;
      bed_depth_mm: number;
      bed_height_mm: number;
    };

export type PrinterDetailsInput = Pick<
  PrinterMachine,
  | "name"
  | "model"
  | "bed_width_mm"
  | "bed_depth_mm"
  | "bed_height_mm"
  | "margin_mm"
  | "max_filament_slots"
> & { preset_id: string | null };

export async function fetchPrinterPresets(): Promise<PrinterPreset[]> {
  const body = await engineFetch<{ presets: PrinterPreset[] }>("/printer-presets");
  return body.presets;
}

export async function fetchPrinters(): Promise<PrinterMachine[]> {
  const body = await engineFetch<{ printers: PrinterMachine[] }>("/printers");
  return body.printers;
}

export async function savePrinterFleet(printers: PrinterMachine[]): Promise<PrinterMachine[]> {
  const body = await engineFetch<{ printers: PrinterMachine[] }>("/printers", {
    method: "PUT",
    body: JSON.stringify({ printers }),
  });
  return body.printers;
}

export async function addPrinter(input: AddPrinterInput): Promise<PrinterMachine> {
  const { kind: _kind, ...body } = input;
  return engineFetch<PrinterMachine>("/printers", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function deletePrinter(printerId: string): Promise<void> {
  await engineFetch(`/printers/${printerId}`, { method: "DELETE" });
}

export async function updatePrinterDetails(
  printerId: string,
  details: PrinterDetailsInput,
): Promise<PrinterMachine> {
  return engineFetch<PrinterMachine>(`/printers/${encodeURIComponent(printerId)}/details`, {
    method: "PUT",
    body: JSON.stringify(details),
  });
}

export async function updatePrinterSlicer(
  printerId: string,
  preferredSlicer: "orca" | "prusa" | "bambu" | null,
): Promise<PrinterMachine> {
  return engineFetch<PrinterMachine>(`/printers/${printerId}`, {
    method: "PUT",
    body: JSON.stringify({ preferred_slicer: preferredSlicer }),
  });
}

/** Which printer-host inspection surfaces the linked host can actually serve. */
export type PrinterCapabilities = { files: boolean; cameras: boolean };

/**
 * Ask the server what this printer's host can serve.
 *
 * The server owns the provider matrix, so adding an integration never needs a
 * client edit. A printer with no reachable host reports every capability false.
 */
export async function fetchPrinterCapabilities(printerId: string): Promise<PrinterCapabilities> {
  return engineFetch(`/printers/${encodeURIComponent(printerId)}/capabilities`);
}

/** List one directory of a printer host's storage. The empty path is the root. */
export async function fetchPrinterStorageListing(options: {
  printerId: string;
  path: string;
}): Promise<PrinterStorageListing> {
  const params = new URLSearchParams({ path: options.path });
  return engineFetch(
    `/printers/${encodeURIComponent(options.printerId)}/files?${params}`,
  );
}

/**
 * Download a stored file through the server so host credentials stay server-side.
 *
 * `path` is the only identifier a provider gives an entry, so it is what the
 * content route takes.
 */
export async function openPrinterStoredFile(options: {
  printerId: string;
  file: PrinterStoredFile;
}): Promise<File> {
  const params = new URLSearchParams({ path: options.file.path });
  const response = await engineFetchStream({
    path: `/printers/${encodeURIComponent(options.printerId)}/files/content?${params}`,
  });
  const blob = await response.blob();
  const modified = options.file.modified_at ? Date.parse(options.file.modified_at) : Number.NaN;
  return new File([blob], options.file.name, {
    type: blob.type || "application/octet-stream",
    lastModified: Number.isNaN(modified) ? Date.now() : modified,
  });
}

/**
 * A browser-followable URL for a stored file, served through PrintPartner.
 *
 * Used for the one thing PrintPartner will do with a file it cannot interpret:
 * hand the operator a copy. The host's own URL never reaches the browser.
 */
export function printerStoredFileUrl(options: { printerId: string; path: string }): string {
  const params = new URLSearchParams({ path: options.path });
  return resolveEngineUrl(
    `/printers/${encodeURIComponent(options.printerId)}/files/content?${params}`,
  );
}

export async function fetchPrinterCameras(printerId: string): Promise<PrinterCamera[]> {
  const body = await engineFetch<{ cameras: PrinterCamera[] }>(
    `/printers/${encodeURIComponent(printerId)}/cameras`,
  );
  return body.cameras;
}

export function printerCameraViewUrl(printerId: string, cameraId: string): string {
  const params = new URLSearchParams({ id: cameraId });
  return resolveEngineUrl(
    `/printers/${encodeURIComponent(printerId)}/cameras/view?${params}`,
  );
}
