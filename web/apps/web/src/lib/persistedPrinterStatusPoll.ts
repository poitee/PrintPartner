/** Persisted printer status poll interval (UI preference, localStorage). */

export const PRINTER_STATUS_POLL_STORAGE_KEY = "print-partner.printer-status-poll.v1";

export const PRINTER_STATUS_POLL_SECONDS_OPTIONS = [5, 10, 15, 30] as const;

export type PrinterStatusPollSeconds = (typeof PRINTER_STATUS_POLL_SECONDS_OPTIONS)[number];

export const DEFAULT_PRINTER_STATUS_POLL_SECONDS: PrinterStatusPollSeconds = 5;

/** Custom event so open pages pick up Settings changes without a reload. */
export const PRINTER_STATUS_POLL_CHANGED_EVENT = "pp-printer-status-poll-changed";

export function isPrinterStatusPollSeconds(value: unknown): value is PrinterStatusPollSeconds {
  return (
    typeof value === "number" &&
    (PRINTER_STATUS_POLL_SECONDS_OPTIONS as readonly number[]).includes(value)
  );
}

export function parsePrinterStatusPollSeconds(raw: string | null): PrinterStatusPollSeconds {
  if (raw == null || raw.trim() === "") return DEFAULT_PRINTER_STATUS_POLL_SECONDS;
  const n = Number(raw);
  return isPrinterStatusPollSeconds(n) ? n : DEFAULT_PRINTER_STATUS_POLL_SECONDS;
}

export function readPrinterStatusPollSeconds(): PrinterStatusPollSeconds {
  if (typeof localStorage === "undefined") return DEFAULT_PRINTER_STATUS_POLL_SECONDS;
  return parsePrinterStatusPollSeconds(localStorage.getItem(PRINTER_STATUS_POLL_STORAGE_KEY));
}

export function writePrinterStatusPollSeconds(seconds: PrinterStatusPollSeconds): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(PRINTER_STATUS_POLL_STORAGE_KEY, String(seconds));
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(PRINTER_STATUS_POLL_CHANGED_EVENT, { detail: { seconds } }),
    );
  }
}

export function printerStatusPollMs(seconds?: PrinterStatusPollSeconds): number {
  const s = seconds ?? readPrinterStatusPollSeconds();
  return s * 1000;
}
