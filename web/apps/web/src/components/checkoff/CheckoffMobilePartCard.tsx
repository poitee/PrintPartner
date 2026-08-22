import type { DraggableAttributes, DraggableSyntheticListeners } from "@dnd-kit/core";
import type { ReviewPart } from "../../api/engine";
import {
  lastCompletedUnit,
  nextUnitToComplete,
} from "../../lib/checkoffProgress";
import ProgressPartRow from "./ProgressPartRow";

type Props = {
  part: ReviewPart;
  busy: boolean;
  /** Printer host name if this part is currently being printed. */
  printingOn?: string;
  /** Printer host name if this part's print has finished and awaits verify. */
  awaitingVerify?: string;
  /** Suggested printer from an unattributed print candidate. */
  suggestedPrinter?: { hostName: string; printId: string; filename: string };
  /** Global "Enable assembly tracking" setting (Settings > Build Tracking). */
  assemblyTrackingEnabled?: boolean;
  onToggleUnit: (part: ReviewPart, unitIndex: number) => void;
  onPreview: (part: ReviewPart) => void;
  onClaim?: (printId: string) => void;
  /** Called when the user toggles the Assembled switch for a completed unit. */
  onToggleAssembled?: (part: ReviewPart, unitIndex: number) => void;
  dragHandle?: {
    attributes: DraggableAttributes;
    listeners: DraggableSyntheticListeners;
    disabled?: boolean;
  };
};

/** Phone-first Progress row (shop floor). Matches Workflow mock density. */
export default function CheckoffMobilePartCard({
  part,
  busy,
  printingOn,
  awaitingVerify,
  suggestedPrinter,
  assemblyTrackingEnabled,
  onToggleUnit,
  onPreview,
  onClaim,
  onToggleAssembled,
  dragHandle,
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
      onClaim={onClaim}
      onToggleAssembled={onToggleAssembled}
      dragHandle={dragHandle}
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
