import { useEffect, useState, type PointerEvent } from "react";
import type {
  AcceptedPlateId,
  AcceptedPlatePlacedUnit,
  AcceptedPlateView,
  AcceptedPlateWorkspace,
  RequiredUnitToken,
} from "@print-partner/contracts";
import type { TransferTarget } from "../../../lib/acceptedPlateTransferTarget";
import {
  pointerToAcceptedPlateOrigin,
  screenToAcceptedPlatePoint,
} from "../../../lib/acceptedPlateCoordinates";
import AcceptedPlatePositionEditor from "./AcceptedPlatePositionEditor";
import AcceptedPlateUnitActions from "./AcceptedPlateUnitActions";

type ReadyWorkspace = Extract<AcceptedPlateWorkspace, { kind: "ready" }>;

type PositionDraft =
  | { readonly kind: "idle" }
  | {
      readonly kind: "dragging";
      readonly pointerId: number;
      readonly token: RequiredUnitToken;
      readonly plateId: AcceptedPlateId;
      readonly xUm: number;
      readonly yUm: number;
      readonly grabOffsetXUm: number;
      readonly grabOffsetYUm: number;
    }
  | {
      readonly kind: "submitting";
      readonly token: RequiredUnitToken;
      readonly plateId: AcceptedPlateId;
      readonly xUm: number;
      readonly yUm: number;
    };

type Props = Readonly<{
  plate: AcceptedPlateView;
  workspace: ReadyWorkspace;
  revisionId: number;
  disabled: boolean;
  onMove: (plateId: string, token: string, xUm: number, yUm: number) => Promise<boolean | undefined>;
  onStaleMove: () => Promise<void>;
  onPin: (plateId: AcceptedPlateId, token: RequiredUnitToken, pinned: boolean) => Promise<void>;
  onUnplace: (plateId: AcceptedPlateId, token: RequiredUnitToken) => Promise<void>;
  onTransfer: (
    plateId: AcceptedPlateId,
    token: RequiredUnitToken,
    target: TransferTarget,
  ) => Promise<void>;
}>;

function matrixOf(svg: SVGSVGElement) {
  const matrix = svg.getScreenCTM();
  return matrix ? {
    a: matrix.a,
    b: matrix.b,
    c: matrix.c,
    d: matrix.d,
    e: matrix.e,
    f: matrix.f,
  } : null;
}

function displayedUnit(unit: AcceptedPlatePlacedUnit, draft: PositionDraft) {
  if (draft.kind === "idle" || draft.token !== unit.token) return unit;
  return { ...unit, x_um: draft.xUm, y_um: draft.yUm };
}

