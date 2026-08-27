import { useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import type {
  AcceptedPlateId,
  AcceptedPlateWorkspace,
  InitializeAcceptedPlatesRequest,
  RequiredUnitToken,
} from "@print-partner/contracts";
import type { TransferTarget } from "../../../lib/acceptedPlateTransferTarget";
import {
  acceptedPlateErrorCode,
  isAcceptedPlateStaleError,
} from "../../../api/endpoints/acceptedPlates";
import {
  invalidateAcceptedPlateWorkspace,
  useAcceptedPlateActionMutation,
  type AcceptedPlateActionVariables,
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

/** A recoverable Plate operation that failed. Retry reruns only that operation. */
export type PlateOperationFailure = Readonly<{ message: string; retry: () => void }>;

/**
 * Plain words for the Plate errors an operator can actually act on. WCAG asks
 * for the problem described in text, not a status code.
 */
function plateErrorMessage(error: unknown): string | null {
  switch (acceptedPlateErrorCode(error)) {
    case "untracked_source":
    case "missing":
    case "not_file":
      return "The STL files for these units are not on disk yet. Sync the Source on the Sources workspace, then try again.";
    case "outside_snapshot":
    case "changed":
      return "A Source file changed since the Plan was accepted. Sync the Source, then try again.";
    case "unassigned_units":
    case "missing_assignment":
      return "Every chosen unit needs a printer before PrintPartner can save a Plate revision.";
    case "unit_too_large":
    case "oversized":
      return "A unit does not fit the printable area of the printer you chose. Pick a larger printer.";
    case "outside_build_area":
      return "That position sits outside the printable area.";
    case "overlapping_units":
      return "Two units overlap on the same Plate. Move one of them, then try again.";
    case "printer_not_found":
    case "missing_printer_geometry":
      return "That printer is missing its bed size. Check it in Settings, then try again.";
    case "invalid_stl":
    case "degenerate_geometry":
      return "PrintPartner could not read the geometry of one of these STL files.";
    case "plan_archived":
      return "This Plan revision is archived. Accept a current Plan revision first.";
    case "accepted_artifact_unavailable":
    case "accepted_state_unavailable":
      return "A verified copy of the accepted files is unavailable. Sync the Source, then try again.";
    default:
      return null;
  }
}

type Props = Readonly<{
  profileId: number;
  enabled: boolean;
  selectedTokens?: ReadonlySet<string>;
  /**
   * Which half of the Plate work to show. Production splits printer assignment
   * and Plate arrangement into two resumable tasks. Leave unset to show both.
   */
  view?: "assign" | "arrange";
  /**
   * Reports the current recoverable failure so the Production task list can
   * show it beside the task that needs repair.
   */
  onFailure?: (failure: PlateOperationFailure | null) => void;
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

export default function AcceptedPlateSection({
  profileId,
  enabled,
  selectedTokens,
  view,
  onFailure,
}: Props) {
  const queryClient = useQueryClient();
  const productionSetup = useProductionSetup(profileId, enabled);
  const query = useAcceptedPlateWorkspaceQuery(profileId, enabled);
  const initialize = useInitializeAcceptedPlatesMutation(profileId);
  const move = useMoveAcceptedPlateUnitMutation(profileId);
  const action = useAcceptedPlateActionMutation(profileId);
  const revisionWritePending = useAcceptedPlateRevisionPending(profileId);
  const [reassigning, setReassigning] = useState(false);
  const [failure, setFailureState] = useState<PlateOperationFailure | null>(null);
  const workspace = query.data;
  const showAssign = view !== "arrange";
  const showArrange = view !== "assign";

  /**
   * A Plate conflict is recoverable, so it stays on the page next to the work it
   * broke instead of disappearing with a toast. Retry reruns the same operation
   * with the same arguments, so the user keeps their selection.
   */
  const setFailure = (next: PlateOperationFailure | null) => {
    setFailureState(next);
    onFailure?.(next);
  };

  const failureMessage = (error: unknown, fallback: string): string => {
    if (isAcceptedPlateStaleError(error)) {
      return "Newer accepted Plate state replaced this edit. Check the Plate below, then try again.";
    }
    const known = plateErrorMessage(error);
    if (known) return `${fallback} ${known}`;
    return error instanceof Error ? error.message : fallback;
  };

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
      setFailure({
        message: failureMessage(error, "Could not save printer assignments."),
        retry: () => saveAssignmentDraft(changes),
      });
    });
  };

  const submitAssignments = async (request: InitializeAcceptedPlatesRequest) => {
    try {
      await initialize.mutateAsync(request);
      setReassigning(false);
      setFailure(null);
    } catch (error) {
      if (isAcceptedPlateStaleError(error)) {
        await invalidateAcceptedPlateWorkspace(queryClient, profileId);
      }
      setFailure({
        message: failureMessage(error, "Could not arrange accepted Plates."),
        retry: () => void submitAssignments(request),
      });
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
      setFailure(null);
      return true;
    } catch (error) {
      setFailure({
        message: failureMessage(error, "Could not move this Required unit."),
        retry: () => void submitMove(plateId, token, xUm, yUm),
      });
      if (isAcceptedPlateStaleError(error)) return false;
      throw error;
    }
  };

  const refreshAfterStaleMove = async () => {
    await invalidateAcceptedPlateWorkspace(queryClient, profileId);
  };

  const runAction = async (
    variables: AcceptedPlateActionVariables,
    fallback: string,
    retry: () => void,
  ) => {
    try {
      await action.mutateAsync(variables);
      setFailure(null);
    } catch (error) {
      if (isAcceptedPlateStaleError(error)) {
        await invalidateAcceptedPlateWorkspace(queryClient, profileId);
      }
      setFailure({ message: failureMessage(error, fallback), retry });
    }
  };

  const submitPin = async (
    plateId: AcceptedPlateId,
    unitToken: RequiredUnitToken,
    pinned: boolean,
  ) => {
    if (workspace?.kind !== "ready") return;
    await runAction(
      {
        kind: "pin",
        plateId,
        token: unitToken,
        input: {
          expected: workspace.basis,
          expected_plate_revision_id: workspace.plate_revision_id,
          pinned,
        },
      },
      "Could not update this pin.",
      () => void submitPin(plateId, unitToken, pinned),
    );
  };

  const submitUnplace = async (plateId: AcceptedPlateId, unitToken: RequiredUnitToken) => {
    if (workspace?.kind !== "ready") return;
    await runAction(
      {
        kind: "unplace",
        plateId,
        token: unitToken,
        input: {
          expected: workspace.basis,
          expected_plate_revision_id: workspace.plate_revision_id,
        },
      },
      "Could not return this unit to unplaced.",
      () => void submitUnplace(plateId, unitToken),
    );
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
    await runAction(
      {
        kind: "transfer",
        plateId,
        token: unitToken,
        input: target.kind === "plate"
          ? { ...common, target_plate_id: target.plateId }
          : { ...common, target_printer_id: target.printerId },
      },
      "Could not transfer this unit.",
      () => void submitTransfer(plateId, unitToken, target),
    );
  };

  const submitArrange = async (mode: "unplaced" | "all") => {
    if (workspace?.kind !== "ready") return;
    await runAction(
      {
        kind: "arrange",
        input: {
          expected: workspace.basis,
          expected_plate_revision_id: workspace.plate_revision_id,
          mode,
        },
      },
      "Could not arrange accepted Plates.",
      () => void submitArrange(mode),
    );
  };

  const submitRestore = async (restorePlateRevisionId: number) => {
    if (workspace?.kind !== "ready") return;
    await runAction(
      {
        kind: "restore",
        input: {
          expected: workspace.basis,
          expected_plate_revision_id: workspace.plate_revision_id,
          restore_plate_revision_id: restorePlateRevisionId,
        },
      },
      "Could not undo Arrange all.",
      () => void submitRestore(restorePlateRevisionId),
    );
  };

  return (
    <Card className="border-border shadow-sm">
      <CardHeader className="gap-1">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle level={2}>{view === "assign" ? "Printer assignments" : "Plates"}</CardTitle>
            <CardDescription>
              {view === "assign"
                ? "Give every chosen Required unit a printer. PrintPartner then saves a Plate revision."
                : "PrintPartner preserves Source orientation. Rotate parts in your slicer."}
            </CardDescription>
          </div>
          {showAssign && workspace?.kind === "ready" && !reassigning ? (
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
        {query.isFetching && workspace ? (
          <p className="text-xs text-muted-foreground" role="status">Checking for updates…</p>
        ) : null}
        {query.isError && workspace ? (
          <p className="text-sm text-warning" role="status">
            Could not check for Plate updates. The saved revision remains available.
          </p>
        ) : null}
        {failure ? (
          <div
            className="flex flex-wrap items-center gap-3 rounded-md border border-destructive/35 bg-destructive-soft px-3 py-2"
            role="alert"
          >
            <p className="min-w-0 flex-1 text-sm text-destructive">{failure.message}</p>
            <Button
              size="sm"
              variant="secondary"
              className="min-h-9"
              onClick={() => {
                const retry = failure.retry;
                setFailure(null);
                retry();
              }}
            >
              Retry
            </Button>
            <Button size="sm" variant="ghost" className="min-h-9" onClick={() => setFailure(null)}>
              Dismiss
            </Button>
          </div>
        ) : null}
        {workspace?.kind === "empty_plan" ? (
          <p className="text-sm text-muted-foreground">Apply a Plan with Required units before arranging Plates.</p>
        ) : null}
        {showAssign && workspace?.kind === "setup" ? (
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
        {showAssign && workspace?.kind === "ready" && reassigning ? (
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
        {showAssign && workspace?.kind === "ready" && !reassigning && workspace.unassigned.length > 0 ? (
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
        {view === "assign" && workspace?.kind === "ready" && !reassigning && workspace.unassigned.length === 0 ? (
          <ul className="space-y-1 text-sm text-muted-foreground">
            {workspace.plates.map((plate) => (
              <li key={plate.plate_id}>
                Plate {plate.ordinal} · {plate.printer.name} · {plate.units.length}{" "}
                {plate.units.length === 1 ? "unit" : "units"}
              </li>
            ))}
          </ul>
        ) : null}
        {showArrange && workspace?.kind === "ready" && !reassigning ? (
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
