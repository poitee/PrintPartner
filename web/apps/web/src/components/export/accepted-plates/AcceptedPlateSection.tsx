import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import type {
  AcceptedPlateId,
  AcceptedPlateWorkspace,
  InitializeAcceptedPlatesRequest,
  RequiredUnitToken,
} from "@print-partner/contracts";
import type { TransferTarget } from "../../../lib/acceptedPlateTransferTarget";
import { isAcceptedPlateStaleError } from "../../../api/endpoints/acceptedPlates";
import {
  invalidateAcceptedPlateWorkspace,
  useAcceptedPlateActionMutation,
  useAcceptedPlateRevisionPending,
  useAcceptedPlateWorkspaceQuery,
  useInitializeAcceptedPlatesMutation,
  useMoveAcceptedPlateUnitMutation,
} from "../../../queries/acceptedPlates";
import { useProductionSetup } from "../../../queries/productionSetup";
import { settingsPrintersRoute } from "../../../lib/routes";
import { Button } from "../../ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../ui/card";
import AcceptedPlateAssignmentForm, { type PrinterAssignmentDraft } from "./AcceptedPlateAssignmentForm";
import AcceptedPlateGallery from "./AcceptedPlateGallery";

type Props = Readonly<{
  profileId: number;
  enabled: boolean;
  selectedTokens?: ReadonlySet<string>;
}>;

function assignmentIdentity(
  workspace: Extract<AcceptedPlateWorkspace, { kind: "setup" | "ready" }>,
) {
  const basis = workspace.basis;
  const head = workspace.kind === "ready" ? workspace.plate_revision_id : workspace.expected_plate_revision_id;
  return [
    basis.profile_id,
    basis.plan_revision_id,
    basis.plan_version,
    basis.plan_revision_digest,
    basis.required_unit_mapping_digest,
    head ?? "none",
  ].join(":");
}

function selectionIdentity(selectedTokens: ReadonlySet<string> | undefined): string {
  return selectedTokens == null ? "all" : [...selectedTokens].sort().join(",");
}

