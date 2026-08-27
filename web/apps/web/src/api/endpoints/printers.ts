import { engineFetch } from "../engineTransport";

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
