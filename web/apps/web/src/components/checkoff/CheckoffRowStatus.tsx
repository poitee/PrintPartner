import type { ReviewPart } from "../../api/endpoints/planManifests";
import type { SuggestedPrinterClaim } from "../../lib/checkoffPrinterActivity";
import { assembledEligibleUnitIndices } from "../../lib/checkoffProgress";
import { statusTone } from "../../lib/statusTone";
import { cn } from "@/lib/utils";
import { Switch } from "../ui/switch";

function truncateFilename(name: string, maxLen = 20): string {
  if (name.length <= maxLen) return name;
  return name.slice(0, maxLen - 1) + "\u2026";
}

/**
 * Assembled toggles — one per completed unit, only rendered when the global
 * Assembled Tracking setting is on. Hidden entirely when there is nothing
 * completed yet, since "assembled" tracks installed-but-already-printed state.
 */
export function AssembledToggles({
  part,
  busy,
  onToggleAssembled,
}: {
  part: ReviewPart;
  busy: boolean;
  onToggleAssembled: (part: ReviewPart, unitIndex: number) => void;
}) {
  const assembledUnits = part.assembled_units ?? [];
  const completedIndices = assembledEligibleUnitIndices(part.print_units);
  if (completedIndices.length === 0) return null;
  const showUnitNumber = part.print_units.length > 1;
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="assembled-toggles">
      {completedIndices.map((idx) => {
        const isAssembled = assembledUnits[idx] ?? false;
        const label = showUnitNumber ? `Assembled #${idx + 1}` : "Assembled";
        return (
          <label
            key={idx}
            className={cn(
              "flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-micro font-medium text-muted-foreground",
              isAssembled && statusTone({ tone: "success", emphasis: "soft" }),
            )}
          >
            <Switch
              checked={isAssembled}
              disabled={busy}
              onCheckedChange={() => onToggleAssembled(part, idx)}
              aria-label={`${label} for ${part.filename}`}
              className="h-4 w-7 [&>span]:size-3 [&>span]:data-[state=checked]:translate-x-3"
            />
            <span>{label}</span>
          </label>
        );
      })}
    </div>
  );
}

/** Status badges rendered under the filename. At most one printing/awaiting badge shows. */
export function StatusBadges({
  inCompact,
  printingOn,
  awaitingVerify,
  suggestedPrinter,
  busy,
  onClaim,
}: {
  inCompact: boolean;
  printingOn?: string;
  awaitingVerify?: string;
  suggestedPrinter?: SuggestedPrinterClaim;
  busy: boolean;
  onClaim?: (suggestion: SuggestedPrinterClaim) => void;
}) {
  return (
    <>
      {/* Finished on a host and waiting for a person to confirm it. */}
      {awaitingVerify && (
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-micro font-medium",
            statusTone({ tone: "success", emphasis: "soft" }),
          )}
        >
          <span aria-hidden>✓</span> Finished on {awaitingVerify}, needs verification
        </span>
      )}

      {/* Actively printing — only when not already awaiting verify */}
      {!awaitingVerify && printingOn && (
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-micro font-medium",
            statusTone({ tone: "info", emphasis: "soft" }),
          )}
        >
          <span
            className="inline-block h-2 w-2 rounded-full bg-info animate-pulse"
            aria-hidden
          />
          Printing on {printingOn}
        </span>
      )}

      {/* Suggested printer from unattributed print */}
      {suggestedPrinter && !printingOn && !awaitingVerify && (
        <span
          className={cn(
            "inline-flex flex-wrap items-center gap-1.5 rounded-full px-2 py-0.5 text-micro font-medium",
            statusTone({ tone: "warning", emphasis: "soft" }),
          )}
        >
          <span aria-hidden>⚡</span>
          <span>
            Possibly on {suggestedPrinter.hostName} [{truncateFilename(suggestedPrinter.filename)}]
          </span>
          <button
            type="button"
            className={cn(
              "rounded px-1.5 py-0 text-micro font-semibold hover:bg-warning/20",
              statusTone({ tone: "warning", emphasis: "outline" }),
              inCompact ? "h-5" : "h-4",
            )}
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              onClaim?.(suggestedPrinter);
            }}
          >
            Claim
          </button>
        </span>
      )}
    </>
  );
}

