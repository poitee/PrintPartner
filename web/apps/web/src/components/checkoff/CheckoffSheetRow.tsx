import type { ReviewPart } from "../../api/endpoints/planManifests";
import PartThumbExpandButton from "../parts/PartThumbExpandButton";
import SpoolRemainingBadge from "../SpoolRemainingBadge";
import { cn } from "@/lib/utils";

export default function CheckoffSheetRow({
  part,
  busy,
  compact,
  eagerThumbs,
  showThumb,
  onToggleUnit,
  onPreview,
}: {
  part: ReviewPart;
  busy: boolean;
  compact: boolean;
  eagerThumbs?: boolean;
  /** Text-only sheets drop the thumbnail entirely — no image fetch, no ink. */
  showThumb: boolean;
  onToggleUnit: (part: ReviewPart, unitIndex: number) => void;
  onPreview: (part: ReviewPart) => void;
}) {
  const done = part.printed_count >= part.quantity_effective && part.quantity_effective > 0;
  return (
    <tr className={cn("sheet-row", done && "sheet-row-done")}>
      <td className="sheet-cell-part">
        <div className="sheet-part">
          {showThumb && (
            <PartThumbExpandButton
              part={part}
              compact={compact}
              eager={eagerThumbs}
              onExpand={onPreview}
            />
          )}
          <div className="sheet-part-meta">
            <span className="sheet-filename" title={part.relative_path || part.filename}>
              {part.filename}
            </span>
            <span className="sheet-part-tags">
              {part.filament_hex && (
                <span className="sheet-swatch" style={{ background: part.filament_hex }} />
              )}
              {part.filament_display && <span>{part.filament_display}</span>}
              <SpoolRemainingBadge part={part} />
              {part.role && <span className="sheet-role">{part.role}</span>}
            </span>
          </div>
        </div>
      </td>
      <td className="sheet-cell-qty sheet-cell-qty-readonly">{part.quantity_effective}</td>
      <td className="sheet-cell-printed">
        <div className="sheet-units">
          {part.print_units.map((unitDone, idx) => (
            <label
              key={idx}
              className={cn("sheet-unit", unitDone && "sheet-unit-done")}
              title={`Unit #${idx + 1}`}
            >
              <input
                type="checkbox"
                checked={unitDone}
                onChange={() => onToggleUnit(part, idx)}
                disabled={busy}
              />
              <span>{idx + 1}</span>
            </label>
          ))}
          <span className={cn("sheet-printed-count", done && "sheet-printed-done")}>
            <span className="sheet-printed-screen">
              {part.printed_count}/{part.quantity_effective}
            </span>
            <span className="sheet-printed-label" aria-hidden>
              {part.printed_count} of {part.quantity_effective}
            </span>
          </span>
        </div>
      </td>
      <td className="sheet-cell-notes">
        <span className="sheet-notes-line" aria-hidden />
      </td>
    </tr>
  );
}
