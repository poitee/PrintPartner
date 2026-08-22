import { useEffect, useState } from "react";
import type {
  AcceptedPlateId,
  AcceptedPlateWorkspace,
  RequiredUnitToken,
} from "@print-partner/contracts";
import type { TransferTarget } from "../../../lib/acceptedPlateTransferTarget";
import { Button } from "../../ui/button";
import AcceptedPlateBed from "./AcceptedPlateBed";
import AcceptedPlateUnitActions from "./AcceptedPlateUnitActions";

type ReadyWorkspace = Extract<AcceptedPlateWorkspace, { kind: "ready" }>;

type Props = Readonly<{
  workspace: ReadyWorkspace;
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
  onArrange: (mode: "unplaced" | "all") => Promise<void>;
  onRestore: (revisionId: number) => Promise<void>;
}>;

export default function AcceptedPlateGallery({
  workspace,
  disabled,
  onMove,
  onStaleMove,
  onPin,
  onUnplace,
  onTransfer,
  onArrange,
  onRestore,
}: Props) {
  const [selectedPlateId, setSelectedPlateId] = useState<string>(workspace.plates[0]?.plate_id ?? "");
  useEffect(() => {
    if (!workspace.plates.some((plate) => plate.plate_id === selectedPlateId)) {
      setSelectedPlateId(workspace.plates[0]?.plate_id ?? "");
    }
  }, [selectedPlateId, workspace.plates]);
  const plate = workspace.plates.find((candidate) => candidate.plate_id === selectedPlateId)
    ?? workspace.plates[0];
  if (!plate) return null;
  const undoRevisionId = workspace.arrange_undo_revision_id;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={disabled}
          onClick={() => void onArrange("unplaced")}
        >
          Arrange unplaced
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => void onArrange("all")}
        >
          Arrange all
        </Button>
        {undoRevisionId !== null ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => void onRestore(undoRevisionId)}
          >
            Undo arrange all
          </Button>
        ) : null}
      </div>
      {workspace.unplaced.length > 0 ? (
        <section className="space-y-2" aria-labelledby="accepted-plate-unplaced-heading">
          <div>
            <h3 id="accepted-plate-unplaced-heading" className="text-sm font-semibold">Unplaced</h3>
            <p className="text-xs text-muted-foreground">
              Arrange these units automatically or transfer them before export.
            </p>
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            {workspace.unplaced.map((unit) => {
              const sourcePlate = workspace.plates.find((candidate) => candidate.plate_id === unit.plate_id);
              return (
                <div key={unit.token} className="space-y-2 rounded-md border border-border p-3">
                  <div>
                    <p className="text-sm font-medium">{unit.object_name}</p>
                    <p className="text-xs text-muted-foreground">
                      {sourcePlate
                        ? `Plate ${sourcePlate.ordinal} · ${sourcePlate.printer.name}`
                        : unit.printer_id}
                    </p>
                  </div>
                  <AcceptedPlateUnitActions
                    workspace={workspace}
                    sourcePlateId={unit.plate_id}
                    state={{ kind: "unplaced", unit }}
                    disabled={disabled}
                    onPin={onPin}
                    onUnplace={onUnplace}
                    onTransfer={onTransfer}
                  />
                </div>
              );
            })}
          </div>
        </section>
      ) : null}
      <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Plates">
        {workspace.plates.map((candidate) => (
          <Button
            key={candidate.plate_id}
            size="sm"
            variant={candidate.plate_id === plate.plate_id ? "default" : "outline"}
            role="tab"
            aria-selected={candidate.plate_id === plate.plate_id}
            disabled={disabled}
            className="shrink-0"
            onClick={() => setSelectedPlateId(candidate.plate_id)}
          >
            Plate {candidate.ordinal} · {candidate.printer.name}
          </Button>
        ))}
      </div>
      <AcceptedPlateBed
        key={plate.plate_id}
        plate={plate}
        workspace={workspace}
        revisionId={workspace.plate_revision_id}
        disabled={disabled}
        onMove={onMove}
        onStaleMove={onStaleMove}
        onPin={onPin}
        onUnplace={onUnplace}
        onTransfer={onTransfer}
      />
    </div>
  );
}
