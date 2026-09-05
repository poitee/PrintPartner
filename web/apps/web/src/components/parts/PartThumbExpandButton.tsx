import { Maximize2 } from "lucide-react";
import PartThumb from "./PartThumb";
import type { PreviewDialogPart } from "./PartPreviewDialog";

type Props<P extends PreviewDialogPart & { id: number }> = {
  part: P;
  compact?: boolean;
  sizePx?: number;
  eager?: boolean;
  onExpand: (part: P) => void;
};

/**
 * Sheet thumbnail wrapped in an accessible button that opens the expanded
 * 3D preview dialog. Styled so the printed sheet is identical to the plain
 * thumbnail (the expand badge carries `no-print`).
 */
export default function PartThumbExpandButton<P extends PreviewDialogPart & { id: number }>({
  part,
  compact,
  sizePx,
  eager,
  onExpand,
}: Props<P>) {
  if (part.id <= 0) {
    return (
      <span
        className="sheet-thumb-btn"
        aria-label={`3D preview for ${part.filename} is available after saving`}
        title="3D preview is available once this file is saved to the Plan"
      >
        <PartThumb
          partId={part.id}
          tintHex={part.filament_hex}
          compact={compact}
          sizePx={sizePx}
          eager={eager}
          fallbackLabel={part.filename}
        />
      </span>
    );
  }
  return (
    <button
      type="button"
      className="sheet-thumb-btn focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
      aria-label={`Preview 3D model of ${part.filename}`}
      onClick={() => onExpand(part)}
    >
      <PartThumb
        partId={part.id}
        tintHex={part.filament_hex}
        compact={compact}
        sizePx={sizePx}
        eager={eager}
        fallbackLabel={part.filename}
      />
      <span className="sheet-thumb-expand no-print" aria-hidden>
        <Maximize2 />
      </span>
    </button>
  );
}
