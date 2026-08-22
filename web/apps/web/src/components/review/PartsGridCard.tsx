import type { PlanReview, ReviewPart } from "../../api/engine";
import { partSourceNote } from "../../lib/partsGroups";
import { partWarningNote } from "../../lib/partWarnings";
import PartThumbExpandButton from "../parts/PartThumbExpandButton";
import { cn } from "../../lib/utils";

type Props = {
  part: ReviewPart;
  review: PlanReview;
  busy: boolean;
  onQtyChange: (part: ReviewPart, qty: number) => void;
  onPreview: (part: ReviewPart) => void;
};

/**
 * Compact grid card for the Parts stage (thumb + qty badge + warning note).
 */
export default function PartsGridCard({
  part,
  review,
  busy,
  onQtyChange,
  onPreview,
}: Props) {
  const qty = part.quantity_override ?? part.quantity_effective;
  const warn = partWarningNote(part, review);
  const note = warn ?? partSourceNote(part);

  return (
    <article
      className={cn(
        "flex flex-col overflow-hidden rounded-md border bg-card",
        warn ? "border-warning/60" : "border-border",
        !part.included && "opacity-70",
      )}
    >
      <div className="relative border-b border-border bg-muted/40">
        <div className="flex h-[84px] items-center justify-center p-1">
          <PartThumbExpandButton part={part} sizePx={72} onExpand={onPreview} />
        </div>
        <span className="absolute right-1.5 top-1.5 rounded bg-foreground px-1.5 py-0.5 font-mono text-[10px] font-medium text-background">
          ×{qty}
        </span>
      </div>
      <div className="flex flex-col gap-1 p-2">
        <p
          className="truncate font-mono text-[10.5px] leading-tight"
          title={part.relative_path || part.filename}
        >
          {part.filename.replace(/\.stl$/i, "")}
        </p>
        <p
          className={cn(
            "truncate text-[10.5px]",
            warn ? "text-warning" : "text-muted-foreground",
          )}
          title={note}
        >
          {note}
        </p>
        {part.included && (
          <div className="qty-control mt-0.5 flex items-center gap-1">
            <button
              type="button"
              className="qty-btn h-7 min-w-7 text-xs"
              disabled={busy || qty <= 1}
              onClick={() => onQtyChange(part, qty - 1)}
              aria-label={`Decrease quantity for ${part.filename}`}
            >
              −
            </button>
            <span className="min-w-[2ch] text-center text-xs font-semibold tabular-nums">
              {qty}
            </span>
            <button
              type="button"
              className="qty-btn h-7 min-w-7 text-xs"
              disabled={busy}
              onClick={() => onQtyChange(part, qty + 1)}
              aria-label={`Increase quantity for ${part.filename}`}
            >
              +
            </button>
          </div>
        )}
      </div>
    </article>
  );
}
