import { useId } from "react";
import { Check } from "lucide-react";
import type { ReviewPart } from "../../api/endpoints/planManifests";
import type { QuantityUpdate } from "../../context/PlanWorkspaceContext";
import type { RoleFilamentRow, SpoolmanSpoolRow } from "../../api/endpoints/filaments";
import type { ReviewViewMode } from "../../lib/persistedReviewPartsUi";
import PartThumbExpandButton from "../parts/PartThumbExpandButton";
import PartSpoolPicker from "../PartSpoolPicker";
import SpoolRemainingBadge from "../SpoolRemainingBadge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { cn } from "@/lib/utils";
import QuantityStepper from "./QuantityStepper";

type Props = {
  part: ReviewPart;
  viewMode?: ReviewViewMode;
  busy: boolean;
  quantityDisabled: boolean;
  spoolmanConfigured?: boolean;
  roleFilaments?: RoleFilamentRow[];
  spools?: SpoolmanSpoolRow[];
  spoolsLoading?: boolean;
  onQtyChange: (part: ReviewPart, update: QuantityUpdate) => void;
  onRemove: () => void;
  onRestore: () => void;
  onSpoolChange?: (partId: number, spoolman_spool_id: string | null) => void;
  onToggleUnit?: (part: ReviewPart, unitIndex: number) => void;
  onPreview: (part: ReviewPart) => void;
};

export default function ReviewSheetMobileCard({
  part,
  viewMode = "edit",
  busy,
  quantityDisabled,
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
  const unitFieldId = useId();

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
              {part.print_units.map((unitDone, idx) => {
                const unitId = `${unitFieldId}-${idx}`;
                return (
                  <label
                    key={idx}
                    htmlFor={unitId}
                    className={cn("checkoff-mobile-unit", unitDone && "checkoff-mobile-unit-done")}
                  >
                    <Checkbox
                      id={unitId}
                      checked={unitDone}
                      onCheckedChange={() => onToggleUnit(part, idx)}
                      disabled={busy}
                    />
                    <span>#{idx + 1}</span>
                  </label>
                );
              })}
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
            <QuantityStepper
              part={part}
              disabled={quantityDisabled}
              onChange={(update) => onQtyChange(part, update)}
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
