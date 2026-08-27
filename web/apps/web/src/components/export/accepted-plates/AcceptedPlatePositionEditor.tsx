import { useEffect, useRef, useState } from "react";
import type { AcceptedPlatePlacedUnit, AcceptedPlatePrinter } from "@print-partner/contracts";
import {
  acceptedPlatePositionInBounds,
  nudgeAcceptedPlatePosition,
  parseMillimetresToMicrometres,
} from "../../../lib/acceptedPlateCoordinates";
import { Button } from "../../ui/button";

const STEP_CHOICES = [1, 5, 10, 25] as const;

type StepChoice = (typeof STEP_CHOICES)[number];

const MOVES = [
  { id: "left", label: "Move left", symbol: "←", dx: -1, dy: 0 },
  { id: "right", label: "Move right", symbol: "→", dx: 1, dy: 0 },
  { id: "back", label: "Move back", symbol: "↑", dx: 0, dy: -1 },
  { id: "forward", label: "Move forward", symbol: "↓", dx: 0, dy: 1 },
] as const;

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
  const [stepMm, setStepMm] = useState<StepChoice>(5);
  const [moveNote, setMoveNote] = useState("");
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

  /**
   * Single-pointer alternative to dragging on the bed (WCAG 2.2 dragging
   * movements). Each step saves the same move the drag would have saved.
   */
  const step = async (deltaXMm: number, deltaYMm: number, label: string) => {
    const next = nudgeAcceptedPlatePosition({
      xUm: unit.x_um,
      yUm: unit.y_um,
      deltaXUm: deltaXMm * 1_000,
      deltaYUm: deltaYMm * 1_000,
      bedWidthUm: printer.bed_width_um,
      bedDepthUm: printer.bed_depth_um,
      marginUm: printer.margin_um,
      unitWidthUm: unit.width_um,
      unitDepthUm: unit.depth_um,
    });
    if (!next) {
      setMoveNote("This unit does not fit the printable area.");
      return;
    }
    if (next.xUm === unit.x_um && next.yUm === unit.y_um) {
      setMoveNote(`${label} stopped at the edge of the printable area.`);
      return;
    }
    setSubmitting(true);
    try {
      const saved = await onMove(next.xUm, next.yUm);
      if (saved === false) {
        setFocusAfterRecovery(true);
        await onStaleMove();
        return;
      }
      setMoveNote(`${label} by ${stepMm} mm.`);
    } catch {
      setFocusAfterRecovery(true);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-2">
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 p-3">
      <span className="text-xs font-medium">Move without dragging</span>
      <label className="flex items-center gap-1 text-xs text-muted-foreground">
        Step
        <select
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          value={stepMm}
          disabled={disabled || submitting}
          aria-label="Move step in millimetres"
          onChange={(event) => setStepMm(Number(event.target.value) as StepChoice)}
        >
          {STEP_CHOICES.map((choice) => (
            <option key={choice} value={choice}>{choice} mm</option>
          ))}
        </select>
      </label>
      <div className="flex flex-wrap gap-1">
        {MOVES.map((move) => (
          <Button
            key={move.id}
            type="button"
            size="sm"
            variant="outline"
            className="min-h-11 min-w-11"
            disabled={disabled || submitting}
            aria-label={`${move.label} ${stepMm} millimetres`}
            onClick={() => void step(move.dx * stepMm, move.dy * stepMm, move.label)}
          >
            <span aria-hidden>{move.symbol}</span>
          </Button>
        ))}
      </div>
      <p className="w-full text-xs text-muted-foreground" role="status">
        {moveNote || `${unit.object_name.split("__")[0]} sits at X ${millimetresText(unit.x_um)} mm, Y ${millimetresText(unit.y_um)} mm.`}
      </p>
    </div>
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
      <Button
        type="submit"
        size="sm"
        className="min-h-11"
        disabled={disabled || submitting || !valid || !changed}
        loading={submitting}
      >
        Save position
      </Button>
    </form>
    </div>
  );
}
