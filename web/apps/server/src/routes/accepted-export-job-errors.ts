import type { MaterializeDirectExport3mfResult } from "../services/accepted-direct-export-3mf.js";
import type { MaterializeAcceptedPlateExportResult } from "../services/accepted-plate-export-delivery.js";

export const ACCEPTED_PLATE_EXPORT_ERRORS = {
  plate_revision_changed: "Plate layout changed. Refresh and export again.",
  unplaced_units: "Arrange every Required unit on a Plate before exporting.",
  accepted_state: "Accepted Plan state is unavailable. Refresh the Plan.",
  artifact: "A verified accepted artifact is unavailable.",
  limit: "Accepted Plate export exceeds the configured limit.",
  transaction: "Accepted Plate export is temporarily unavailable.",
  output: "The stored export for this Plate revision failed integrity verification.",
  unexpected: "Accepted Plate export failed.",
} as const;

export class AcceptedPlateExportPublicError extends Error {}

export function acceptedPlateExportError(
  result: Exclude<MaterializeAcceptedPlateExportResult, { readonly kind: "materialized" }>,
): string {
  switch (result.kind) {
    case "plate_revision_changed":
      return ACCEPTED_PLATE_EXPORT_ERRORS.plate_revision_changed;
    case "unplaced_units":
      return ACCEPTED_PLATE_EXPORT_ERRORS.unplaced_units;
    case "empty_plan":
    case "plates_not_published":
    case "stale_accepted_plan":
    case "accepted_state_unavailable":
    case "profile_not_found":
      return ACCEPTED_PLATE_EXPORT_ERRORS.accepted_state;
    case "artifact_unavailable":
    case "invalid_stl":
    case "artifact_geometry_mismatch":
      return ACCEPTED_PLATE_EXPORT_ERRORS.artifact;
    case "limit_exceeded":
      return ACCEPTED_PLATE_EXPORT_ERRORS.limit;
    case "transaction_unavailable":
      return ACCEPTED_PLATE_EXPORT_ERRORS.transaction;
    case "output_conflict":
      return ACCEPTED_PLATE_EXPORT_ERRORS.output;
  }
}

export function directExportError(
  result: Exclude<MaterializeDirectExport3mfResult, { readonly kind: "materialized" }>,
): string {
  switch (result.kind) {
    case "empty_plan":
    case "accepted_state_unavailable":
    case "profile_not_found":
      return ACCEPTED_PLATE_EXPORT_ERRORS.accepted_state;
    case "unknown_token":
      return "A selected Required unit is not on this Plan.";
    case "artifact_unavailable":
    case "invalid_stl":
    case "artifact_geometry_mismatch":
      return ACCEPTED_PLATE_EXPORT_ERRORS.artifact;
    case "limit_exceeded":
      return "Direct export exceeds the configured limit.";
    case "output_failure":
      return "Direct export could not be published safely.";
  }
}