export default function AcceptedPlateSection({ profileId, enabled, selectedTokens }: Props) {
  const queryClient = useQueryClient();
  const productionSetup = useProductionSetup(profileId, enabled);
  const query = useAcceptedPlateWorkspaceQuery(profileId, enabled);
  const initialize = useInitializeAcceptedPlatesMutation(profileId);
  const move = useMoveAcceptedPlateUnitMutation(profileId);
  const action = useAcceptedPlateActionMutation(profileId);
  const revisionWritePending = useAcceptedPlateRevisionPending(profileId);
  const [reassigning, setReassigning] = useState(false);
  const workspace = query.data;

  const saveAssignmentDraft = (changes: readonly PrinterAssignmentDraft[]) => {
    const current = productionSetup.data;
    if (!current) return;
    const changedTokens = new Set(changes.map((assignment) => assignment.token));
    const printerAssignments = [
      ...current.printer_assignments.filter((assignment) => !changedTokens.has(assignment.token)),
      ...changes.flatMap((assignment) => assignment.printer_id == null ? [] : [{
        token: assignment.token,
        printer_id: assignment.printer_id,
      }]),
    ];
    void productionSetup.save({
      preferred_slicer_instance_id: current.preferred_slicer_instance_id,
      selection: current.selection,
      printer_assignments: printerAssignments,
      rules: current.rules,
    }).catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : "Could not save printer assignments.");
    });
  };

  const submitAssignments = async (request: InitializeAcceptedPlatesRequest) => {
    try {
      await initialize.mutateAsync(request);
      setReassigning(false);
    } catch (error) {
      if (isAcceptedPlateStaleError(error)) {
        setReassigning(false);
        await invalidateAcceptedPlateWorkspace(queryClient, profileId);
        toast.error("Newer accepted Plate state replaced these assignments.");
        return;
      }
      toast.error(error instanceof Error ? error.message : "Could not arrange accepted Plates.");
    }
  };

  const submitMove = async (plateId: string, token: string, xUm: number, yUm: number) => {
    if (workspace?.kind !== "ready") return;
    try {
      await move.mutateAsync({
        plateId,
        token,
        input: {
          expected: workspace.basis,
          expected_plate_revision_id: workspace.plate_revision_id,
          x_um: xUm,
          y_um: yUm,
        },
      });
      return true;
    } catch (error) {
      if (isAcceptedPlateStaleError(error)) return false;
      toast.error(error instanceof Error ? error.message : "Could not move this Required unit.");
      throw error;
    }
  };

  const refreshAfterStaleMove = async () => {
    await invalidateAcceptedPlateWorkspace(queryClient, profileId);
    toast.error("Newer accepted Plate state replaced this edit.");
  };

  const actionFailure = async (error: unknown, fallback: string) => {
    if (isAcceptedPlateStaleError(error)) {
      await invalidateAcceptedPlateWorkspace(queryClient, profileId);
      toast.error("Newer accepted Plate state replaced this edit.");
      return;
    }
    toast.error(error instanceof Error ? error.message : fallback);
  };

  const submitPin = async (
    plateId: AcceptedPlateId,
    unitToken: RequiredUnitToken,
    pinned: boolean,
  ) => {
    if (workspace?.kind !== "ready") return;
    try {
      await action.mutateAsync({
        kind: "pin",
        plateId,
        token: unitToken,
        input: {
          expected: workspace.basis,
          expected_plate_revision_id: workspace.plate_revision_id,
          pinned,
        },
      });
    } catch (error) {
      await actionFailure(error, "Could not update this pin.");
    }
  };

  const submitUnplace = async (plateId: AcceptedPlateId, unitToken: RequiredUnitToken) => {
    if (workspace?.kind !== "ready") return;
    try {
      await action.mutateAsync({
        kind: "unplace",
        plateId,
        token: unitToken,
        input: {
          expected: workspace.basis,
          expected_plate_revision_id: workspace.plate_revision_id,
        },
      });
    } catch (error) {
      await actionFailure(error, "Could not return this unit to unplaced.");
    }
  };

  const submitTransfer = async (
    plateId: AcceptedPlateId,
    unitToken: RequiredUnitToken,
    target: TransferTarget,
  ) => {
    if (workspace?.kind !== "ready") return;
    const common = {
      expected: workspace.basis,
      expected_plate_revision_id: workspace.plate_revision_id,
    };
    try {
      await action.mutateAsync({
        kind: "transfer",
        plateId,
        token: unitToken,
        input: target.kind === "plate"
          ? { ...common, target_plate_id: target.plateId }
          : { ...common, target_printer_id: target.printerId },
      });
    } catch (error) {
      await actionFailure(error, "Could not transfer this unit.");
    }
  };

  const submitArrange = async (mode: "unplaced" | "all") => {
    if (workspace?.kind !== "ready") return;
    try {
      await action.mutateAsync({
        kind: "arrange",
        input: {
          expected: workspace.basis,
          expected_plate_revision_id: workspace.plate_revision_id,
          mode,
        },
      });
    } catch (error) {
      await actionFailure(error, "Could not arrange accepted Plates.");
    }
  };

  const submitRestore = async (restorePlateRevisionId: number) => {
    if (workspace?.kind !== "ready") return;
    try {
      await action.mutateAsync({
        kind: "restore",
        input: {
          expected: workspace.basis,
          expected_plate_revision_id: workspace.plate_revision_id,
          restore_plate_revision_id: restorePlateRevisionId,
        },
      });
    } catch (error) {
      await actionFailure(error, "Could not undo Arrange all.");
    }
  };

  return (
    <Card className="border-border shadow-sm">
      <CardHeader className="gap-1">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle level={2}>Plates</CardTitle>
            <CardDescription>
              PrintPartner preserves Source orientation. Rotate parts in your slicer.
            </CardDescription>
          </div>
          {workspace?.kind === "ready" && !reassigning ? (
            <Button variant="outline" size="sm" disabled={revisionWritePending} onClick={() => setReassigning(true)}>
              Change printer assignments
            </Button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {query.isPending && !workspace ? <p className="text-sm text-muted-foreground">Loading accepted Plates…</p> : null}
        {query.isError && !workspace ? (
          <div className="space-y-2" role="alert">
            <p className="text-sm text-destructive">Could not load accepted Plates.</p>
            <Button variant="secondary" size="sm" onClick={() => void query.refetch()}>Retry</Button>
          </div>
        ) : null}
        {query.isFetching && workspace ? <p className="text-xs text-muted-foreground">Checking for updates…</p> : null}
        {query.isError && workspace ? (
          <p className="text-sm text-warning" role="alert">
            Could not check for Plate updates. The saved revision remains available.
          </p>
        ) : null}
        {workspace?.kind === "empty_plan" ? (
          <p className="text-sm text-muted-foreground">Apply a Plan with Required units before arranging Plates.</p>
        ) : null}
        {workspace?.kind === "setup" ? (
          <>
            {workspace.printers.length === 0 ? (
              <Link className="text-sm underline" to={settingsPrintersRoute()}>Add a Printer in Settings</Link>
            ) : null}
            <AcceptedPlateAssignmentForm
              rules={productionSetup.data?.rules}
              savedAssignments={productionSetup.data?.printer_assignments}
              key={`${assignmentIdentity(workspace)}:${selectionIdentity(selectedTokens)}`}
              workspace={workspace}
              submitting={initialize.isPending}
              selectedTokens={selectedTokens}
              onSubmit={submitAssignments}
              onAssignmentsChange={saveAssignmentDraft}
            />
          </>
        ) : null}
        {workspace?.kind === "ready" && reassigning ? (
          <AcceptedPlateAssignmentForm
            rules={productionSetup.data?.rules}
            savedAssignments={productionSetup.data?.printer_assignments}
            key={assignmentIdentity(workspace)}
            workspace={workspace}
            submitting={initialize.isPending}
            onSubmit={submitAssignments}
            onAssignmentsChange={saveAssignmentDraft}
            onCancel={() => setReassigning(false)}
          />
        ) : null}
        {workspace?.kind === "ready" && !reassigning && workspace.unassigned.length > 0 ? (
          <AcceptedPlateAssignmentForm
            rules={productionSetup.data?.rules}
            savedAssignments={productionSetup.data?.printer_assignments}
            key={`${assignmentIdentity(workspace)}:unassigned:${selectionIdentity(selectedTokens)}`}
            workspace={workspace}
            submitting={initialize.isPending}
            selectedTokens={new Set(
              workspace.unassigned
                .filter((unit) => selectedTokens == null || selectedTokens.has(unit.token))
                .map((unit) => unit.token),
            )}
            onSubmit={submitAssignments}
            onAssignmentsChange={saveAssignmentDraft}
          />
        ) : null}
        {workspace?.kind === "ready" && !reassigning ? (
          <AcceptedPlateGallery
            workspace={workspace}
            disabled={revisionWritePending}
            onMove={submitMove}
            onStaleMove={refreshAfterStaleMove}
            onPin={submitPin}
            onUnplace={submitUnplace}
            onTransfer={submitTransfer}
            onArrange={submitArrange}
            onRestore={submitRestore}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}
