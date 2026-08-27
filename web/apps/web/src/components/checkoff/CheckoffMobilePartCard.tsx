import type { DraggableAttributes, DraggableSyntheticListeners } from "@dnd-kit/core";
import type { ReviewPart } from "../../api/endpoints/planManifests";
import type { CheckoffRowError } from "../../lib/checkoffConsoleRowErrors";
import {
  lastCompletedUnit,
  nextUnitToComplete,
} from "../../lib/checkoffProgress";
import ProgressPartRow from "./ProgressPartRow";
import type { CheckoffRowMoveControls } from "./CheckoffRowActionsMenu";
import type { SuggestedPrinterClaim } from "../../lib/checkoffPrinterActivity";

type Props = {
  part: ReviewPart;
  busy: boolean;
  /** Printer host name if this part is currently being printed. */
  printingOn?: string;
  /** Printer host name if this part's print has finished and awaits verify. */
  awaitingVerify?: string;
  /** Suggested printer from an unattributed print candidate. */
  suggestedPrinter?: SuggestedPrinterClaim;
  /** Global "Enable assembly tracking" setting (Settings > Build Tracking). */
  assemblyTrackingEnabled?: boolean;
  moveControls?: CheckoffRowMoveControls;
  rowError?: CheckoffRowError | null;
  onRetry?: () => void;
  correctionNote?: string;
  onToggleUnit: (part: ReviewPart, unitIndex: number) => void;
  onPreview: (part: ReviewPart) => void;
  onClaim?: (suggestion: SuggestedPrinterClaim) => void;
  /** Called when the user toggles the Assembled switch for a completed unit. */
  onToggleAssembled?: (part: ReviewPart, unitIndex: number) => void;
  dragHandle?: {
    attributes: DraggableAttributes;
    listeners: DraggableSyntheticListeners;
    disabled?: boolean;
  };
};

/**
 * Phone Checkoff row. Drag is left out on touch: the row reorders through the
 * Move controls in its actions menu instead.
 */
export default function CheckoffMobilePartCard({
  part,
  busy,
  printingOn,
  awaitingVerify,
  suggestedPrinter,
  assemblyTrackingEnabled,
  moveControls,
  rowError,
  onRetry,
  correctionNote,
  onToggleUnit,
  onPreview,
  onClaim,
  onToggleAssembled,
}: Props) {
  return (
    <ProgressPartRow
      part={part}
      busy={busy}
      compact
      printingOn={printingOn}
      awaitingVerify={awaitingVerify}
      suggestedPrinter={suggestedPrinter}
      assemblyTrackingEnabled={assemblyTrackingEnabled}
      moveControls={moveControls}
      rowError={rowError}
      onRetry={onRetry}
      correctionNote={correctionNote}
      onClaim={onClaim}
      onToggleAssembled={onToggleAssembled}
      onIncrement={(p) => {
        const idx = nextUnitToComplete(p.print_units);
        if (idx >= 0) onToggleUnit(p, idx);
      }}
      onDecrement={(p) => {
        const idx = lastCompletedUnit(p.print_units);
        if (idx >= 0) onToggleUnit(p, idx);
      }}
      onPreview={onPreview}
    />
  );
}
