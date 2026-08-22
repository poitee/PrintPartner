import type { PrinterHostStatus } from "../api/engine";
import { quietPrinterStatusMessage } from "./printerErrorCopy";

export type LiveStripHostType = "moonraker" | "prusalink" | "bambu";

/** Poll linked hosts for Progress — avoid hammering LAN printers. */
export const PRINTER_LIVE_STRIP_POLL_MS = 5_000;

/** Format optional ETA for the Progress live strip. */
export function formatEtaSeconds(etaSeconds: number | undefined | null): string | null {
  if (etaSeconds == null || !Number.isFinite(etaSeconds) || etaSeconds < 0) return null;
  const s = Math.round(etaSeconds);
  if (s < 60) return `~${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `~${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `~${h}h ${rem}m` : `~${h}h`;
}

export function printerHostTypeLabel(type: LiveStripHostType): string {
  switch (type) {
    case "moonraker":
      return "Moonraker";
    case "prusalink":
      return "PrusaLink";
    case "bambu":
      return "Bambu";
    default:
      return type;
  }
}

/** Desk English for status board (not raw API ids). */
export function printerDeskTypeLabel(type: LiveStripHostType): string {
  switch (type) {
    case "moonraker":
      return "Klipper";
    case "prusalink":
      return "Prusa";
    case "bambu":
      return "Bambu";
    default:
      return type;
  }
}

/** `Shop Voron · Moonraker` */
export function formatPrinterHostCaption(name: string, type: LiveStripHostType): string {
  return `${name} · ${printerHostTypeLabel(type)}`;
}

export function printerLiveStripTone(
  state: PrinterHostStatus["state"] | undefined,
): "idle" | "printing" | "paused" | "complete" | "error" | "offline" | "unknown" {
  switch (state) {
    case "idle":
    case "printing":
    case "paused":
    case "complete":
    case "error":
    case "offline":
      return state;
    default:
      return "unknown";
  }
}

/**
 * Job line for the Progress live strip (name/type shown separately).
 * Example: `Printing frame_x.gcode · 34% · ETA ~12m`
 */
export function formatPrinterJobLine(
  status: PrinterHostStatus | null | undefined,
): string {
  if (!status) return "…";

  if (status.state === "offline") return "Offline";
  if (status.state === "error") {
    const detail = quietPrinterStatusMessage(status.message) ?? status.message?.trim();
    return detail ? `Error · ${detail}` : "Error";
  }
  if (status.state === "printing" || status.state === "paused") {
    const verb = status.state === "paused" ? "Paused" : "Printing";
    const filename = status.filename?.trim();
    const head = filename ? `${verb} ${filename}` : verb;
    const parts = [head];
    if (status.progress != null && Number.isFinite(status.progress)) {
      parts.push(`${Math.round(status.progress)}%`);
    }
    const eta = formatEtaSeconds(status.eta_seconds);
    if (eta) parts.push(`ETA ${eta}`);
    return parts.join(" · ");
  }
  if (status.state === "complete") {
    const filename = status.filename?.trim();
    return filename ? `Complete · ${filename}` : "Complete";
  }
  if (status.state === "idle") return "Idle";
  const msg = quietPrinterStatusMessage(status.message);
  return msg || status.state;
}

/** Compact status pill, e.g. `Printing 42%` / `Idle` / `Offline`. */
export function formatPrinterStatusPill(
  status: PrinterHostStatus | null | undefined,
): string {
  if (!status) return "…";
  if (status.state === "printing" || status.state === "paused") {
    const label = status.state === "paused" ? "Paused" : "Printing";
    if (status.progress != null && Number.isFinite(status.progress)) {
      return `${label} ${Math.round(status.progress)}%`;
    }
    return label;
  }
  if (status.state === "complete") return "Complete";
  if (status.state === "idle") return "Idle";
  if (status.state === "offline") return "Offline";
  if (status.state === "error") return "Error";
  return status.state;
}

/**
 * One-line summary for a linked host on Progress (legacy / tests).
 * Example: `Shop Voron · Printing frame_x.gcode · 34% · ETA ~12m`
 */
export function formatPrinterLiveLine(opts: {
  name: string;
  status: PrinterHostStatus | null | undefined;
}): string {
  const { name, status } = opts;
  if (!status) return `${name} · …`;
  const job = formatPrinterJobLine(status);
  if (status.state === "printing" || status.state === "paused") {
    return `${name} · ${job}`;
  }
  return `${name} · ${job}`;
}
