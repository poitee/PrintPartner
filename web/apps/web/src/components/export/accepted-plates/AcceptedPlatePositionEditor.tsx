import { useEffect, useRef, useState } from "react";
import type { AcceptedPlatePlacedUnit, AcceptedPlatePrinter } from "@print-partner/contracts";
import {
  acceptedPlatePositionInBounds,
  parseMillimetresToMicrometres,
} from "../../../lib/acceptedPlateCoordinates";
import { Button } from "../../ui/button";

type Props = Readonly<{
  unit: AcceptedPlatePlacedUnit;
  printer: AcceptedPlatePrinter;
  disabled: boolean;
  onMove: (xUm: number, yUm: number) => Promise<boolean | undefined>;
  onStaleMove: () => Promise<void>;
}>;

function millimetresText(value: number): string {
  const whole = Math.trunc(value / 1_000);
  const fraction = String(value % 1_000).padStart(3, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

export default function AcceptedPlatePositionEditor({ unit, printer, disabled, onMove, onStaleMove }: Props) {
  const [xText, setXText] = useState(() => millimetresText(unit.x_um));
  const [yText, setYText] = useState(() => millimetresText(unit.y_um));
  const [submitting, setSubmitting] = useState(false);
  const [focusAfterRecovery, setFocusAfterRecovery] = useState(false);
  const xRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setXText(millimetresText(unit.x_um));
    setYText(millimetresText(unit.y_um));
  }, [unit.token, unit.x_um, unit.y_um]);

  useEffect(() => {
    if (!focusAfterRecovery || submitting) return;
    xRef.current?.focus();
    setFocusAfterRecovery(false);
  }, [focusAfterRecovery, submitting]);

  const xUm = parseMillimetresToMicrometres(xText);
  const yUm = parseMillimetresToMicrometres(yText);
  const valid = xUm != null && yUm != null && acceptedPlatePositionInBounds({
    xUm,
    yUm,
    bedWidthUm: printer.bed_width_um,
    bedDepthUm: printer.bed_depth_um,
    marginUm: printer.margin_um,
    unitWidthUm: unit.width_um,
    unitDepthUm: unit.depth_um,
  });
  const changed = xUm !== unit.x_um || yUm !== unit.y_um;

  const save = async () => {
    if (!valid || xUm == null || yUm == null || !changed) return;
    setSubmitting(true);
    try {
      const saved = await onMove(xUm, yUm);
      if (saved === false) {
        setXText(millimetresText(unit.x_um));
        setYText(millimetresText(unit.y_um));
        setFocusAfterRecovery(true);
        await onStaleMove();
      }
    } catch {
      setXText(millimetresText(unit.x_um));
      setYText(millimetresText(unit.y_um));
      setFocusAfterRecovery(true);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      className="grid gap-3 rounded-md border border-border bg-muted/30 p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
      aria-label="Exact Plate position"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label className="grid gap-1 text-xs font-medium">
        X position (mm)
        <input
          ref={xRef}
          className="h-9 rounded-md border border-border bg-background px-2 text-sm"
          inputMode="decimal"
          value={xText}
          disabled={disabled || submitting}
          onChange={(event) => setXText(event.target.value)}
        />
      </label>
      <label className="grid gap-1 text-xs font-medium">
        Y position (mm)
        <input
          className="h-9 rounded-md border border-border bg-background px-2 text-sm"
          inputMode="decimal"
          value={yText}
          disabled={disabled || submitting}
          onChange={(event) => setYText(event.target.value)}
        />
      </label>
      <Button type="submit" size="sm" disabled={disabled || submitting || !valid || !changed} loading={submitting}>
        Save position
      </Button>
    </form>
  );
}
