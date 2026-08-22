import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_PRINTER_STATUS_POLL_SECONDS,
  PRINTER_STATUS_POLL_CHANGED_EVENT,
  isPrinterStatusPollSeconds,
  printerStatusPollMs,
  readPrinterStatusPollSeconds,
  type PrinterStatusPollSeconds,
} from "../lib/persistedPrinterStatusPoll";

/** Live printer status poll interval from Settings (pauses when document.hidden at call sites). */
export function usePrinterStatusPollMs(): number {
  const [seconds, setSeconds] = useState<PrinterStatusPollSeconds>(() =>
    typeof window === "undefined"
      ? DEFAULT_PRINTER_STATUS_POLL_SECONDS
      : readPrinterStatusPollSeconds(),
  );

  const refresh = useCallback(() => {
    setSeconds(readPrinterStatusPollSeconds());
  }, []);

  useEffect(() => {
    refresh();
    const onChanged = (e: Event) => {
      const detail = (e as CustomEvent<{ seconds?: unknown }>).detail;
      if (isPrinterStatusPollSeconds(detail?.seconds)) {
        setSeconds(detail.seconds);
        return;
      }
      refresh();
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key == null || e.key === "print-partner.printer-status-poll.v1") refresh();
    };
    window.addEventListener(PRINTER_STATUS_POLL_CHANGED_EVENT, onChanged);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(PRINTER_STATUS_POLL_CHANGED_EVENT, onChanged);
      window.removeEventListener("storage", onStorage);
    };
  }, [refresh]);

  return printerStatusPollMs(seconds);
}
