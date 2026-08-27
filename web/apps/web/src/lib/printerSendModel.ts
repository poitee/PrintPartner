import type { PrinterHostStatus } from "@print-partner/contracts";
import type { IntegrationSummary } from "../api/endpoints/integrations";
import type { PrinterMachine } from "../api/endpoints/printers";

export type PrinterSendStatusVariant = "success" | "muted" | "default" | "warning" | "error";
export type SendHostType = "moonraker" | "prusalink";

const SEND_HOST_TYPES = new Set<SendHostType>(["moonraker", "prusalink"]);

export type PrinterSendFleet = {
  sendPrinters: PrinterMachine[];
  bambuPrinters: PrinterMachine[];
  hostTypeByPrinterId: Record<string, SendHostType | "bambu">;
};

export function isAllowedGcode(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".gcode") || lower.endsWith(".bgcode") || lower.endsWith(".gco");
}

export function isAllowedBambuConnectFile(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.endsWith(".gcode.3mf") ||
    lower.endsWith(".3mf") ||
    lower.endsWith(".gcode") ||
    lower.endsWith(".gco")
  );
}

export function partitionPrinterSendFleet(
  printers: readonly PrinterMachine[],
  integrations: readonly IntegrationSummary[],
): PrinterSendFleet {
  const byId = new Map<string, IntegrationSummary>(integrations.map((integration) => [integration.id, integration]));
  const sendPrinters: PrinterMachine[] = [];
  const bambuPrinters: PrinterMachine[] = [];
  const hostTypeByPrinterId: Record<string, SendHostType | "bambu"> = {};

  for (const printer of printers) {
    const integrationId = printer.integration_id?.trim();
    if (!integrationId) continue;
    const host = byId.get(integrationId);
    if (!host || host.config.enabled === false) continue;
    if (SEND_HOST_TYPES.has(host.type as SendHostType)) {
      sendPrinters.push(printer);
      hostTypeByPrinterId[printer.id] = host.type as SendHostType;
    } else if (host.type === "bambu") {
      bambuPrinters.push(printer);
      hostTypeByPrinterId[printer.id] = "bambu";
    }
  }

  return { sendPrinters, bambuPrinters, hostTypeByPrinterId };
}

export function printerSendStatusLabel(status: PrinterHostStatus | undefined): string {
  if (!status) return "…";
  switch (status.state) {
    case "idle":
      return "Idle";
    case "printing":
      return status.progress != null ? `Printing ${Math.round(status.progress)}%` : "Printing";
    case "paused":
      return "Paused";
    case "complete":
      return "Complete";
    case "error":
      return "Error";
    case "offline":
      return "Offline";
    default:
      return status.state;
  }
}

export function printerSendStatusVariant(
  status: PrinterHostStatus | undefined,
): PrinterSendStatusVariant {
  if (!status) return "muted";
  switch (status.state) {
    case "idle":
    case "complete":
      return "success";
    case "printing":
      return "default";
    case "paused":
      return "warning";
    case "error":
    case "offline":
      return "error";
    default:
      return "muted";
  }
}

/** Resolve sticky pick if still in list; otherwise first printer. Never jumps to Idle. */
export function resolveStickyPrinterId(
  printers: PrinterMachine[],
  sticky: string,
  prev: string,
): string {
  if (prev && printers.some((printer) => printer.id === prev)) return prev;
  if (sticky && printers.some((printer) => printer.id === sticky)) return sticky;
  return printers[0]?.id ?? "";
}
