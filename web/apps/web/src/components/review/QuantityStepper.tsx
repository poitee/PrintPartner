import { useId, useState } from "react";
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
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const errorId = useId();
  const parsed = draft === null || draft.trim() === "" ? null : Number(draft);
  const typedQuantity =
    parsed !== null && Number.isInteger(parsed) && parsed >= 1 && parsed <= 10_000
      ? parsed
      : null;
  const stepQuantity = typedQuantity ?? quantity;
  const belowPrinted = part.printed_count > quantity;

  function commit() {
    if (disabled || draft === null) return;
    if (typedQuantity === null) {
      setInvalid(true);
      return;
    }
    setDraft(null);
    setInvalid(false);
    if (typedQuantity !== quantity) onChange(typedQuantity);
  }

  function step(delta: number) {
    setDraft(null);
    setInvalid(false);
    const boundedStep = (current: number) =>
      Math.min(10_000, Math.max(1, current + delta));
    onChange(typedQuantity === null ? boundedStep : boundedStep(typedQuantity));
  }

  return (
    <div className="qty-control flex flex-col items-start gap-0.5">
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="qty-btn"
          disabled={disabled || stepQuantity <= 1}
          onPointerDown={(event) => {
            if (draft !== null) event.preventDefault();
          }}
          onClick={() => step(-1)}
          aria-label={`Decrease quantity for ${part.filename}`}
        >
          −
        </button>
        <input
          type="number"
          className="qty-input"
          min={1}
          max={10_000}
          step={1}
          inputMode="numeric"
          value={draft ?? quantity}
          disabled={disabled}
          onChange={(event) => {
            setDraft(event.target.value);
            setInvalid(false);
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setDraft(null);
              setInvalid(false);
            }
          }}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : undefined}
          aria-label={`Quantity for ${part.filename}`}
        />
        <button
          type="button"
          className="qty-btn"
          disabled={disabled || stepQuantity >= 10_000}
          onPointerDown={(event) => {
            if (draft !== null) event.preventDefault();
          }}
          onClick={() => step(1)}
          aria-label={`Increase quantity for ${part.filename}`}
        >
          +
        </button>
      </div>
      {invalid && (
        <span id={errorId} role="alert" className="text-xs text-destructive">
          Enter a whole number from 1 to 10,000.
        </span>
      )}
      {belowPrinted && (
        <span className="text-xs text-warning">
          {part.printed_count} unit{part.printed_count === 1 ? "" : "s"} already printed
        </span>
      )}
    </div>
  );
}
