import {
  AcceptedPlanOperationalIntegrityError,
  type AcceptedOperationalArtifact,
  type AcceptedPlanOperationalSnapshot,
} from "../db/accepted-plan-operational.js";
import { acceptedPlanBasis, type AcceptedPlanBasis } from "../db/accepted-plan-progress.js";
import type { AppRepository } from "../db/repository.js";

export type AcceptedExportUnit = Readonly<{
  token: string;
  unitIndex: number;
  completed: boolean;
  assembled: boolean;
}>;

export type AcceptedExportPart = Readonly<{
  revisionPartId: number;
  projectionPartId: number;
  partKey: string;
  relativePath: string;
  filename: string;
  sourceLayer: string;
  status: string;
  role: string;
  filamentColorId: string | null;
  filamentCustomHex: string | null;
  spoolmanSpoolId: string | null;
  quantityInferred: number;
  quantityOverride: number | null;
  quantityEffective: number;
  included: boolean;
  notes: string;
  geometrySame: boolean | null;
  requirement: string | null;
  optionGroupId: string | null;
  manifestSource: string | null;
  artifact: AcceptedOperationalArtifact;
  units: readonly AcceptedExportUnit[];
}>;

export type AcceptedOperationalExport = Readonly<{
  basis: AcceptedPlanBasis;
  profile: AcceptedPlanOperationalSnapshot["profile"];
  provenance: AcceptedPlanOperationalSnapshot["provenance"];
  parts: readonly AcceptedExportPart[];
}>;

export type CaptureAcceptedOperationalExportResult =
  | { readonly kind: "ready"; readonly export: AcceptedOperationalExport }
  | {
      readonly kind: "empty";
      readonly profile: Readonly<{ id: number; name: string; orderNumber: string | null }>;
    }
  | { readonly kind: "profile_not_found" }
  | {
      readonly kind: "accepted_state_unavailable";
      readonly reason: "compatibility_dirty" | "uninitialized";
    }
  | { readonly kind: "integrity" };

export type CaptureAcceptedOperationalExportDependencies = Readonly<{
  repository: Pick<
    AppRepository,
    "getOwnedProfileIdentity" | "readAcceptedPlanOperationalSnapshot"
  >;
  profileId: number;
}>;

export type AcceptedOperationalExportFailureCode =
  | "profile_not_found"
  | "accepted_state_unavailable"
  | "accepted_integrity"
  | "export_limit_exceeded"
  | "export_output_failure"
  | "unexpected";

const PUBLIC_FAILURES = {
  profile_not_found: { status: 404, message: "Plan not found." },
  accepted_state_unavailable: {
    status: 409,
    message: "Accepted Plan state is unavailable. Apply or repair the Plan, then export again.",
  },
  accepted_integrity: {
    status: 500,
    message: "Accepted Plan export failed integrity verification.",
  },
  export_limit_exceeded: {
    status: 422,
    message: "Accepted Plan export exceeds the configured limit.",
  },
  export_output_failure: {
    status: 500,
    message: "Accepted Plan export could not be published safely.",
  },
  unexpected: { status: 500, message: "Accepted Plan export failed." },
} satisfies Record<AcceptedOperationalExportFailureCode, { status: number; message: string }>;

export class AcceptedOperationalExportPublicError extends Error {
  readonly code: AcceptedOperationalExportFailureCode;

  constructor(code: AcceptedOperationalExportFailureCode) {
    super(PUBLIC_FAILURES[code].message);
    this.name = "AcceptedOperationalExportPublicError";
    this.code = code;
  }
}

export function acceptedOperationalExportHttpStatus(
  error: AcceptedOperationalExportPublicError,
): number {
  return PUBLIC_FAILURES[error.code].status;
}

export function acceptedOperationalExportPublicError(
  result: Exclude<CaptureAcceptedOperationalExportResult, { readonly kind: "ready" | "empty" }>,
): AcceptedOperationalExportPublicError {
  switch (result.kind) {
    case "profile_not_found":
      return new AcceptedOperationalExportPublicError("profile_not_found");
    case "accepted_state_unavailable":
      return new AcceptedOperationalExportPublicError("accepted_state_unavailable");
    case "integrity":
      return new AcceptedOperationalExportPublicError("accepted_integrity");
  }
}

function projectAcceptedOperationalExport(
  snapshot: AcceptedPlanOperationalSnapshot,
): AcceptedOperationalExport {
  return {
    basis: acceptedPlanBasis(snapshot),
    profile: snapshot.profile,
    provenance: snapshot.provenance,
    parts: snapshot.parts.map((part) => ({
      revisionPartId: part.revisionPartId,
      projectionPartId: part.projectionPartId,
      partKey: part.partKey,
      relativePath: part.relativePath,
      filename: part.filename,
      sourceLayer: part.sourceLayer,
      status: part.status,
      role: part.effectiveRole,
      filamentColorId: part.filamentColorId,
      filamentCustomHex: part.filamentCustomHex,
      spoolmanSpoolId: part.spoolmanSpoolId,
      quantityInferred: part.quantityInferred,
      quantityOverride: part.quantityOverride,
      quantityEffective: part.quantityEffective,
      included: part.included,
      notes: part.notes,
      geometrySame: part.geometrySame,
      requirement: part.requirement,
      optionGroupId: part.optionGroupId,
      manifestSource: part.manifestSource,
      artifact: part.artifact,
      units: part.units.map((unit) => ({
        token: unit.token,
        unitIndex: unit.unitIndex,
        completed: unit.completed,
        assembled: unit.assembled,
      })),
    })),
  };
}

export function captureAcceptedOperationalExport(
  input: CaptureAcceptedOperationalExportDependencies,
): CaptureAcceptedOperationalExportResult {
  const profile = input.repository.getOwnedProfileIdentity(input.profileId);
  if (!profile) return { kind: "profile_not_found" };
  try {
    const accepted = input.repository.readAcceptedPlanOperationalSnapshot(input.profileId);
    switch (accepted.kind) {
      case "ready":
        return { kind: "ready", export: projectAcceptedOperationalExport(accepted.snapshot) };
      case "empty":
        return {
          kind: "empty",
          profile: {
            id: profile.id,
            name: profile.name,
            orderNumber: profile.orderNumber,
          },
        };
      case "compatibility_dirty":
      case "uninitialized":
        return { kind: "accepted_state_unavailable", reason: accepted.kind };
    }
  } catch (error) {
    if (error instanceof AcceptedPlanOperationalIntegrityError) return { kind: "integrity" };
    throw error;
  }
}
