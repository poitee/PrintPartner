import { memo } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ReviewPart } from "../../api/engine";
import { SortableShell } from "../dnd/SortableDragHandle";
import CheckoffMobilePartCard from "./CheckoffMobilePartCard";
import ProgressBagBarRow from "./ProgressBagBarRow";
import ProgressPartRow from "./ProgressPartRow";
import { bagRowId, partRowId } from "../../lib/progressListOrder";

type PartProps = {
  kind: "part";
  part: ReviewPart;
  busy: boolean;
  mobile: boolean;
  disabled?: boolean;
  /** Printer host name if this part is currently being printed. */
  printingOn?: string;
  /** Printer host name if this part's print has finished and awaits verify. */
  awaitingVerify?: string;
  /** Suggested printer from an unattributed print candidate. */
  suggestedPrinter?: { hostName: string; printId: string; filename: string };
  /** Global "Enable assembly tracking" setting (Settings > Build Tracking). */
  assemblyTrackingEnabled?: boolean;
  onToggleUnit: (part: ReviewPart, unitIndex: number) => void;
  onIncrement: (part: ReviewPart) => void;
  onDecrement: (part: ReviewPart) => void;
  onPreview: (part: ReviewPart) => void;
  onClaim?: (printId: string) => void;
  /** Called when the user toggles the Assembled switch for a completed unit. */
  onToggleAssembled?: (part: ReviewPart, unitIndex: number) => void;
};

type BagProps = {
  kind: "bag";
  bagId: string;
  label: string;
  busy: boolean;
  mobile: boolean;
  disabled?: boolean;
  onLabelChange: (label: string) => void;
  onRemove: () => void;
};

type Props = PartProps | BagProps;

export default memo(function SortableProgressPart(props: Props) {
  const sortableId = props.kind === "part" ? partRowId(props.part.id) : bagRowId(props.bagId);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({
      id: sortableId,
      disabled: props.disabled || props.busy,
    });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const dragHandle = {
    attributes,
    listeners,
    disabled: props.disabled || props.busy,
  };

  return (
    <SortableShell style={style} isDragging={isDragging} className="rounded-[10px]">
      <div ref={setNodeRef}>
        {props.kind === "bag" ? (
          <ProgressBagBarRow
            label={props.label}
            busy={props.busy}
            compact={props.mobile}
            onLabelChange={props.onLabelChange}
            onRemove={props.onRemove}
            dragHandle={dragHandle}
          />
        ) : props.mobile ? (
          <CheckoffMobilePartCard
            part={props.part}
            busy={props.busy}
            onToggleUnit={props.onToggleUnit}
            onPreview={props.onPreview}
            printingOn={props.printingOn}
            awaitingVerify={props.awaitingVerify}
            suggestedPrinter={props.suggestedPrinter}
            assemblyTrackingEnabled={props.assemblyTrackingEnabled}
            onClaim={props.onClaim}
            onToggleAssembled={props.onToggleAssembled}
            dragHandle={dragHandle}
          />
        ) : (
          <ProgressPartRow
            part={props.part}
            busy={props.busy}
            onIncrement={props.onIncrement}
            onDecrement={props.onDecrement}
            onPreview={props.onPreview}
            printingOn={props.printingOn}
            awaitingVerify={props.awaitingVerify}
            suggestedPrinter={props.suggestedPrinter}
            assemblyTrackingEnabled={props.assemblyTrackingEnabled}
            onClaim={props.onClaim}
            onToggleAssembled={props.onToggleAssembled}
            dragHandle={dragHandle}
          />
        )}
      </div>
    </SortableShell>
  );
});
