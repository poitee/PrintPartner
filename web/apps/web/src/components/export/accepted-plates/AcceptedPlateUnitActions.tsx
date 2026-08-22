import { useEffect, useMemo, useState } from "react";
import type {
  AcceptedPlateId,
  AcceptedPlatePlacedUnit,
  AcceptedPlateUnplacedUnit,
  AcceptedPlateWorkspace,
  RequiredUnitToken,
} from "@print-partner/contracts";
import {
  parseTransferTarget,
  transferTargetValue,
  type TransferTarget,
} from "../../../lib/acceptedPlateTransferTarget";
import { Button } from "../../ui/button";

type ReadyWorkspace = Extract<AcceptedPlateWorkspace, { kind: "ready" }>;

type UnitState =
  | Readonly<{ kind: "placed"; unit: AcceptedPlatePlacedUnit }>
  | Readonly<{ kind: "unplaced"; unit: AcceptedPlateUnplacedUnit }>;

type Props = Readonly<{
  workspace: ReadyWorkspace;
  sourcePlateId: AcceptedPlateId;
  state: UnitState;
  disabled: boolean;
  onPin: (plateId: AcceptedPlateId, token: RequiredUnitToken, pinned: boolean) => Promise<void>;
  onUnplace: (plateId: AcceptedPlateId, token: RequiredUnitToken) => Promise<void>;
  onTransfer: (
    plateId: AcceptedPlateId,
    token: RequiredUnitToken,
    target: TransferTarget,
  ) => Promise<void>;
}>;

type TargetOption = Readonly<{ target: TransferTarget; label: string }>;

function dimensionsFit(
  unit: AcceptedPlatePlacedUnit | AcceptedPlateUnplacedUnit,
  printer: ReadyWorkspace["printers"][number],
): boolean {
  return (
    unit.width_um <= printer.bed_width_um - 2 * printer.margin_um &&
    unit.depth_um <= printer.bed_depth_um - 2 * printer.margin_um &&
    unit.height_um <= printer.bed_height_um
  );
}

export function acceptedPlateTransferOptions(
  workspace: ReadyWorkspace,
  sourcePlateId: AcceptedPlateId,
  unit: AcceptedPlatePlacedUnit | AcceptedPlateUnplacedUnit,
): readonly TargetOption[] {
  const exactPlates = workspace.plates.flatMap((plate): TargetOption[] => (
    plate.plate_id !== sourcePlateId && dimensionsFit(unit, plate.printer)
      ? [{
          target: { kind: "plate", plateId: plate.plate_id },
          label: `Plate ${plate.ordinal} · ${plate.printer.name}`,
        }]
      : []
  ));
  const newPlates = workspace.printers.flatMap((printer): TargetOption[] => (
    dimensionsFit(unit, printer)
      ? [{
          target: { kind: "printer", printerId: printer.id },
          label: `New Plate · ${printer.name}`,
        }]
      : []
  ));
  return [...exactPlates, ...newPlates];
}

export default function AcceptedPlateUnitActions({
  workspace,
  sourcePlateId,
  state,
  disabled,
  onPin,
  onUnplace,
  onTransfer,
}: Props) {
  const options = useMemo(
    () => acceptedPlateTransferOptions(workspace, sourcePlateId, state.unit),
    [sourcePlateId, state.unit, workspace],
  );
  const [targetValue, setTargetValue] = useState(() => options[0]
    ? transferTargetValue(options[0].target)
    : "");

  useEffect(() => {
    if (options.some((option) => transferTargetValue(option.target) === targetValue)) return;
    setTargetValue(options[0] ? transferTargetValue(options[0].target) : "");
  }, [options, targetValue]);

  const transfer = () => {
    const target = parseTransferTarget(targetValue);
    if (!target) return;
    void onTransfer(sourcePlateId, state.unit.token, target);
  };

  return (
    <div className="space-y-2 rounded-md border border-border bg-background p-3">
      {state.kind === "placed" ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {state.unit.placement === "manual" ? "Manually placed" : "Auto-arranged"}
            {state.unit.pinned ? " · Pinned" : ""}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => void onPin(sourcePlateId, state.unit.token, !state.unit.pinned)}
          >
            {state.unit.pinned ? "Unpin" : "Pin"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => void onUnplace(sourcePlateId, state.unit.token)}
          >
            Return to unplaced
          </Button>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs font-medium" htmlFor={`transfer-${state.unit.token}`}>
          Transfer to
        </label>
        <select
          id={`transfer-${state.unit.token}`}
          className="h-9 min-w-52 rounded-md border border-input bg-background px-2 text-sm"
          value={targetValue}
          disabled={disabled || options.length === 0}
          onChange={(event) => setTargetValue(event.target.value)}
        >
          {options.map((option) => (
            <option key={transferTargetValue(option.target)} value={transferTargetValue(option.target)}>
              {option.label}
            </option>
          ))}
        </select>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={disabled || parseTransferTarget(targetValue) === null}
          onClick={transfer}
        >
          Transfer
        </Button>
      </div>
    </div>
  );
}
