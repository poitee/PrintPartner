import type { ReviewPart } from "../../api/endpoints/planManifests";
import type { QuantityUpdate } from "../../context/PlanWorkspaceContext";

type QuantityStepperProps = {
  part: ReviewPart;
  disabled?: boolean;
  onChange: (update: QuantityUpdate) => void;
};

export default function QuantityStepper({
  part,
  disabled,
  onChange,
}: QuantityStepperProps) {
  const quantity = part.quantity_override ?? part.quantity_effective;
  const belowPrinted = part.printed_count > quantity;

  return (
    <div className="qty-control flex flex-col items-start gap-0.5">
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="qty-btn"
          disabled={disabled || quantity <= 1}
          onClick={() => onChange((current) => current - 1)}
          aria-label={`Decrease quantity for ${part.filename}`}
        >
          −
        </button>
        <input
          type="number"
          className="qty-input"
          min={1}
          value={quantity}
          disabled={disabled}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (Number.isFinite(next)) onChange(next);
          }}
          aria-label={`Quantity for ${part.filename}`}
        />
        <button
          type="button"
          className="qty-btn"
          disabled={disabled}
          onClick={() => onChange((current) => current + 1)}
          aria-label={`Increase quantity for ${part.filename}`}
        >
          +
        </button>
      </div>
      {belowPrinted && (
        <span className="text-xs text-warning">
          {part.printed_count} unit{part.printed_count === 1 ? "" : "s"} already printed
        </span>
      )}
    </div>
  );
}