export default function AcceptedPlateBed({
  plate,
  workspace,
  revisionId,
  disabled,
  onMove,
  onStaleMove,
  onPin,
  onUnplace,
  onTransfer,
}: Props) {
  const [selectedToken, setSelectedToken] = useState<RequiredUnitToken | null>(plate.units[0]?.token ?? null);
  const [draft, setDraft] = useState<PositionDraft>({ kind: "idle" });
  const selected = plate.units.find((unit) => unit.token === selectedToken) ?? plate.units[0];

  useEffect(() => {
    setDraft({ kind: "idle" });
  }, [revisionId]);

  useEffect(() => {
    if (plate.units.some((unit) => unit.token === selectedToken)) return;
    setSelectedToken(plate.units[0]?.token ?? null);
  }, [plate.units, selectedToken]);

  const origin = (
    event: PointerEvent<SVGRectElement>,
    unit: AcceptedPlatePlacedUnit,
    grabOffsetXUm: number,
    grabOffsetYUm: number,
  ) => {
    const svg = event.currentTarget.ownerSVGElement;
    if (!svg) return null;
    const matrix = matrixOf(svg);
    if (!matrix) return null;
    return pointerToAcceptedPlateOrigin({
      clientX: event.clientX,
      clientY: event.clientY,
      screenTransform: matrix,
      grabOffsetXUm,
      grabOffsetYUm,
      bedWidthUm: plate.printer.bed_width_um,
      bedDepthUm: plate.printer.bed_depth_um,
      marginUm: plate.printer.margin_um,
      unitWidthUm: unit.width_um,
      unitDepthUm: unit.depth_um,
    });
  };

  const pointerDown = (event: PointerEvent<SVGRectElement>, unit: AcceptedPlatePlacedUnit) => {
    if (disabled) return;
    const svg = event.currentTarget.ownerSVGElement;
    if (!svg) return;
    const matrix = matrixOf(svg);
    if (!matrix) return;
    const point = screenToAcceptedPlatePoint({
      clientX: event.clientX,
      clientY: event.clientY,
      screenTransform: matrix,
    });
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelectedToken(unit.token);
    setDraft({
      kind: "dragging",
      pointerId: event.pointerId,
      token: unit.token,
      plateId: plate.plate_id,
      xUm: unit.x_um,
      yUm: unit.y_um,
      grabOffsetXUm: point.xUm - unit.x_um,
      grabOffsetYUm: point.yUm - unit.y_um,
    });
  };

  const pointerMove = (event: PointerEvent<SVGRectElement>, unit: AcceptedPlatePlacedUnit) => {
    if (draft.kind !== "dragging" || draft.pointerId !== event.pointerId || draft.token !== unit.token) return;
    const next = origin(event, unit, draft.grabOffsetXUm, draft.grabOffsetYUm);
    if (!next) return;
    setDraft({ ...draft, ...next });
  };

  const pointerUp = async (event: PointerEvent<SVGRectElement>, unit: AcceptedPlatePlacedUnit) => {
    if (draft.kind !== "dragging" || draft.pointerId !== event.pointerId || draft.token !== unit.token) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    const released = origin(event, unit, draft.grabOffsetXUm, draft.grabOffsetYUm);
    const xUm = released?.xUm ?? draft.xUm;
    const yUm = released?.yUm ?? draft.yUm;
    if (xUm === unit.x_um && yUm === unit.y_um) {
      setDraft({ kind: "idle" });
      return;
    }
    const submitted: PositionDraft = {
      kind: "submitting",
      token: draft.token,
      plateId: draft.plateId,
      xUm,
      yUm,
    };
    setDraft(submitted);
    try {
      const saved = await onMove(plate.plate_id, unit.token, submitted.xUm, submitted.yUm);
      if (saved === false) {
        setDraft({ kind: "idle" });
        await onStaleMove();
      }
    } catch {
      return;
    } finally {
      setDraft({ kind: "idle" });
    }
  };

  return (
    <div className="space-y-3">
      <svg
        className="max-h-[34rem] w-full rounded-md border border-border bg-muted/30"
        viewBox={`0 0 ${plate.printer.bed_width_um} ${plate.printer.bed_depth_um}`}
        aria-label={`Plate ${plate.ordinal} layout`}
      >
        <rect
          x={plate.printer.margin_um}
          y={plate.printer.margin_um}
          width={plate.printer.bed_width_um - plate.printer.margin_um * 2}
          height={plate.printer.bed_depth_um - plate.printer.margin_um * 2}
          fill="none"
          stroke="currentColor"
          strokeWidth={Math.max(500, plate.printer.bed_width_um / 500)}
          opacity="0.35"
        />
        {plate.units.map((unit) => {
          const displayed = displayedUnit(unit, draft);
          const selectedUnit = unit.token === selected?.token;
          return (
            <rect
              key={unit.token}
              x={displayed.x_um}
              y={displayed.y_um}
              width={unit.width_um}
              height={unit.depth_um}
              rx={1_000}
              className="cursor-grab fill-primary/35 stroke-primary active:cursor-grabbing"
              strokeWidth={selectedUnit ? 1_500 : 750}
              role="button"
              tabIndex={0}
              aria-label={unit.object_name}
              onFocus={() => setSelectedToken(unit.token)}
              onPointerDown={(event) => pointerDown(event, unit)}
              onPointerMove={(event) => pointerMove(event, unit)}
              onPointerUp={(event) => void pointerUp(event, unit)}
              onPointerCancel={() => setDraft({ kind: "idle" })}
            />
          );
        })}
      </svg>
      {selected ? (
        <div className="space-y-3">
          <AcceptedPlatePositionEditor
            key={`${plate.plate_id}:${selected.token}`}
            unit={displayedUnit(selected, draft)}
            printer={plate.printer}
            disabled={disabled || draft.kind !== "idle"}
            onMove={(xUm, yUm) => onMove(plate.plate_id, selected.token, xUm, yUm)}
            onStaleMove={onStaleMove}
          />
          <AcceptedPlateUnitActions
            workspace={workspace}
            sourcePlateId={plate.plate_id}
            state={{ kind: "placed", unit: selected }}
            disabled={disabled || draft.kind !== "idle"}
            onPin={onPin}
            onUnplace={onUnplace}
            onTransfer={onTransfer}
          />
        </div>
      ) : null}
    </div>
  );
}
