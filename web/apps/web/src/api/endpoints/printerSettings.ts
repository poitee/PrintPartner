import { engineFetch } from "../engineTransport";

export type PrinterPlanBinding = {
  integration_id: string;
  profile_id: number | null;
  updated_at: string;
};

export type PrinterProfileAssignment = {
  printer_id: string;
  profile_source: "assigned" | "auto_match";
  machine_profile_id: number | null;
  filament_slots: Array<{ slot_index: number; filament_profile_id: number | null }>;
  last_synced_at: string | null;
  compatible_processes: Array<{ id: number; name: string }>;
};

export type PrinterProfileAssignmentInput = {
  profile_source: "assigned" | "auto_match";
  machine_profile_id: number | null;
  filament_slots: Array<{ slot_index: number; filament_profile_id: number | null }>;
};

export async function fetchPrinterPlanBindings(): Promise<PrinterPlanBinding[]> {
  const body = await engineFetch<{ bindings: PrinterPlanBinding[] }>("/settings/printer-plan-bindings");
  return body.bindings;
}

export async function savePrinterPlanBinding(
  integration_id: string,
  profile_id: number | null,
): Promise<PrinterPlanBinding[]> {
  const body = await engineFetch<{ bindings: PrinterPlanBinding[] }>("/settings/printer-plan-bindings", {
    method: "PUT",
    body: JSON.stringify({ integration_id, profile_id }),
  });
  return body.bindings;
}

export async function deletePrinterPlanBinding(integration_id: string): Promise<void> {
  await engineFetch<{ ok: boolean }>(`/settings/printer-plan-bindings/${encodeURIComponent(integration_id)}`, {
    method: "DELETE",
  });
}

export async function fetchPrinterProfileAssignment(
  printerId: string,
): Promise<PrinterProfileAssignment> {
  return engineFetch<PrinterProfileAssignment>(
    `/printers/${encodeURIComponent(printerId)}/profile-assignment`,
  );
}

export async function savePrinterProfileAssignment(
  printerId: string,
  body: PrinterProfileAssignmentInput,
): Promise<PrinterProfileAssignment> {
  return engineFetch<PrinterProfileAssignment>(
    `/printers/${encodeURIComponent(printerId)}/profile-assignment`,
    {
      method: "PUT",
      body: JSON.stringify(body),
    },
  );
}
