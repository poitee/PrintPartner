/**
 * PrinterQueueSuggestionBanner
 *
 * Shows a non-blocking banner when queued files target an idle Printer. The
 * operator can trigger the drain or dismiss the suggestion.
 *
 * The parent supplies suggestions from its existing Printer status polling.
 */

import { useState } from "react";
import { Printer, SendHorizonal, X } from "lucide-react";
import {
  drainPrinterSendQueue,
  type PrinterQueueSuggestion,
} from "../../api/engine";
import { Button } from "../ui/button";
import { cn } from "@/lib/utils";

type Props = {
  suggestions: PrinterQueueSuggestion[];
  onDrained?: (printerId?: string) => void;
  /** Called when the user dismisses all suggestions. */
  onDismiss?: () => void;
  className?: string;
};

function pluralItems(n: number): string {
  return n === 1 ? "1 plate" : `${n} plates`;
}

function filamentSummary(suggestion: PrinterQueueSuggestion): string {
  // Collect distinct filament ids across matched items, show top 3.
  const seen = new Set<string>();
  for (const item of suggestion.items) {
    for (const id of item.filament_color_ids) {
      seen.add(id);
    }
  }
  const ids = [...seen];
  if (!ids.length) return "";
  if (ids.length <= 3) return ids.join(", ");
  return `${ids.slice(0, 3).join(", ")} +${ids.length - 3}`;
}

/**
 * A single suggestion row for one idle printer.
 */
function SuggestionRow({
  suggestion,
  onSend,
  onDismiss,
  busy,
}: {
  suggestion: PrinterQueueSuggestion;
  onSend: () => void;
  onDismiss: () => void;
  busy: boolean;
}) {
  const filaments = filamentSummary(suggestion);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-info/30 bg-info-soft px-3 py-2 text-sm text-info">
      <Printer className="h-4 w-4 shrink-0 opacity-80" aria-hidden />
      <div className="min-w-0 flex-1 leading-snug">
        <p className="font-medium">{suggestion.printer_name} — Idle</p>
        <p className="text-xs font-normal opacity-90">
          {pluralItems(suggestion.item_count)} queued
          {filaments ? ` · ${filaments}` : ""}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          size="sm"
          variant="default"
          className="h-7 gap-1 px-2.5 text-xs"
          onClick={onSend}
          disabled={busy}
          aria-label={`Send queued plates to ${suggestion.printer_name}`}
        >
          <SendHorizonal className="h-3.5 w-3.5" aria-hidden />
          Send
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0 text-info hover:text-info"
          onClick={onDismiss}
          disabled={busy}
          aria-label={`Dismiss suggestion for ${suggestion.printer_name}`}
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </div>
    </div>
  );
}

/**
 * Banner shown near the PrinterLiveStrip when an exact queued Printer is idle.
 *
 * Clicking Send triggers a queue drain. Dispatch keeps every sliced file on
 * the Printer recorded by its queue item.
 */
export default function PrinterQueueSuggestionBanner({
  suggestions,
  onDrained,
  onDismiss,
  className,
}: Props) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const visible = suggestions.filter((s) => !dismissed.has(s.printer_id));
  if (!visible.length) return null;

  const handleSend = async (printerId?: string) => {
    setBusy(true);
    try {
      await drainPrinterSendQueue(
        printerId === undefined ? undefined : { printer_id: printerId },
      );
      if (onDrained) {
        onDrained(printerId);
      } else {
        setDismissed((previous) =>
          printerId === undefined
            ? new Set(suggestions.map((suggestion) => suggestion.printer_id))
            : new Set([...previous, printerId]),
        );
      }
    } catch {
      // Drain failures are surfaced via the queue item error state; don't
      // show a second error here — the user will see it in the send queue.
    } finally {
      setBusy(false);
    }
  };

  const handleDismissOne = (printerId: string) => {
    setDismissed((prev) => new Set([...prev, printerId]));
    if (dismissed.size + 1 >= suggestions.length) {
      onDismiss?.();
    }
  };

  const handleDismissAll = () => {
    setDismissed(new Set(suggestions.map((s) => s.printer_id)));
    onDismiss?.();
  };

  return (
    <div
      className={cn("flex flex-col gap-1.5 print:hidden", className)}
      role="region"
      aria-label="Print queue suggestions"
    >
      {visible.map((s) => (
        <SuggestionRow
          key={s.printer_id}
          suggestion={s}
          onSend={() => void handleSend(s.printer_id)}
          onDismiss={() => handleDismissOne(s.printer_id)}
          busy={busy}
        />
      ))}
      {visible.length > 1 && (
        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => void handleSend()}
            disabled={busy}
          >
            Send all
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs"
            onClick={handleDismissAll}
            disabled={busy}
          >
            Dismiss all
          </Button>
        </div>
      )}
    </div>
  );
}
