import {
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import type {
  AcceptedPlanBasisContract,
  AcceptedPlateId,
  AcceptedPlateExportRecord,
  AcceptedPlateMoveReceipt,
  AcceptedPlateWorkspace,
  ArrangeAcceptedPlatesRequest,
  InitializeAcceptedPlatesRequest,
  MoveAcceptedPlateUnitRequest,
  PinAcceptedPlateUnitRequest,
  RequiredUnitToken,
  RestoreAcceptedPlatesRequest,
  TransferAcceptedPlateUnitRequest,
  UnplaceAcceptedPlateUnitRequest,
} from "@print-partner/contracts";
import {
  arrangeAcceptedPlates,
  fetchAcceptedPlateExportJobs,
  fetchAcceptedPlateWorkspace,
  initializeAcceptedPlates,
  moveAcceptedPlateUnit,
  pinAcceptedPlateUnit,
  restoreAcceptedPlates,
  transferAcceptedPlateUnit,
  unplaceAcceptedPlateUnit,
} from "../api/endpoints/acceptedPlates";
import { queryKeys } from "./keys";

export type AcceptedPlateCapability =
  | {
      readonly kind: "blocked";
      readonly reason:
        | "disabled"
        | "loading"
        | "load_failed"
        | "empty_plan"
        | "needs_arrangement"
        | "unplaced_units"
        | "revision_write_pending";
    }
  | {
      readonly kind: "ready";
      readonly profileId: number;
      readonly basis: AcceptedPlanBasisContract;
      readonly plateRevisionId: number;
      readonly plateRevisionNumber: number;
    };

type CapabilityInput = Readonly<{
  enabled: boolean;
  profileId: number | null;
  workspace: AcceptedPlateWorkspace | undefined;
  isPending: boolean;
  isError: boolean;
  revisionWritePending: boolean;
}>;

export type AcceptedPlateMoveVariables = Readonly<{
  plateId: string;
  token: string;
  input: MoveAcceptedPlateUnitRequest;
}>;

export type AcceptedPlateActionVariables =
  | Readonly<{
      kind: "pin";
      plateId: AcceptedPlateId;
      token: RequiredUnitToken;
      input: PinAcceptedPlateUnitRequest;
    }>
  | Readonly<{
      kind: "unplace";
      plateId: AcceptedPlateId;
      token: RequiredUnitToken;
      input: UnplaceAcceptedPlateUnitRequest;
    }>
  | Readonly<{
      kind: "transfer";
      plateId: AcceptedPlateId;
      token: RequiredUnitToken;
      input: TransferAcceptedPlateUnitRequest;
    }>
  | Readonly<{ kind: "arrange"; input: ArrangeAcceptedPlatesRequest }>
  | Readonly<{ kind: "restore"; input: RestoreAcceptedPlatesRequest }>;

type AcceptedPlateActionResult =
  | Readonly<{ kind: "receipt"; receipt: AcceptedPlateMoveReceipt }>
  | Readonly<{ kind: "workspace"; workspace: AcceptedPlateWorkspace }>;

export function acceptedPlateMutationKey(profileId: number) {
  return ["acceptedPlateRevision", profileId] as const;
}

export function acceptedPlateMutationScope(profileId: number) {
  return { id: `accepted-plate-revision:${profileId}` };
}

export function acceptedPlateCapability(input: CapabilityInput): AcceptedPlateCapability {
  if (!input.enabled || input.profileId == null || input.profileId <= 0) {
    return { kind: "blocked", reason: "disabled" };
  }
  if (input.revisionWritePending) return { kind: "blocked", reason: "revision_write_pending" };
  if (input.workspace?.kind === "ready") {
    if (input.workspace.unplaced.length > 0) return { kind: "blocked", reason: "unplaced_units" };
    return {
      kind: "ready",
      profileId: input.profileId,
      basis: input.workspace.basis,
      plateRevisionId: input.workspace.plate_revision_id,
      plateRevisionNumber: input.workspace.plate_revision_number,
    };
  }
  if (input.workspace?.kind === "empty_plan") return { kind: "blocked", reason: "empty_plan" };
  if (input.workspace?.kind === "setup") return { kind: "blocked", reason: "needs_arrangement" };
  if (input.isPending) return { kind: "blocked", reason: "loading" };
  if (input.isError) return { kind: "blocked", reason: "load_failed" };
  return { kind: "blocked", reason: "loading" };
}

export function publishAcceptedPlateMove(
  workspace: AcceptedPlateWorkspace | undefined,
  variables: AcceptedPlateMoveVariables,
  receipt: AcceptedPlateMoveReceipt,
): AcceptedPlateWorkspace | undefined {
  if (workspace?.kind !== "ready") return workspace;
  return {
    ...workspace,
    plate_revision_id: receipt.plate_revision_id,
    plate_revision_number: receipt.plate_revision_number,
    arrange_undo_revision_id: null,
    plates: workspace.plates.map((plate) => plate.plate_id !== variables.plateId
      ? plate
      : {
          ...plate,
          units: plate.units.map((unit) => unit.token !== variables.token
            ? unit
            : { ...unit, x_um: variables.input.x_um, y_um: variables.input.y_um }),
        }),
  };
}

export function invalidateAcceptedPlateWorkspace(queryClient: QueryClient, profileId: number) {
  return queryClient.invalidateQueries({ queryKey: queryKeys.acceptedPlateWorkspace(profileId) });
}

export function invalidateAcceptedPlateExportJobs(queryClient: QueryClient, profileId: number) {
  return queryClient.invalidateQueries({ queryKey: queryKeys.acceptedPlateExportJobs(profileId) });
}

export function useAcceptedPlateWorkspaceQuery(profileId: number | null, enabled = true) {
  return useQuery({
    queryKey: queryKeys.acceptedPlateWorkspace(profileId ?? 0),
    queryFn: () => fetchAcceptedPlateWorkspace(profileId ?? 0),
    enabled: enabled && profileId != null && profileId > 0,
  });
}

export function useAcceptedPlateExportJobsQuery(profileId: number | null, enabled = true) {
  return useQuery<readonly AcceptedPlateExportRecord[]>({
    queryKey: queryKeys.acceptedPlateExportJobs(profileId ?? 0),
    queryFn: () => fetchAcceptedPlateExportJobs(profileId ?? 0),
    enabled: enabled && profileId != null && profileId > 0,
    refetchInterval: (query) => acceptedPlateHistoryNeedsPolling(query.state.data) ? 1_000 : false,
  });
}

export function acceptedPlateHistoryNeedsPolling(
  records: readonly AcceptedPlateExportRecord[] | undefined,
): boolean {
  return records?.some((record) => record.status === "pending" || record.status === "running") ?? false;
}

export function useAcceptedPlateRevisionPending(profileId: number | null): boolean {
  return useIsMutating({
    mutationKey: acceptedPlateMutationKey(profileId ?? 0),
    exact: true,
  }) > 0;
}

export function useInitializeAcceptedPlatesMutation(profileId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: acceptedPlateMutationKey(profileId),
    scope: acceptedPlateMutationScope(profileId),
    retry: false,
    mutationFn: (input: InitializeAcceptedPlatesRequest) => initializeAcceptedPlates(profileId, input),
    onSuccess: (workspace) => {
      queryClient.setQueryData(queryKeys.acceptedPlateWorkspace(profileId), workspace);
    },
  });
}

