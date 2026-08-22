import { Check } from "lucide-react";
import type { ReviewPart, RoleFilamentRow, SpoolmanSpoolRow } from "../../api/engine";
import type { ReviewViewMode } from "../../lib/persistedReviewPartsUi";
import PartThumbExpandButton from "../parts/PartThumbExpandButton";
import PartSpoolPicker from "../PartSpoolPicker";
import SpoolRemainingBadge from "../SpoolRemainingBadge";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";

type Props = {
  part: ReviewPart;
  viewMode?: ReviewViewMode;
  busy: boolean;
  spoolmanConfigured?: boolean;
  roleFilaments?: RoleFilamentRow[];
  spools?: SpoolmanSpoolRow[];
  spoolsLoading?: boolean;
  onQtyChange: (part: ReviewPart, qty: number) => void;
  onRemove: () => void;
  onRestore: () => void;
  onSpoolChange?: (partId: number, spoolman_spool_id: string | null) => void;
  onToggleUnit?: (part: ReviewPart, unitIndex: number) => void;
  onPreview: (part: ReviewPart) => void;
};

function MobileQtyStepper({
  part,
  disabled,
  onChange,
}: {
  part: ReviewPart;
  disabled?: boolean;
  onChange: (qty: number) => void;
}) {
  const qty = part.quantity_override ?? part.quantity_effective;
  return (
    <div className="qty-control flex items-center gap-1">
      <button
        type="button"
        className="qty-btn rounded-md border min-h-10 min-w-10"
        disabled={disabled || qty <= 1}
        onClick={() => onChange(qty - 1)}
        aria-label={`Decrease quantity for ${part.filename}`}
      >
        −
      </button>
      <span className="qty-display min-w-[2.5ch] text-center text-base font-semibold tabular-nums">
        {qty}
      </span>
      <button
        type="button"
        className="qty-btn rounded-md border min-h-10 min-w-10"
        disabled={disabled}
        onClick={() => onChange(qty + 1)}
        aria-label={`Increase quantity for ${part.filename}`}
      >
        +
      </button>
    </div>
  );
}

export default function ReviewSheetMobileCard({
  part,
  viewMode = "edit",
  busy,
  spoolmanConfigured,
  roleFilaments = [],
  spools = [],
  spoolsLoading,
  onQtyChange,
  onRemove,
  onRestore,
  onSpoolChange,
  onToggleUnit,
  onPreview,
}: Props) {
  const done =
    part.printed_count >= part.quantity_effective && part.quantity_effective > 0;
  const nextIdx = part.print_units.findIndex((u) => !u);

  if (viewMode === "print") {
    return (
      <article
        className={cn(
          "checkoff-mobile-card",
          done && "checkoff-mobile-card-done",
          !part.included && "opacity-80",
        )}
      >
        <div className="checkoff-mobile-card-head">
          <PartThumbExpandButton part={part} sizePx={72} onExpand={onPreview} />
          <div className="checkoff-mobile-card-meta">
            <h4 className="checkoff-mobile-filename" title={part.relative_path || part.filename}>
              {part.filename}
            </h4>
            <p className="checkoff-mobile-sub">
              {part.filament_display && <span>{part.filament_display}</span>}
              <SpoolRemainingBadge part={part} />
              {part.role && <span className="checkoff-mobile-role">{part.role}</span>}
              {!part.included && <span className="checkoff-mobile-role">excluded</span>}
              <span className="checkoff-mobile-qty">
                {part.printed_count}/{part.quantity_effective} printed
              </span>
            </p>
          </div>
        </div>

        {part.included && part.quantity_effective > 0 && onToggleUnit && (
          <>
            <div className="checkoff-mobile-actions">
              <Button
                type="button"
                className="checkoff-mobile-mark-btn h-12 w-full text-base"
                disabled={busy || nextIdx < 0}
                onClick={() => {
                  if (nextIdx >= 0) onToggleUnit(part, nextIdx);
                }}
              >
                <Check className="mr-2 h-5 w-5 shrink-0" aria-hidden />
                {nextIdx < 0 ? "All units printed" : `Mark unit ${nextIdx + 1} done`}
              </Button>
            </div>
            <div className="checkoff-mobile-units" role="group" aria-label="Print units">
              {part.print_units.map((unitDone, idx) => (
                <label
                  key={idx}
                  className={cn("checkoff-mobile-unit", unitDone && "checkoff-mobile-unit-done")}
                >
                  <input
                    type="checkbox"
                    checked={unitDone}
                    onChange={() => onToggleUnit(part, idx)}
                    disabled={busy}
                  />
                  <span>#{idx + 1}</span>
                </label>
              ))}
            </div>
          </>
        )}
      </article>
    );
  }

  return (
    <article className={cn("checkoff-mobile-card", !part.included && "opacity-80")}>
      <div className="checkoff-mobile-card-head">
        <PartThumbExpandButton part={part} sizePx={72} onExpand={onPreview} />
        <div className="checkoff-mobile-card-meta">
          <h4 className="checkoff-mobile-filename" title={part.relative_path || part.filename}>
            {part.filename}
          </h4>
          <p className="checkoff-mobile-sub">
            {part.filament_display && <span>{part.filament_display}</span>}
            <SpoolRemainingBadge part={part} />
            {spoolmanConfigured && onSpoolChange && (
              <PartSpoolPicker
                part={part}
                roleFilaments={roleFilaments}
                spools={spools}
                spoolsLoading={spoolsLoading}
                disabled={busy || !part.included}
                onChange={onSpoolChange}
                className="mt-1 w-full"
              />
            )}
            {part.role && <span className="checkoff-mobile-role">{part.role}</span>}
            {!part.included && <span className="checkoff-mobile-role">excluded</span>}
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        {part.included ? (
          <>
            <MobileQtyStepper
              part={part}
              disabled={busy}
              onChange={(n) => onQtyChange(part, n)}
            />
            <Button
              type="button"
              variant="sheetRemove"
              size="sm"
              className="sheet-remove-btn"
              disabled={busy}
              onClick={onRemove}
            >
              Remove
            </Button>
          </>
        ) : (
          <Button
            type="button"
            variant="sheetRestore"
            className="sheet-restore-btn w-full"
            disabled={busy}
            onClick={onRestore}
          >
            Restore to build
          </Button>
        )}
      </div>
    </article>
  );
}
