/**
 * Per-plate approval gate — shown after slicing when a gcode file has been
 * chosen but not yet sent to a printer.
 *
 * Displays the slicer thumbnail, printer + plate index, estimated print time,
 * filament weight, and any slicer warnings (unmatched object names).
 *
 * Approve calls the supplied onApprove callback (which triggers the existing
 * enqueuePrinterSend / startPrinterUpload send path).
 * Reject clears the chosen file so the user can re-slice without dispatching.
 */

import { AlertTriangle, CheckCircle2, Clock, Printer, XCircle } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { cn } from "../../lib/utils";

export type PlateApprovalInfo = {
  /** PNG data-URL from the slicer 3MF thumbnail, if available. */
  thumbnailUrl?: string;
  /** Human-readable printer name. */
  printerName: string;
  /** 1-based plate index within this send (manual send is always 1 of 1). */
  plateIndex: number;
  /** Total plates in this file (manual send is always 1). */
  plateTotal: number;
  /** Formatted print time string, e.g. "1h 23m 45s". */
  printTime?: string;
  /** Filament weight in grams. */
  filamentWeightG?: number;
  /** Object names from the gcode that did not match any plan parts (slicer warnings). */
  unmatchedNames?: string[];
  /** Whether the approve/send action is in flight. */
  busy?: boolean;
};

type Props = PlateApprovalInfo & {
  /** Called when the user clicks Approve (→ triggers send). */
  onApprove: () => void;
  /** Called when the user clicks Reject (→ clears the chosen file). */
  onReject: () => void;
  className?: string;
};

export default function PlateApprovalCard({
  thumbnailUrl,
  printerName,
  plateIndex,
  plateTotal,
  printTime,
  filamentWeightG,
  unmatchedNames = [],
  busy = false,
  onApprove,
  onReject,
  className,
}: Props) {
  const hasWarnings = unmatchedNames.length > 0;
  const plateLabel =
    plateTotal > 1 ? `Plate ${plateIndex} of ${plateTotal}` : `Plate ${plateIndex}`;

  return (
    <Card
      className={cn(
        "border-border shadow-sm",
        hasWarnings && "border-warning/50",
        className,
      )}
    >
      {/* Thumbnail */}
      {thumbnailUrl ? (
        <div className="overflow-hidden rounded-t-md border-b border-border bg-muted/30">
          <img
            src={thumbnailUrl}
            alt={`${plateLabel} preview`}
            className="h-auto max-h-48 w-full object-contain"
          />
        </div>
      ) : null}

      <CardHeader className="pb-2 pt-3">
        <CardTitle level={3} className="flex flex-wrap items-center gap-2 text-[13.5px] font-semibold leading-snug">
          <Printer className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{printerName}</span>
          <Badge variant="muted" className="shrink-0 font-mono text-[10.5px] font-normal">
            {plateLabel}
          </Badge>
        </CardTitle>
      </CardHeader>

      <CardContent className="flex flex-col gap-3 pt-0">
        {/* Stats row */}
        {(printTime != null || filamentWeightG != null) && (
          <div className="flex flex-wrap gap-3 text-[11.5px] text-muted-foreground">
            {printTime != null && (
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3 shrink-0" aria-hidden />
                {printTime}
              </span>
            )}
            {filamentWeightG != null && (
              <span className="flex items-center gap-1">
                🧵 {filamentWeightG.toFixed(1)} g
              </span>
            )}
          </div>
        )}

        {/* Warnings */}
        {hasWarnings && (
          <div className="rounded-md border border-warning/30 bg-warning/10 p-2">
            <p className="mb-1 flex items-center gap-1 text-[11.5px] font-medium text-warning">
              <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
              Unmatched objects — will not appear on Progress
            </p>
            <ul className="space-y-0.5 pl-4">
              {unmatchedNames.map((name) => (
                <li key={name} className="truncate font-mono text-[10.5px] text-warning/80">
                  {name}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Action row */}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="default"
            disabled={busy}
            loading={busy}
            onClick={onApprove}
            className="gap-1.5"
          >
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
            {busy ? "Sending…" : "Approve"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={onReject}
            className="gap-1.5"
          >
            <XCircle className="h-3.5 w-3.5" aria-hidden />
            Reject
          </Button>
        </div>

        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Approve sends the file to <span className="font-medium text-foreground">{printerName}</span>.
          Reject discards this file so you can re-slice.
        </p>
      </CardContent>
    </Card>
  );
}