export function useMoveAcceptedPlateUnitMutation(profileId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: acceptedPlateMutationKey(profileId),
    scope: acceptedPlateMutationScope(profileId),
    retry: false,
    mutationFn: (variables: AcceptedPlateMoveVariables) => moveAcceptedPlateUnit(
      profileId,
      variables.plateId,
      variables.token,
      variables.input,
    ),
    onSuccess: async (receipt, variables) => {
      queryClient.setQueryData<AcceptedPlateWorkspace>(
        queryKeys.acceptedPlateWorkspace(profileId),
        (workspace) => publishAcceptedPlateMove(workspace, variables, receipt),
      );
      await invalidateAcceptedPlateWorkspace(queryClient, profileId);
    },
  });
}

export function useAcceptedPlateActionMutation(profileId: number) {
  const queryClient = useQueryClient();
  return useMutation<AcceptedPlateActionResult, Error, AcceptedPlateActionVariables>({
    mutationKey: acceptedPlateMutationKey(profileId),
    scope: acceptedPlateMutationScope(profileId),
    retry: false,
    mutationFn: async (variables) => {
      switch (variables.kind) {
        case "pin":
          return {
            kind: "receipt",
            receipt: await pinAcceptedPlateUnit(
              profileId,
              variables.plateId,
              variables.token,
              variables.input,
            ),
          };
        case "unplace":
          return {
            kind: "receipt",
            receipt: await unplaceAcceptedPlateUnit(
              profileId,
              variables.plateId,
              variables.token,
              variables.input,
            ),
          };
        case "transfer":
          return {
            kind: "receipt",
            receipt: await transferAcceptedPlateUnit(
              profileId,
              variables.plateId,
              variables.token,
              variables.input,
            ),
          };
        case "arrange":
          return { kind: "workspace", workspace: await arrangeAcceptedPlates(profileId, variables.input) };
        case "restore":
          return { kind: "workspace", workspace: await restoreAcceptedPlates(profileId, variables.input) };
      }
    },
    onSuccess: async (result) => {
      if (result.kind === "workspace") {
        queryClient.setQueryData(queryKeys.acceptedPlateWorkspace(profileId), result.workspace);
        return;
      }
      await invalidateAcceptedPlateWorkspace(queryClient, profileId);
    },
  });
}
