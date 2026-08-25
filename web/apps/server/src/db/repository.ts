import {
  DEFAULT_NAMING_PROFILE,
  importRulesForProject,
  mergeLayers,
  MergeWouldWipeProfileError,
  mergeNamingProfiles,
  namingProfileFromDict,
  parseSourceNamingMetadata,
  parseSourceNamingMetadataStrict,
  resolveNamingProfile,
  scanRepo,
  serializeImportRules,
  STL_NAMING_DEFAULTS_KEY,
  type MergePart,
  type StlNamingProfileDict,
  validateNamingProfile,
  parseProjectMetadata,
  resolveSourceCategory,
  SOURCE_CATEGORIES_KEY,
  loadSourceCategories,
  normalizeSourceCategories,
} from "@print-partner/domain";
import { createHash } from "node:crypto";
import { inArray } from "drizzle-orm";
import { applyManifestToDraftParts } from "../services/manifest-apply.js";
import { loadKitManifest, saveKitManifest, type KitManifestRecord } from "../services/kit-manifest-store.js";
import {
  collectKitBundleSourceRefs,
  kitLayerProjectExportRecord,
  kitMatchedSourcePatch,
  kitSourceRefFromProject,
  kitSourceRefToExportRecord,
  kitUnmatchedSourceFromRef,
  type KitBundleUnmatchedSource,
} from "../services/kit-bundle-share.js";
import { normalizePartRole } from "../services/role-filament.js";
import {
  canonicalRoleOrder,
  loadRoleFilamentDefaults,
  roleFilamentSettingKey,
  saveRoleFilamentDefault,
} from "../services/role-filament-store.js";
import { getColorById, resolvePartFilamentHex } from "../services/filament-catalog.js";
import type { EditableKitRecipe } from "../services/export-kit.js";
import { REMOTE_CHECKED_AT_KEY, REMOTE_UPDATE_STATUS_KEY } from "../services/source-update-check.js";
import {
  buildSourceCategoryTree,
  categoryAncestorPaths,
  isCategoryPathWithin,
  joinCategoryPath,
  categoryPathSegments,
  normalizeCategoryPath,
  type SourceCategoryNode,
} from "@print-partner/contracts";
import type {
  PartRow,
  PlanDecision,
  PlanDecisionActor,
  PlanDecisionKind,
  PlanFreshness,
  PlanRevisionInput,
  PlanRevisionInputSet,
  PlanSnapshot,
  PlanSnapshotSource,
  PlanSnapshotSummary,
  PrintOutcomeEvent,
  PrinterCheckoffLink,
  SourceRevision,
  SourceSummary,
  SourceNamingResponse,
  StlNamingProfileOverride,
} from "@print-partner/contracts";
import { and, asc, count, desc, eq, gte, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { basename, join, resolve, sep } from "node:path";
import type { DrizzleDb } from "./client.js";
import { asSyncDb, isSyncSqliteDrizzle, runSerializedSettingsMutation, type AppDrizzleDb } from "./sync-db-bridge.js";
import { getRequestTenantId } from "../middleware/tenant-context.js";
import type { ProfileSourceMode } from "../services/printer-profile-assignments.js";
import { stockPresets } from "../services/slicer-instances.js";
import { dockerPresetsForKind } from "../services/slicer-docker-presets.js";
import * as defaultSchema from "./schema.js";
import { DEFAULT_TENANT_ID } from "./schema.js";
import {
  canonicalPlanInputs,
  digestEffectiveNaming,
  digestPlanInputs,
  evaluatePlanFreshness,
  type AcceptedPlanInputIdentity,
  type CurrentPlanInput,
} from "../services/plan-freshness.js";
import {
  applyPlanDraftPartDecision,
  diffPlanDraftSnapshot,
  digestPlanDraft,
  digestPlanDraftSelection,
  MAX_PLAN_DRAFT_LIFECYCLE_VERSION,
  mergeRebasedPlanDraft,
  newPlanDraftPartDecisionBaseline,
  PLAN_DRAFT_DIGEST_FORMAT,
  PLAN_DRAFT_SELECTION_DIGEST_FORMAT,
  type PlanDraftDiff,
  type PlanDraftPartDecision,
  type PlanDraftSnapshot,
  type PlanDraftState,
  type RebaseAcceptedPart,
  type RebaseConflict,
  PlanDraftPartNotFoundError,
  type PlanSnapshotInput,
  type PlanSnapshotPart,
} from "../services/plan-drafts.js";
import { sha256File } from "../services/artifact-digest.js";
import {
  digestRequiredUnitMap,
  generateRequiredUnitToken,
  parseRequiredUnitToken,
  REQUIRED_UNIT_MAP_FORMAT,
  requiredUnitObjectName,
  validateRequiredUnitObjectName,
} from "../services/required-units.js";
import {
  digestRequiredUnitDecisions,
  digestRequiredUnitReconciliation,
  digestRequiredUnitReconciliationResult,
  digestRequiredUnitSelectionBasis,
  parseRequiredUnitReconciliationResult,
  parseRequiredUnitSelectionBasis,
  reconcileRequiredUnits,
  REQUIRED_UNIT_RECONCILIATION_FORMAT,
  serializeRequiredUnitReconciliationResult,
  serializeRequiredUnitSelectionBasis,
  type RequiredUnitAssignment,
  type RequiredUnitReconciliationBasePart,
  type RequiredUnitReconciliationConflict,
  type RequiredUnitReconciliationDecision,
  type RequiredUnitSelectionBasisRow,
} from "../services/required-unit-reconciliation.js";
import {
  digestPlanRevisionParts,
  PLAN_REVISION_DIGEST_FORMAT,
  preparePlanPublication,
  publishedPlanPartsMatch,
  validateAcceptedOperationalTextRow,
  type PlanPublicationBaseUnit,
} from "../services/plan-publication.js";
import {
  canonicalWorkingSources,
  workingSourceSelection,
  workingSourcesEqual,
  type WorkingSource,
  type WorkingSourceSelection,
} from "../services/working-plan-sources.js";
import { resolveStoredSnapshotPath } from "./stored-snapshot-path.js";
import {
  projectionPlanningFieldsMatch,
  readAcceptedPlanOperationalSnapshotInternal,
  type AcceptedPlanCorruptionCode,
  type ReadAcceptedPlanOperationalSnapshotResult,
} from "./accepted-plan-operational.js";
import {
  assignAcceptedFilamentInternal,
  filamentAssignmentColumns,
  liveAssignmentFrom,
  type AssignAcceptedFilament,
  type AssignAcceptedFilamentResult,
  type FilamentAssignment,
} from "./accepted-part-filament.js";
import {
  MAX_ACCEPTED_PROGRESS_SUMMARY_BATCH,
  readAcceptedPlanProgressBatch,
  type AcceptedPlanProgressRead,
} from "./accepted-plan-progress-summary.js";
import {
  acceptedPlanBasis,
  applyAcceptedUnitDecisionsInternal,
  archiveAcceptedPlanInternal,
  setAcceptedUnitAssemblyInternal,
  setAcceptedUnitCompletionInternal,
  type AcceptedPlanBasis,
  type AcceptedProgressFailure,
  type AcceptedUnitDecision,
  type ArchiveAcceptedPlanResult,
  type SetAcceptedUnitAssembly,
  type SetAcceptedUnitAssemblyResult,
  type SetAcceptedUnitCompletion,
  type SetAcceptedUnitCompletionResult,
} from "./accepted-plan-progress.js";
import {
  createPrinterCheckoffLink,
  getPrinterCheckoffLink,
  loadPrinterCheckoffLinks,
  updatePrinterCheckoffLink,
} from "../services/printer-checkoff-store.js";
import { normalizePrinterFilename } from "../services/printer-checkoff.js";
import { appendPrintOutcomes } from "../services/printer-outcomes-store.js";
import {
  resolveAcceptedPrinterAttribution,
  type MaterializeAcceptedPrinterLinkCommand,
  type MaterializeAcceptedPrinterLinkResult,
} from "./accepted-printer-attribution.js";
import {
  claimUnattributedPrint,
  listUnattributedPrints,
  type UnattributedPrint,
} from "../services/unattributed-print-store.js";
import {
  moveAcceptedPlateUnitInternal,
  pinAcceptedPlateUnitInternal,
  publishAcceptedPlatesInternal,
  readAcceptedPlateExportInputInternal,
  readAcceptedPlateWorkspaceInputInternal,
  readAcceptedPlatesInternal,
  restoreAcceptedPlatesInternal,
  transferAcceptedPlateUnitInternal,
  unplaceAcceptedPlateUnitInternal,
  type ReadAcceptedPlateExportInputResult,
  type ReadAcceptedPlateWorkspaceInputResult,
  type MoveAcceptedPlateUnitCommand,
  type MoveAcceptedPlateUnitResult,
  type PinAcceptedPlateUnitCommand,
  type PinAcceptedPlateUnitResult,
  type PublishAcceptedPlatesCommand,
  type PublishAcceptedPlatesResult,
  type ReadAcceptedPlatesResult,
  type RestoreAcceptedPlatesCommand,
  type RestoreAcceptedPlatesResult,
  type TransferAcceptedPlateUnitCommand,
  type TransferAcceptedPlateUnitResult,
  type UnplaceAcceptedPlateUnitCommand,
  type UnplaceAcceptedPlateUnitResult,
} from "./accepted-plates.js";

type PrinterPlanBinding = Readonly<{
  integration_id: string;
  profile_id: number | null;
  updated_at: string;
}>;

function parsePrinterPlanBindings(raw: string | null | undefined): PrinterPlanBinding[] {
  if (!raw?.trim()) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Printer Plan bindings are corrupt");
  }
  if (!Array.isArray(value)) throw new Error("Printer Plan bindings are corrupt");
  return value.map((item) => {
    const row = applyJsonRecord(item, "Printer Plan binding");
    if (
      typeof row.integration_id !== "string" ||
      !row.integration_id.trim() ||
      (row.profile_id !== null && (!Number.isSafeInteger(row.profile_id) || Number(row.profile_id) <= 0)) ||
      typeof row.updated_at !== "string"
    ) {
      throw new Error("Printer Plan bindings are corrupt");
    }
    return {
      integration_id: row.integration_id,
      profile_id: row.profile_id === null ? null : Number(row.profile_id),
      updated_at: row.updated_at,
    };
  });
}

function completedPrefixLength(
  units: ReadonlyArray<{
    readonly unitIndex: number;
    readonly completed: boolean;
  }>,
): number {
  let count = 0;
  for (const unit of [...units].sort((left, right) => left.unitIndex - right.unitIndex)) {
    if (unit.unitIndex !== count || !unit.completed) break;
    count += 1;
  }
  return count;
}

function filamentAssignmentFromRecord(row: Record<string, unknown>): FilamentAssignment {
  const colorId = typeof row.filament_color_id === "string" ? row.filament_color_id : null;
  const customHex = typeof row.filament_custom_hex === "string" ? row.filament_custom_hex : null;
  const color: FilamentAssignment["color"] =
    colorId != null
      ? { kind: "catalog", colorId }
      : customHex != null
        ? { kind: "custom", hex: customHex }
        : { kind: "unset" };
  return {
    color,
    spoolmanSpoolId: typeof row.spoolman_spool_id === "string" ? row.spoolman_spool_id : null,
  };
}

function docTitleFromPath(path: string): string {
  const base = basename(path);
  if (/^readme\.md$/i.test(base)) return "README";
  return base;
}

export type SchemaTables = Pick<
  typeof defaultSchema,
  | "appSettings"
  | "buildProfiles"
  | "parts"
  | "printProgress"
  | "profileLayers"
  | "projects"
  | "sourceRevisions"
  | "planRevisionInputSets"
  | "planRevisionInputs"
  | "planAcceptedInputSets"
  | "planRevisions"
  | "planRevisionParts"
  | "requiredUnits"
  | "planRevisionRequiredUnitSets"
  | "planRevisionRequiredUnits"
  | "acceptedPlateHeads"
  | "acceptedPlateRevisions"
  | "acceptedPlates"
  | "acceptedPlateUnits"
  | "planDrafts"
  | "planDraftInputs"
  | "planDraftParts"
  | "planDraftRequiredUnitReconciliations"
  | "planDraftRequiredUnitDecisions"
  | "planDraftRequiredUnitAssignments"
  | "planApplyRequests"
  | "sourceDocs"
  | "sourceNotes"
  | "planDecisions"
  | "planSnapshots"
  | "printJobs"
  | "printJobParts"
  | "printerTelemetry"
  | "appEvents"
  | "printerProfiles"
  | "processProfiles"
  | "filamentProfiles"
  | "printerNameMap"
  | "printerProfileAssignments"
  | "printerFilamentSlotAssignments"
  | "slicerInstances"
>;

export type ProjectRow = typeof defaultSchema.projects.$inferSelect;
export class PlanTransactionUnavailableError extends Error {
  readonly code = "transaction_unavailable" as const;

  constructor() {
    super("This operation requires a native database transaction");
    this.name = "PlanTransactionUnavailableError";
  }
}

export type SourceActivationObservation = Readonly<
  Pick<
    ProjectRow,
    "currentSourceRevisionId" | "url" | "branch" | "tag" | "sourceKind" | "sourceType" | "localPath" | "lastCommitSha"
  >
>;
export type ProfileRow = typeof defaultSchema.buildProfiles.$inferSelect;

export type ProfileHeader = {
  readonly id: number;
  readonly name: string;
  readonly order_number: string | null;
  readonly special_request: string | null;
  readonly part_count: number;
  readonly build_stale: boolean;
  readonly freshness: PlanFreshness;
  readonly archived_at: string | null;
  readonly last_used_at: string | null;
};

export type AcceptedProfileProgress =
  | {
      readonly kind: "ready";
      readonly totalUnits: number;
      readonly remainingUnits: number;
    }
  | { readonly kind: "empty" }
  | {
      readonly kind: "unavailable";
      readonly reason: "compatibility_dirty" | "uninitialized";
    }
  | {
      readonly kind: "integrity_failure";
      readonly code: AcceptedPlanCorruptionCode;
    }
  | { readonly kind: "concurrent_update" };

export type AcceptedProfileSummary = Readonly<{
  header: ProfileHeader;
  progress: AcceptedProfileProgress;
}>;

export type ReadAcceptedProfileSummary =
  { readonly kind: "found"; readonly summary: AcceptedProfileSummary } | { readonly kind: "missing" };

function acceptedProfileProgress(
  read: Exclude<AcceptedPlanProgressRead, { kind: "missing" }>,
): AcceptedProfileProgress {
  switch (read.kind) {
    case "ready":
      return {
        kind: "ready",
        totalUnits: read.totalUnits,
        remainingUnits: read.remainingUnits,
      };
    case "empty":
      return { kind: "empty" };
    case "unavailable":
      return { kind: "unavailable", reason: read.reason };
    case "integrity_failure":
      return { kind: "integrity_failure", code: read.code };
    case "concurrent_update":
      return { kind: "concurrent_update" };
  }
}

export type OwnedProfileIdentity = {
  readonly id: number;
  readonly name: string;
  readonly orderNumber: string | null;
  readonly archivedAt: string | null;
};
export type LayerRow = typeof defaultSchema.profileLayers.$inferSelect;
export type PartDbRow = typeof defaultSchema.parts.$inferSelect;
export type SourceDocRow = typeof defaultSchema.sourceDocs.$inferSelect;
export type SourceNoteRow = typeof defaultSchema.sourceNotes.$inferSelect;
export type PlanDecisionRow = typeof defaultSchema.planDecisions.$inferSelect;
export type PlanSnapshotRow = typeof defaultSchema.planSnapshots.$inferSelect;
export type PrintJobRow = typeof defaultSchema.printJobs.$inferSelect;
export type PrintJobPartRow = typeof defaultSchema.printJobParts.$inferSelect;
export type SourceRevisionRow = typeof defaultSchema.sourceRevisions.$inferSelect;
export type PlanRevisionInputSetRow = typeof defaultSchema.planRevisionInputSets.$inferSelect;
export type PlanRevisionInputRow = typeof defaultSchema.planRevisionInputs.$inferSelect;
export type PlanRevisionRow = typeof defaultSchema.planRevisions.$inferSelect;
export type PlanRevisionPartRow = typeof defaultSchema.planRevisionParts.$inferSelect;
export type PlanDraftRow = typeof defaultSchema.planDrafts.$inferSelect;
export type PlanDraftInputRow = typeof defaultSchema.planDraftInputs.$inferSelect;
export type PlanDraftPartRow = typeof defaultSchema.planDraftParts.$inferSelect;
export type PlanDraftRequiredUnitReconciliationRow =
  typeof defaultSchema.planDraftRequiredUnitReconciliations.$inferSelect;
export type PlanApplyRequestRow = typeof defaultSchema.planApplyRequests.$inferSelect;

export type RequiredUnitView = {
  readonly token: string;
  readonly objectName: string;
  readonly revisionPartId: number;
  readonly unitIndex: number;
  readonly required: boolean;
  readonly completed: boolean;
  readonly assembled: boolean;
};

export type ReadCurrentRequiredUnitSetResult =
  | {
      readonly kind: "unavailable";
      readonly reason: "no_accepted_revision" | "compatibility_dirty" | "uninitialized";
    }
  | {
      readonly kind: "ready";
      readonly revisionId: number;
      readonly mappingDigest: string;
      readonly units: readonly RequiredUnitView[];
    };

export type SavedRequiredUnitReconciliation = {
  readonly id: number;
  readonly format: string;
  readonly planningDigest: string;
  readonly baseRevisionId: number | null;
  readonly baseMappingDigest: string | null;
  readonly selectionBasisDigest: string;
  readonly decisionDigest: string;
  readonly resultKind: "unresolved" | "ready";
  readonly resultDigest: string;
  readonly reconciliationDigest: string;
  readonly expectedAssignmentCount: number;
  readonly decisions: readonly RequiredUnitReconciliationDecision[];
  readonly assignments: readonly RequiredUnitAssignment[];
  readonly surplus: readonly string[];
  readonly conflicts: readonly RequiredUnitReconciliationConflict[];
  readonly selectionBasis: readonly RequiredUnitSelectionBasisRow[];
};

export type SavePlanDraftRequiredUnitReconciliationResult =
  | {
      readonly kind: "saved" | "existing";
      readonly draft: PlanDraftSnapshot;
      readonly reconciliation: SavedRequiredUnitReconciliation;
    }
  | { readonly kind: "superseded"; readonly reconciliationId: number }
  | { readonly kind: "idempotency_conflict" }
  | { readonly kind: "conflict"; readonly draft: PlanDraftSnapshot }
  | { readonly kind: "accepted_baseline_required" }
  | { readonly kind: "base_changed"; readonly draft: PlanDraftSnapshot }
  | { readonly kind: "required_unit_set_unavailable" }
  | { readonly kind: "not_open"; readonly state: "abandoned" | "consumed" }
  | { readonly kind: "not_found" }
  | { readonly kind: "transaction_unavailable" };

export type AcceptedPlanBase =
  | { readonly kind: "empty"; readonly planVersion: 0 }
  | {
      readonly kind: "revision";
      readonly revisionId: number;
      readonly planVersion: number;
    };

export type ApplyPlanChangesCommand = {
  readonly profileId: number;
  readonly draftId: number;
  readonly expectedSnapshotDigest: string;
  readonly expectedLifecycleVersion: number;
  readonly expectedBase: AcceptedPlanBase;
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly remapCheckoffLinks?: boolean;
};

export type UnmappableCheckoffLink = {
  readonly linkId: string;
  readonly filename: string;
  readonly reason: string;
};

export type AppliedPlanReceipt = {
  readonly profileId: number;
  readonly draftId: number;
  readonly revisionId: number;
  readonly planVersion: number;
  readonly draftLifecycleVersion: number;
  readonly revisionDigest: string;
  readonly requiredUnitMappingDigest: string;
  readonly appliedAt: string;
};

export type ApplyPlanChangesResult =
  | {
      readonly kind: "applied" | "existing" | "already_applied";
      readonly receipt: AppliedPlanReceipt;
    }
  | { readonly kind: "idempotency_conflict" }
  | { readonly kind: "not_found" }
  | { readonly kind: "not_open"; readonly state: "abandoned" | "consumed" }
  | { readonly kind: "draft_changed" }
  | { readonly kind: "build_archived" }
  | { readonly kind: "accepted_baseline_required" }
  | { readonly kind: "base_changed" }
  | {
      readonly kind: "reconciliation_required";
      readonly reason: "missing" | "unresolved" | "stale";
    }
  | {
      readonly kind: "production_active";
      readonly checkoffLinkCount: number;
      readonly sendQueueItemCount: number;
    }
  | {
      readonly kind: "checkoff_remap_unsafe";
      readonly unmappable: readonly UnmappableCheckoffLink[];
    }
  | { readonly kind: "token_allocation_failed" }
  | { readonly kind: "transaction_unavailable" };

export type RecomputePlanDraftResult =
  | { readonly kind: "created"; readonly draft: PlanDraftSnapshot }
  | { readonly kind: "existing"; readonly draft: PlanDraftSnapshot }
  | { readonly kind: "accepted_baseline_required" }
  | { readonly kind: "base_changed" }
  | { readonly kind: "inputs_changed" }
  | { readonly kind: "idempotency_conflict" }
  | { readonly kind: "transaction_unavailable" }
  | { readonly kind: "no_layers" }
  | { readonly kind: "no_stls" }
  | { readonly kind: "would_wipe" };

export type SetAcceptedPrintedCountsResult =
  | { readonly kind: "updated"; readonly updatedParts: number }
  | { readonly kind: "part_not_found" | "invalid_rows" }
  | AcceptedProgressFailure;

export type EditPlanDraftPartsResult =
  | { readonly kind: "updated"; readonly draft: PlanDraftSnapshot }
  | { readonly kind: "unchanged"; readonly draft: PlanDraftSnapshot }
  | { readonly kind: "conflict"; readonly draft: PlanDraftSnapshot }
  | { readonly kind: "accepted_baseline_required" }
  | { readonly kind: "base_changed"; readonly draft: PlanDraftSnapshot }
  | { readonly kind: "not_open"; readonly state: "abandoned" | "consumed" }
  | { readonly kind: "not_found" }
  | { readonly kind: "transaction_unavailable" };

export type PlanDraftLifecycleTransition =
  | { readonly kind: "abandon"; readonly expectedLifecycleVersion: number }
  | { readonly kind: "resume"; readonly expectedLifecycleVersion: number };

export type TransitionPlanDraftResult =
  | { readonly kind: "transitioned"; readonly draft: PlanDraftSnapshot }
  | { readonly kind: "unchanged"; readonly draft: PlanDraftSnapshot }
  | { readonly kind: "conflict"; readonly draft: PlanDraftSnapshot }
  | { readonly kind: "accepted_baseline_required" }
  | { readonly kind: "base_changed"; readonly draft: PlanDraftSnapshot }
  | { readonly kind: "not_allowed"; readonly state: PlanDraftState }
  | { readonly kind: "not_found" }
  | { readonly kind: "transaction_unavailable" };

export type RebasePlanDraftResult =
  | { readonly kind: "rebased"; readonly draft: PlanDraftSnapshot }
  | { readonly kind: "existing"; readonly draft: PlanDraftSnapshot }
  | { readonly kind: "idempotency_conflict" }
  | {
      readonly kind: "merge_conflicts";
      readonly conflicts: readonly RebaseConflict[];
    }
  | { readonly kind: "source_conflict"; readonly draft: PlanDraftSnapshot }
  | { readonly kind: "not_abandoned"; readonly state: PlanDraftState }
  | { readonly kind: "accepted_baseline_required" }
  | { readonly kind: "base_unchanged" }
  | { readonly kind: "base_changed" }
  | { readonly kind: "inputs_changed" }
  | { readonly kind: "not_found" }
  | { readonly kind: "no_layers" | "no_stls" | "would_wipe" }
  | { readonly kind: "transaction_unavailable" };

export type ReplaceWorkingPlanSourcesResult =
  | {
      readonly kind: "updated" | "unchanged";
      readonly selection: WorkingSourceSelection;
    }
  | { readonly kind: "conflict"; readonly selection: WorkingSourceSelection }
  | {
      readonly kind: "not_found" | "build_archived" | "transaction_unavailable";
    };

type StoredRebasePlanDraftResult = Extract<
  RebasePlanDraftResult,
  {
    readonly kind: "existing" | "idempotency_conflict" | "source_conflict" | "not_found";
  }
>;

type AcceptedPlanRevisionIdentity = Omit<PlanRevisionRow, "provenanceKind" | "inputSetId"> &
  ({ provenanceKind: "tracked"; inputSetId: number } | { provenanceKind: "legacy"; inputSetId: null });

export type AcceptedPlanRevisionPart = PlanRevisionPartRow & {
  effectiveRole: string;
  effectiveQuantity: number;
};

export type AcceptedPlanRevision = AcceptedPlanRevisionIdentity & {
  planVersion: number;
  parts: AcceptedPlanRevisionPart[];
};

function acceptedPlanRevisionIdentity(row: PlanRevisionRow): AcceptedPlanRevisionIdentity {
  if (row.provenanceKind === "tracked" && row.inputSetId != null) {
    return { ...row, provenanceKind: "tracked", inputSetId: row.inputSetId };
  }
  if (row.provenanceKind === "legacy" && row.inputSetId == null) {
    return { ...row, provenanceKind: "legacy", inputSetId: null };
  }
  throw new Error("Accepted Plan revision provenance is invalid");
}

export type SourceNamingCommand =
  { readonly kind: "use_defaults" } | { readonly kind: "override"; readonly profile: StlNamingProfileDict };

export type SourceNamingReadResult =
  | { readonly kind: "found"; readonly settings: SourceNamingResponse }
  | { readonly kind: "source_not_found" }
  | { readonly kind: "invalid_state" };

export type SourceNamingSaveResult =
  | { readonly kind: "saved"; readonly settings: SourceNamingResponse }
  | { readonly kind: "source_not_found" }
  | { readonly kind: "conflict" };

function sourceNamingResponse(input: {
  readonly useDefaults: boolean;
  readonly override: StlNamingProfileOverride;
  readonly effective: StlNamingProfileDict;
}): SourceNamingResponse {
  const common = {
    effective: input.effective,
    effective_digest: digestEffectiveNaming(input.effective),
  };
  return input.useDefaults
    ? { use_defaults: true, override: {}, ...common }
    : { use_defaults: false, override: input.override, ...common };
}

type CapturedPlanLayer = {
  readonly layerId: number;
  readonly layerOrder: number;
  readonly layerType: string;
  readonly projectId: number;
  readonly sourceName: string;
  readonly sourceLayer: string;
  readonly localPath: string | null;
  readonly importRules: string[] | null;
  readonly namingProfile: StlNamingProfileDict;
  readonly input: CurrentPlanInput;
};

type CapturedPlanInputs = {
  readonly fingerprint: string;
  readonly layers: readonly CapturedPlanLayer[];
  readonly inputs: readonly CurrentPlanInput[];
};

type PreparedPlanDraft = {
  readonly baseRevisionId: number | null;
  readonly basePlanVersion: number;
  readonly capture: CapturedPlanInputs;
  readonly inputs: readonly PlanSnapshotInput[];
  readonly parts: readonly (PlanSnapshotPart & {
    readonly baseRevisionPartId: number | null;
  })[];
  readonly snapshotDigest: string;
};

type PreparePlanDraftResult =
  | { readonly kind: "prepared"; readonly value: PreparedPlanDraft }
  | { readonly kind: "no_layers" | "no_stls" | "would_wipe" };

function matchesPlanningPathScope(path: string, scopes: ReadonlySet<string>): boolean {
  for (const scope of scopes) {
    if (scope.endsWith("/**") && path.startsWith(scope.slice(0, -2))) return true;
    if (path === scope) return true;
  }
  return false;
}

type PlanFreshnessContext = {
  readonly globalNaming: StlNamingProfileDict;
  readonly layersByProfile: ReadonlyMap<number, readonly LayerRow[]>;
  readonly sourcesById: ReadonlyMap<number, ProjectRow>;
  readonly revisionsById: ReadonlyMap<number, SourceRevisionRow>;
  readonly acceptedByProfile: ReadonlyMap<number, AcceptedPlanInputIdentity>;
  readonly invalidProfiles: ReadonlySet<number>;
};

export type SlicerProfileRow = {
  id: number;
  name: string;
  /** Slicer dialect tag; null for filament rows, which carry no such column. */
  slicerFormat: string | null;
  /** Only set for filament rows (PLA/PETG/…); null elsewhere. */
  materialType?: string | null;
  resolvedFlatConfig: string | null;
};

/** Full row for the read-only profile library UI (all three kinds merged). */
export type ProfileLibraryRow = {
  id: number;
  kind: "printer" | "process" | "filament";
  name: string;
  slicerFormat: string | null;
  materialType: string | null;
  resolvedFlatConfig: string | null;
  sourcePath: string | null;
  syncedFromSlicerVersion: string | null;
  lastSyncedAt: string | null;
  importedAt: string;
};

export type SlicerInstanceRow = {
  id: string;
  name: string;
  kind: string;
  dialect: string;
  guiUrl: string;
  watchPath: string;
  dockerTarget: string;
  dockerHost: string | null;
  composeService: string | null;
  image: string | null;
  containerName: string | null;
  portsJson: string;
  volumesJson: string;
  envJson: string;
  statusCache: string;
  statusMessage: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type SyncedPrinterProfileInput = {
  name: string;
  slicerFormat: string;
  slicerVersion?: string | null;
  nozzleDiameterMm?: string | null;
  extruderCount?: number | null;
  rawJson?: string | null;
  resolvedFlatConfig: string;
  sourcePath: string;
};

/** Input for a process profile upserted by the profile-sync watcher. */
export type SyncedProcessProfileInput = {
  name: string;
  slicerFormat: string;
  slicerVersion?: string | null;
  compatiblePrinters?: string | null;
  resolvedFlatConfig: string;
  sourcePath: string;
};

/** Input for a filament profile upserted by the profile-sync watcher. */
export type SyncedFilamentProfileInput = {
  name: string;
  materialType: string;
  slicerVersion?: string | null;
  materialTier?: number | null;
  nozzleTempC?: number | null;
  bedTempC?: number | null;
  fanPct?: number | null;
  extrusionMultiplier?: string | null;
  pressureAdvance?: string | null;
  retraction?: string | null;
  rawJson?: string | null;
  rawIni?: string | null;
  resolvedFlatConfig: string;
  sourcePath: string;
};

export type SourceDocSummary = {
  id: number;
  path: string;
  kind: string;
  title: string;
  size_bytes: number;
  extract_status: string;
  page_count: number | null;
};

export type SourceNoteSummary = {
  id: number;
  project_id: number;
  profile_id: number | null;
  title: string;
  body_markdown: string;
  author_user_id: string | null;
  created_at: string;
  updated_at: string;
};

function readSourceUpdateFields(metadata: Record<string, unknown> | null): {
  update_status: "up_to_date" | "updates_available" | "unknown" | null;
  update_checked_at: string | null;
} {
  const data = metadata ?? {};
  const status = data[REMOTE_UPDATE_STATUS_KEY];
  const valid: "up_to_date" | "updates_available" | "unknown" | null =
    status === "up_to_date" || status === "updates_available" || status === "unknown" ? status : null;
  const checked = data[REMOTE_CHECKED_AT_KEY];
  return {
    update_status: valid,
    update_checked_at: typeof checked === "string" ? checked : null,
  };
}

function sourceSummary(row: ProjectRow, docCount = 0): SourceSummary {
  const metadata = parseProjectMetadata(row.metadataJson);
  const { useDefaults } = parseSourceNamingMetadata(metadata);
  const { update_status, update_checked_at } = readSourceUpdateFields(metadata);
  const sourceKind = row.sourceKind || (row.sourceType === "local" ? "local" : "github");
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    source_kind: sourceKind,
    source_type: row.sourceType ?? "git",
    role: row.role ?? "unassigned",
    category: resolveSourceCategory(row.metadataJson, row.role),
    branch: row.branch ?? "main",
    tag: row.tag ?? null,
    local_path: row.localPath,
    last_synced_at: row.lastSyncedAt,
    last_commit_sha: row.lastCommitSha,
    current_source_revision_id: row.currentSourceRevisionId,
    docs_url: row.docsUrl,
    manifest_community_slug: row.manifestCommunitySlug,
    metadata,
    naming_use_defaults: useDefaults,
    update_status,
    update_checked_at,
    doc_count: docCount,
  };
}

function sourceRevision(row: SourceRevisionRow): SourceRevision {
  if (row.completeness !== "complete") {
    throw new Error("Incomplete sync attempt is not a Source revision");
  }
  return {
    id: row.id,
    source_id: row.projectId,
    upstream_revision_key: row.upstreamRevisionKey,
    manifest_digest: row.manifestDigest,
    snapshot_locator: row.snapshotLocator,
    synced_at: row.syncedAt,
    completeness: "complete",
  };
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function sha256Digest(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(`${label} must be a SHA-256 hex digest`);
  }
  return normalized;
}

const PLAN_APPLY_REQUEST_FORMAT = "plan-apply-request-v1";

function positiveSafeId(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} is invalid`);
  return value;
}

function planApplyRequestDigest(input: {
  readonly profileId: number;
  readonly draftId: number;
  readonly expectedSnapshotDigest: string;
  readonly expectedLifecycleVersion: number;
  readonly expectedBaseRevisionId: number | null;
  readonly expectedBasePlanVersion: number;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        format: PLAN_APPLY_REQUEST_FORMAT,
        profile_id: input.profileId,
        draft_id: input.draftId,
        expected_snapshot_digest: input.expectedSnapshotDigest,
        expected_lifecycle_version: input.expectedLifecycleVersion,
        expected_base_revision_id: input.expectedBaseRevisionId,
        expected_base_plan_version: input.expectedBasePlanVersion,
      }),
    )
    .digest("hex");
}

function applyJsonRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value == null || Array.isArray(value)) {
    throw new Error(`${label} is corrupt`);
  }
  return value as Record<string, unknown>;
}

type CheckoffRemapPlan = {
  readonly checkoffLinksRaw: string | null;
  readonly sendQueueRaw: string | null;
  readonly remapByDraftPart: ReadonlyMap<string, number>;
};

function assessCheckoffRemap(input: {
  readonly profileId: number;
  readonly checkoffLinksRaw: string | null;
  readonly sendQueueRaw: string | null;
  readonly oldPartMatchKeyById: ReadonlyMap<number, string>;
  readonly partProfileIdById: ReadonlyMap<number, number>;
  readonly newPartByMatchKey: ReadonlyMap<string, { readonly draftPartId: number; readonly quantityEffective: number }>;
}):
  | ({ readonly kind: "safe" } & CheckoffRemapPlan)
  | { readonly kind: "unsafe"; readonly unmappable: UnmappableCheckoffLink[] } {
  const remapByDraftPart = new Map<string, number>();
  const unmappable: UnmappableCheckoffLink[] = [];
  const seen = new Set<string>();

  function resolve(linkId: string, filename: string, unit: { part_id: number; unit_index: number }): void {
    const key = `${unit.part_id}:${unit.unit_index}`;
    if (seen.has(key)) return;
    seen.add(key);
    const matchKey = input.oldPartMatchKeyById.get(unit.part_id);
    if (!matchKey) {
      unmappable.push({
        linkId,
        filename,
        reason: `Checked-off part id ${unit.part_id} no longer exists in this Plan's parts`,
      });
      return;
    }
    const target = input.newPartByMatchKey.get(matchKey);
    if (!target) {
      unmappable.push({
        linkId,
        filename,
        reason: `STL for "${filename}" (match_key ${matchKey}) is no longer part of the reconciled Plan`,
      });
      return;
    }
    if (unit.unit_index >= target.quantityEffective) {
      unmappable.push({
        linkId,
        filename,
        reason: `Checked-off unit index ${unit.unit_index} exceeds the new quantity (${target.quantityEffective}) for "${filename}"`,
      });
      return;
    }
    remapByDraftPart.set(key, target.draftPartId);
  }

  for (const value of applySettingArray(input.checkoffLinksRaw, "Printer Checkoff links")) {
    const row = applyJsonRecord(value, "Printer Checkoff link");
    if (row.profile_id !== input.profileId) continue;
    const linkId = typeof row.id === "string" ? row.id : "unknown";
    const filename = typeof row.filename === "string" ? row.filename : "unknown file";
    if (Array.isArray(row.units)) {
      for (const unitValue of row.units) {
        const unit = applyJsonRecord(unitValue, "Printer Checkoff coordinate");
        resolve(linkId, filename, {
          part_id: unit.part_id as number,
          unit_index: unit.unit_index as number,
        });
      }
    }
  }
  for (const value of applySettingArray(input.sendQueueRaw, "Printer send queue")) {
    const row = applyJsonRecord(value, "Printer send queue item");
    const units = row.checkoff_units == null ? [] : row.checkoff_units;
    if (!Array.isArray(units)) continue;
    const explicitProfileId = typeof row.profile_id === "number" ? row.profile_id : null;
    if (explicitProfileId != null && explicitProfileId !== input.profileId) continue;
    if (
      explicitProfileId == null &&
      units.some((unitValue) => {
        const unit = applyJsonRecord(unitValue, "Printer queue coordinate");
        return input.partProfileIdById.get(unit.part_id as number) === input.profileId;
      }) === false &&
      units.some((unitValue) => {
        const unit = applyJsonRecord(unitValue, "Printer queue coordinate");
        return input.partProfileIdById.has(unit.part_id as number);
      })
    ) {
      continue;
    }
    const linkId = typeof row.id === "string" ? row.id : "unknown";
    const filename = typeof row.filename === "string" ? row.filename : "unknown file";
    for (const unitValue of units) {
      const unit = applyJsonRecord(unitValue, "Printer queue coordinate");
      resolve(linkId, filename, {
        part_id: unit.part_id as number,
        unit_index: unit.unit_index as number,
      });
    }
  }

  if (unmappable.length > 0) return { kind: "unsafe", unmappable };
  return {
    kind: "safe",
    checkoffLinksRaw: input.checkoffLinksRaw,
    sendQueueRaw: input.sendQueueRaw,
    remapByDraftPart,
  };
}

function applySettingArray(value: string | null, label: string): unknown[] {
  if (value == null || value.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${label} is corrupt`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${label} is corrupt`);
  return parsed;
}

function planInputTrackingKind(value: string): PlanRevisionInput["tracking_kind"] {
  return value === "untracked" ? "untracked" : "revision";
}

function partRow(row: PartDbRow): PartRow {
  return {
    id: row.id,
    match_key: row.matchKey,
    relative_path: row.relativePath,
    filename: row.filename,
    source_layer: row.sourceLayer,
    status: row.status,
    role: row.role,
    requirement: row.requirement,
    option_group_id: row.optionGroupId,
    included: row.included,
    filament_color_id: row.filamentColorId,
    filament_custom_hex: row.filamentCustomHex,
    spoolman_spool_id: row.spoolmanSpoolId,
    filament_display: "",
    filament_hex: row.filamentCustomHex,
    quantity_auto: row.quantityAuto,
    quantity_override: row.quantityOverride,
    quantity_effective: row.quantityEffective,
  };
}

function acceptedRevisionPartRow(row: AcceptedPlanRevisionPart): PartRow {
  if (row.projectionPartId == null) {
    throw new Error("Accepted Plan revision Part has no compatibility projection ID");
  }
  return {
    id: row.projectionPartId,
    match_key: row.partKey,
    relative_path: row.relativePath,
    filename: row.filename,
    source_layer: row.sourceLayer,
    status: row.status,
    role: row.effectiveRole,
    requirement: row.requirement,
    option_group_id: row.optionGroupId,
    included: row.included,
    filament_color_id: row.filamentColorId,
    filament_custom_hex: row.filamentCustomHex,
    spoolman_spool_id: row.spoolmanSpoolId,
    filament_display: "",
    filament_hex: row.filamentCustomHex,
    quantity_auto: row.quantityInferred,
    quantity_override: row.quantityOverride,
    quantity_effective: row.effectiveQuantity,
  };
}

export class AppRepository {
  readonly reposDir: string;

  private readonly schema: SchemaTables;
  private readonly syncSqlite: boolean;

  constructor(
    db: AppDrizzleDb,
    private readonly defaultTenantId = DEFAULT_TENANT_ID,
    reposDir: string,
    schema: SchemaTables = defaultSchema,
    private readonly planApplyDependencies: {
      readonly clock?: () => Date;
      readonly tokenFactory?: () => string;
    } = {},
  ) {
    this.syncSqlite = isSyncSqliteDrizzle(db);
    this.db = asSyncDb(db);
    this.schema = schema;
    this.reposDir = reposDir;
  }

  private readonly db: DrizzleDb;

  private get tenantId(): string {
    return getRequestTenantId(this.defaultTenantId);
  }

  private requireProfile(profileId: number): void {
    const visible = this.db
      .select({ id: this.schema.buildProfiles.id })
      .from(this.schema.buildProfiles)
      .where(and(eq(this.schema.buildProfiles.tenantId, this.tenantId), eq(this.schema.buildProfiles.id, profileId)))
      .get();
    if (!visible) throw new Error("Profile not found");
  }

  private acceptedPlateDependencies() {
    return {
      db: this.db,
      schema: this.schema,
      tenantId: this.tenantId,
      reposDir: this.reposDir,
      sqlite: this.syncSqlite,
      transaction: <T>(operation: () => T) => this.transaction(operation, "immediate"),
      readTransaction: <T>(operation: () => T) => this.transaction(operation, "deferred"),
      clock: this.planApplyDependencies.clock,
    };
  }

  readAcceptedPlates(profileId: number): ReadAcceptedPlatesResult {
    return readAcceptedPlatesInternal(this.acceptedPlateDependencies(), profileId);
  }

  readAcceptedPlateExportInput(profileId: number): ReadAcceptedPlateExportInputResult {
    return readAcceptedPlateExportInputInternal(this.acceptedPlateDependencies(), profileId);
  }

  readAcceptedPlateWorkspaceInput(profileId: number): ReadAcceptedPlateWorkspaceInputResult {
    return readAcceptedPlateWorkspaceInputInternal(this.acceptedPlateDependencies(), profileId);
  }

  publishAcceptedPlates(command: PublishAcceptedPlatesCommand): PublishAcceptedPlatesResult {
    return publishAcceptedPlatesInternal(this.acceptedPlateDependencies(), command);
  }

  moveAcceptedPlateUnit(command: MoveAcceptedPlateUnitCommand): MoveAcceptedPlateUnitResult {
    return moveAcceptedPlateUnitInternal(this.acceptedPlateDependencies(), command);
  }

  pinAcceptedPlateUnit(command: PinAcceptedPlateUnitCommand): PinAcceptedPlateUnitResult {
    return pinAcceptedPlateUnitInternal(this.acceptedPlateDependencies(), command);
  }

  unplaceAcceptedPlateUnit(command: UnplaceAcceptedPlateUnitCommand): UnplaceAcceptedPlateUnitResult {
    return unplaceAcceptedPlateUnitInternal(this.acceptedPlateDependencies(), command);
  }

  transferAcceptedPlateUnit(command: TransferAcceptedPlateUnitCommand): TransferAcceptedPlateUnitResult {
    return transferAcceptedPlateUnitInternal(this.acceptedPlateDependencies(), command);
  }

  restoreAcceptedPlates(command: RestoreAcceptedPlatesCommand): RestoreAcceptedPlatesResult {
    return restoreAcceptedPlatesInternal(this.acceptedPlateDependencies(), command);
  }

  private planRevisionInputSet(row: PlanRevisionInputSetRow): PlanRevisionInputSet {
    if (!row.publishedAt) throw new Error("Plan revision input set is not published");
    const inputs = this.db
      .select()
      .from(this.schema.planRevisionInputs)
      .where(
        and(
          eq(this.schema.planRevisionInputs.tenantId, this.tenantId),
          eq(this.schema.planRevisionInputs.inputSetId, row.id),
        ),
      )
      .orderBy(asc(this.schema.planRevisionInputs.sourceId))
      .all()
      .map((input): PlanRevisionInput => ({
        source_id: input.sourceId,
        source_layer: input.sourceLayer,
        layer_order: input.layerOrder,
        tracking_kind: planInputTrackingKind(input.trackingKind),
        source_revision_id: input.sourceRevisionId,
        manifest_digest: input.manifestDigest,
        effective_naming_digest: input.effectiveNamingDigest ?? "",
      }));
    if (inputs.length !== row.expectedInputCount) {
      throw new Error("Published Plan revision input set is incomplete");
    }
    return {
      id: row.id,
      plan_id: row.profileId,
      recorded_at: row.recordedAt,
      published_at: row.publishedAt,
      format_version: row.formatVersion === 2 ? 2 : 1,
      inputs,
    };
  }

  readAcceptedPlanOperationalSnapshot(profileId: number): ReadAcceptedPlanOperationalSnapshotResult {
    const read = () =>
      readAcceptedPlanOperationalSnapshotInternal({
        db: this.db,
        schema: this.schema,
        tenantId: this.tenantId,
        profileId,
        reposDir: this.reposDir,
        sqlite: this.syncSqlite,
      });
    return this.syncSqlite ? this.transaction(read, "deferred") : read();
  }

  canMutateAcceptedPlan(): boolean {
    return this.syncSqlite;
  }

  materializeAcceptedPrinterLink(command: MaterializeAcceptedPrinterLinkCommand): MaterializeAcceptedPrinterLinkResult {
    if (!this.syncSqlite) return { kind: "transaction_unavailable" };
    return this.transaction(() => {
      let profileId: number;
      let objectNames: readonly string[];
      let fallbackFilename: string;
      let claimPrint: Readonly<UnattributedPrint> | undefined;
      if (command.kind === "repair") {
        const current = getPrinterCheckoffLink(this, command.expectedLink.id);
        if (!current) return { kind: "link_not_found" as const };
        if (JSON.stringify(current) !== JSON.stringify(command.expectedLink)) {
          return { kind: "link_changed" as const };
        }
        if (current.state !== "awaiting_verify" || current.units.length > 0) {
          return { kind: "not_repairable" as const };
        }
        profileId = current.profile_id;
        objectNames = current.unlabeled_names ?? [];
        fallbackFilename = current.filename;
      } else if (command.kind === "create") {
        profileId = command.profileId;
        objectNames = command.objectNames;
        fallbackFilename = command.fallbackFilename ?? command.link.filename;
      } else {
        profileId = command.profileId;
        const current = listUnattributedPrints(this).find((print) => print.id === command.expectedPrint.id);
        if (
          !current ||
          current.claimed_at ||
          current.dismissed ||
          JSON.stringify(current) !== JSON.stringify(command.expectedPrint)
        ) {
          return { kind: "print_changed" as const };
        }
        claimPrint = current;
        objectNames = current.gcode_objects;
        fallbackFilename = current.filename;
      }

      const accepted = readAcceptedPlanOperationalSnapshotInternal({
        db: this.db,
        schema: this.schema,
        tenantId: this.tenantId,
        profileId,
        reposDir: this.reposDir,
        sqlite: true,
      });
      if (accepted.kind === "empty") return { kind: "empty" as const };
      if (accepted.kind !== "ready") {
        return {
          kind: "accepted_state_unavailable" as const,
          reason: accepted.kind,
        };
      }
      const attribution = resolveAcceptedPrinterAttribution(accepted.snapshot, {
        objectNames,
        fallbackFilename,
      });
      if (attribution.units.length === 0) return { kind: "no_match" as const };
      const units = attribution.units.map((unit) => ({ ...unit }));
      const unlabeledNames = attribution.unmatchedObjectNames.length
        ? [...attribution.unmatchedObjectNames]
        : undefined;

      if (command.kind === "repair") {
        const link = updatePrinterCheckoffLink(
          this,
          command.expectedLink.id,
          { units, unlabeled_names: unlabeledNames },
          { requireState: "awaiting_verify" },
        );
        if (!link) return { kind: "link_changed" as const };
        return { kind: "repaired" as const, link, attribution };
      }

      const linkInput =
        command.kind === "claim"
          ? {
              integrationId: command.expectedPrint.integration_id,
              printerId: command.expectedPrint.printer_id,
              hostName: command.expectedPrint.host_name,
              filename: command.expectedPrint.filename,
              started: true,
            }
          : command.link;
      const normalizedFilename = normalizePrinterFilename(linkInput.filename);
      const alreadyLinked = loadPrinterCheckoffLinks(this).some(
        (link) =>
          (link.state === "watching" || link.state === "awaiting_verify") &&
          link.integration_id === linkInput.integrationId &&
          normalizePrinterFilename(link.filename) === normalizedFilename,
      );
      if (alreadyLinked) return { kind: "already_linked" as const };
      const link = createPrinterCheckoffLink(this, {
        profile_id: profileId,
        integration_id: linkInput.integrationId,
        printer_id: linkInput.printerId,
        host_name: linkInput.hostName,
        filename: linkInput.filename,
        units,
        unlabeled_names: unlabeledNames,
        started: linkInput.started,
      });
      if (!link) throw new Error("Accepted printer link creation failed");
      if (command.kind === "claim") {
        if (!claimPrint) throw new Error("Accepted printer claim lost its print");
        const awaiting = updatePrinterCheckoffLink(
          this,
          link.id,
          {
            state: "awaiting_verify",
            host_outcome: "success",
            completed_at: claimPrint.completed_at,
            saw_active: true,
          },
          { requireState: "watching" },
        );
        if (!awaiting) throw new Error("Accepted printer claim transition failed");
        for (const print of listUnattributedPrints(this)) {
          if (
            !print.claimed_at &&
            !print.dismissed &&
            print.integration_id === claimPrint.integration_id &&
            normalizePrinterFilename(print.filename) === normalizedFilename
          ) {
            if (!claimUnattributedPrint(this, print.id, profileId)) {
              throw new Error("Accepted printer claim history update failed");
            }
          }
        }
        const bindings = parsePrinterPlanBindings(this.getSetting("printer.plan_bindings"));
        const binding = {
          integration_id: claimPrint.integration_id,
          profile_id: profileId,
          updated_at: new Date().toISOString(),
        } satisfies PrinterPlanBinding;
        const bindingIndex = bindings.findIndex((candidate) => candidate.integration_id === claimPrint.integration_id);
        if (bindingIndex >= 0) bindings[bindingIndex] = binding;
        else bindings.push(binding);
        this.setSetting("printer.plan_bindings", JSON.stringify(bindings));
        return { kind: "claimed" as const, link: awaiting, attribution };
      }
      return { kind: "created" as const, link, attribution };
    }, "immediate");
  }

  setAcceptedUnitCompletion(command: SetAcceptedUnitCompletion): SetAcceptedUnitCompletionResult {
    if (!this.syncSqlite) return { kind: "transaction_unavailable" };
    return this.transaction(
      () =>
        setAcceptedUnitCompletionInternal(
          {
            db: this.db,
            schema: this.schema,
            tenantId: this.tenantId,
            reposDir: this.reposDir,
            sqlite: true,
          },
          command,
        ),
      "immediate",
    );
  }

  assignAcceptedFilament(command: AssignAcceptedFilament): AssignAcceptedFilamentResult {
    if (!this.syncSqlite) return { kind: "transaction_unavailable" };
    return this.transaction(() => {
      const result = assignAcceptedFilamentInternal(
        {
          db: this.db,
          schema: this.schema,
          tenantId: this.tenantId,
          reposDir: this.reposDir,
          sqlite: true,
        },
        command,
      );
      if (result.kind === "updated" && command.target.kind === "role") {
        const columns = filamentAssignmentColumns(command.assignment);
        saveRoleFilamentDefault(this, command.expected.profileId, command.target.role, {
          filament_color_id: columns.filamentColorId,
          filament_custom_hex: columns.filamentCustomHex,
          spoolman_spool_id: columns.spoolmanSpoolId,
        });
      }
      return result;
    }, "immediate");
  }

  setAcceptedPrintedCounts(command: {
    readonly expected: AcceptedPlanBasis;
    readonly rows: readonly {
      readonly partId: number;
      readonly printedCount: number;
    }[];
  }): SetAcceptedPrintedCountsResult {
    if (!this.syncSqlite) return { kind: "transaction_unavailable" };
    return this.transaction((): SetAcceptedPrintedCountsResult => {
      const accepted = readAcceptedPlanOperationalSnapshotInternal({
        db: this.db,
        schema: this.schema,
        tenantId: this.tenantId,
        reposDir: this.reposDir,
        sqlite: true,
        profileId: command.expected.profileId,
      });
      if (accepted.kind !== "ready") {
        if (accepted.kind === "empty") return { kind: "stale_accepted_plan" };
        return { kind: "accepted_state_unavailable", reason: accepted.kind };
      }
      const actual = acceptedPlanBasis(accepted.snapshot);
      if (
        actual.profileId !== command.expected.profileId ||
        actual.planVersion !== command.expected.planVersion ||
        actual.revisionId !== command.expected.revisionId ||
        actual.revisionDigest !== command.expected.revisionDigest ||
        actual.requiredUnitMappingDigest !== command.expected.requiredUnitMappingDigest
      ) {
        return { kind: "stale_accepted_plan" };
      }
      if (accepted.snapshot.profile.archivedAt) return { kind: "plan_archived" };
      const partById = new Map(accepted.snapshot.parts.map((part) => [part.projectionPartId, part] as const));
      const seen = new Set<number>();
      for (const row of command.rows) {
        if (seen.has(row.partId) || !Number.isSafeInteger(row.printedCount) || row.printedCount < 0) {
          return { kind: "invalid_rows" };
        }
        seen.add(row.partId);
        const part = partById.get(row.partId);
        if (!part) return { kind: "part_not_found" };
        if (row.printedCount > part.units.length) return { kind: "invalid_rows" };
      }
      const changes = command.rows.map((row) => {
        const part = partById.get(row.partId)!;
        return {
          part,
          changed: part.units.some((unit) => unit.completed !== unit.unitIndex < row.printedCount),
          units: part.units.map((unit) => ({
            unitIndex: unit.unitIndex,
            completed: unit.unitIndex < row.printedCount,
          })),
        };
      });
      let updatedParts = 0;
      for (const change of changes) {
        if (change.changed) updatedParts += 1;
        for (const unit of change.units) {
          this.db
            .update(this.schema.printProgress)
            .set(unit.completed ? { completed: true } : { completed: false, assembled: false })
            .where(
              and(
                eq(this.schema.printProgress.tenantId, this.tenantId),
                eq(this.schema.printProgress.partId, change.part.projectionPartId),
                eq(this.schema.printProgress.unitIndex, unit.unitIndex),
              ),
            )
            .run();
        }
      }
      return { kind: "updated", updatedParts };
    }, "immediate");
  }

  setAcceptedUnitAssembly(command: SetAcceptedUnitAssembly): SetAcceptedUnitAssemblyResult {
    if (!this.syncSqlite) return { kind: "transaction_unavailable" };
    return this.transaction(
      () =>
        setAcceptedUnitAssemblyInternal(
          {
            db: this.db,
            schema: this.schema,
            tenantId: this.tenantId,
            reposDir: this.reposDir,
            sqlite: true,
          },
          command,
        ),
      "immediate",
    );
  }

  archiveAcceptedPlan(command: { readonly expected: AcceptedPlanBasis }): ArchiveAcceptedPlanResult {
    if (!this.syncSqlite) return { kind: "transaction_unavailable" };
    return this.transaction(
      () =>
        archiveAcceptedPlanInternal(
          {
            db: this.db,
            schema: this.schema,
            tenantId: this.tenantId,
            reposDir: this.reposDir,
            sqlite: true,
          },
          command.expected,
        ),
      "immediate",
    );
  }

  verifyAcceptedPrint(command: {
    readonly expected: AcceptedPlanBasis;
    readonly linkId: string;
    readonly expectedLink: PrinterCheckoffLink;
    readonly decisions: readonly AcceptedUnitDecision[];
  }):
    | {
        readonly kind: "verified";
        readonly link: PrinterCheckoffLink;
        readonly unitsConfirmed: number;
        readonly unitsRejected: number;
        readonly outcomes: readonly PrintOutcomeEvent[];
      }
    | AcceptedProgressFailure
    | {
        readonly kind: "link_not_found" | "link_changed" | "not_awaiting_verify" | "invalid_decisions";
      } {
    if (!this.syncSqlite) return { kind: "transaction_unavailable" };
    return this.transaction(() => {
      const current = getPrinterCheckoffLink(this, command.linkId);
      if (!current) return { kind: "link_not_found" as const };
      if (JSON.stringify(current) !== JSON.stringify(command.expectedLink)) {
        return { kind: "link_changed" as const };
      }
      if (current.state !== "awaiting_verify") {
        return { kind: "not_awaiting_verify" as const };
      }
      const pending = new Set(
        current.units
          .filter(
            (unit) =>
              !current.resolved_units?.some(
                (resolved) => resolved.part_id === unit.part_id && resolved.unit_index === unit.unit_index,
              ),
          )
          .map((unit) => `${unit.part_id}:${unit.unit_index}`),
      );
      const applied = applyAcceptedUnitDecisionsInternal(
        {
          db: this.db,
          schema: this.schema,
          tenantId: this.tenantId,
          reposDir: this.reposDir,
          sqlite: true,
        },
        command.expected,
        command.decisions,
        (resolved) => resolved.every((decision) => pending.has(`${decision.partId}:${decision.unitIndex}`)),
      );
      if (applied.kind !== "applied") return applied;
      const resolvedUnits = [
        ...(current.resolved_units ?? []),
        ...applied.decisions.map((decision) => ({
          part_id: decision.partId,
          unit_index: decision.unitIndex,
          result: decision.result,
          ...(decision.result === "rejected" ? { reason: decision.reason } : {}),
          ...(decision.note ? { note: decision.note } : {}),
        })),
      ];
      const resolvedKeys = new Set(resolvedUnits.map((decision) => `${decision.part_id}:${decision.unit_index}`));
      const fullyDone = current.units.every((unit) => resolvedKeys.has(`${unit.part_id}:${unit.unit_index}`));
      const updated = updatePrinterCheckoffLink(
        this,
        current.id,
        {
          resolved_units: resolvedUnits,
          state: fullyDone ? "verified" : "awaiting_verify",
          applied_at: fullyDone ? new Date().toISOString() : current.applied_at,
          units_marked: (current.units_marked ?? 0) + applied.unitsConfirmed,
        },
        { requireState: "awaiting_verify" },
      );
      if (!updated) throw new Error("Accepted printer Checkoff update failed");
      const outcomes = appendPrintOutcomes(
        this,
        applied.decisions.map((decision) => ({
          profile_id: current.profile_id,
          part_id: decision.partId,
          unit_index: decision.unitIndex,
          result: decision.result,
          ...(decision.result === "rejected" ? { reason: decision.reason } : {}),
          note: decision.note,
          host_integration_id: current.integration_id,
          filename: current.filename,
          match_key: decision.matchKey,
          role: decision.role,
          filament_display: undefined,
          link_id: current.id,
        })),
      );
      return {
        kind: "verified" as const,
        link: updated,
        unitsConfirmed: applied.unitsConfirmed,
        unitsRejected: applied.decisions.filter((decision) => decision.result === "rejected").length,
        outcomes,
      };
    }, "immediate");
  }

  readCurrentRequiredUnitSet(profileId: number): ReadCurrentRequiredUnitSetResult {
    const profile = this.db
      .select({
        id: this.schema.buildProfiles.id,
        acceptedPlanRevisionId: this.schema.buildProfiles.acceptedPlanRevisionId,
        acceptedPlanVersion: this.schema.buildProfiles.acceptedPlanVersion,
      })
      .from(this.schema.buildProfiles)
      .where(and(eq(this.schema.buildProfiles.tenantId, this.tenantId), eq(this.schema.buildProfiles.id, profileId)))
      .get();
    if (!profile) throw new Error("Profile not found");
    if (profile.acceptedPlanRevisionId == null) {
      return {
        kind: "unavailable",
        reason: profile.acceptedPlanVersion === 0 ? "no_accepted_revision" : "compatibility_dirty",
      };
    }
    if (profile.acceptedPlanVersion <= 0) {
      throw new Error("Accepted Plan baseline is corrupt");
    }
    return this.readRequiredUnitSetByRevision(profileId, profile.acceptedPlanRevisionId);
  }

  private readRequiredUnitSetByRevision(profileId: number, revisionId: number): ReadCurrentRequiredUnitSetResult {
    const revision = this.db
      .select({ id: this.schema.planRevisions.id })
      .from(this.schema.planRevisions)
      .where(
        and(
          eq(this.schema.planRevisions.id, revisionId),
          eq(this.schema.planRevisions.tenantId, this.tenantId),
          eq(this.schema.planRevisions.profileId, profileId),
        ),
      )
      .get();
    if (!revision) throw new Error("Accepted Plan revision ownership is corrupt");
    const set = this.db
      .select()
      .from(this.schema.planRevisionRequiredUnitSets)
      .where(
        and(
          eq(this.schema.planRevisionRequiredUnitSets.revisionId, revisionId),
          eq(this.schema.planRevisionRequiredUnitSets.tenantId, this.tenantId),
          eq(this.schema.planRevisionRequiredUnitSets.profileId, profileId),
        ),
      )
      .get();
    if (!set) {
      const partialMapping = this.db
        .select({
          token: this.schema.planRevisionRequiredUnits.requiredUnitToken,
        })
        .from(this.schema.planRevisionRequiredUnits)
        .where(
          and(
            eq(this.schema.planRevisionRequiredUnits.tenantId, this.tenantId),
            eq(this.schema.planRevisionRequiredUnits.revisionId, revisionId),
          ),
        )
        .limit(1)
        .get();
      const partialUnit = this.db
        .select({ token: this.schema.requiredUnits.token })
        .from(this.schema.requiredUnits)
        .where(
          and(
            eq(this.schema.requiredUnits.tenantId, this.tenantId),
            eq(this.schema.requiredUnits.profileId, profileId),
            eq(this.schema.requiredUnits.createdInRevisionId, revisionId),
          ),
        )
        .limit(1)
        .get();
      if (partialMapping || partialUnit) {
        throw new Error("Required-unit set is partial");
      }
      return { kind: "unavailable", reason: "uninitialized" };
    }
    if (set.format !== REQUIRED_UNIT_MAP_FORMAT) {
      throw new Error("Required-unit set format is corrupt");
    }
    const parts = this.db
      .select({
        id: this.schema.planRevisionParts.id,
        quantityEffective: this.schema.planRevisionParts.quantityEffective,
        included: this.schema.planRevisionParts.included,
        projectionPartId: this.schema.planRevisionParts.projectionPartId,
      })
      .from(this.schema.planRevisionParts)
      .where(
        and(
          eq(this.schema.planRevisionParts.tenantId, this.tenantId),
          eq(this.schema.planRevisionParts.revisionId, revisionId),
        ),
      )
      .orderBy(asc(this.schema.planRevisionParts.id))
      .all();
    let expectedUnitCount = 0;
    for (const part of parts) {
      if (part.projectionPartId == null) {
        throw new Error("Accepted Plan revision Part has no compatibility projection ID");
      }
      if (
        !Number.isSafeInteger(part.quantityEffective) ||
        part.quantityEffective < 1 ||
        part.quantityEffective > 10_000
      ) {
        throw new Error(`Accepted Plan revision Part ${part.id} has invalid quantity`);
      }
      expectedUnitCount += part.quantityEffective;
    }
    const mappings = this.db
      .select({
        revisionPartId: this.schema.planRevisionRequiredUnits.revisionPartId,
        unitIndex: this.schema.planRevisionRequiredUnits.unitIndex,
        token: this.schema.planRevisionRequiredUnits.requiredUnitToken,
        objectName: this.schema.requiredUnits.objectName,
        completed: this.schema.printProgress.completed,
        assembled: this.schema.printProgress.assembled,
      })
      .from(this.schema.planRevisionRequiredUnits)
      .innerJoin(
        this.schema.requiredUnits,
        and(
          eq(this.schema.requiredUnits.token, this.schema.planRevisionRequiredUnits.requiredUnitToken),
          eq(this.schema.requiredUnits.tenantId, this.tenantId),
          eq(this.schema.requiredUnits.profileId, profileId),
        ),
      )
      .innerJoin(
        this.schema.planRevisionParts,
        and(
          eq(this.schema.planRevisionParts.id, this.schema.planRevisionRequiredUnits.revisionPartId),
          eq(this.schema.planRevisionParts.revisionId, revisionId),
          eq(this.schema.planRevisionParts.tenantId, this.tenantId),
        ),
      )
      .leftJoin(
        this.schema.printProgress,
        and(
          eq(this.schema.printProgress.tenantId, this.tenantId),
          eq(this.schema.printProgress.partId, this.schema.planRevisionParts.projectionPartId),
          eq(this.schema.printProgress.unitIndex, this.schema.planRevisionRequiredUnits.unitIndex),
        ),
      )
      .where(
        and(
          eq(this.schema.planRevisionRequiredUnits.tenantId, this.tenantId),
          eq(this.schema.planRevisionRequiredUnits.revisionId, revisionId),
        ),
      )
      .orderBy(
        asc(this.schema.planRevisionRequiredUnits.revisionPartId),
        asc(this.schema.planRevisionRequiredUnits.unitIndex),
      )
      .all();
    if (set.expectedUnitCount !== expectedUnitCount || mappings.length !== expectedUnitCount) {
      throw new Error("Required-unit set is incomplete");
    }
    const partById = new Map(parts.map((part) => [part.id, part]));
    const nextIndex = new Map<number, number>();
    const units = mappings.map((mapping): RequiredUnitView => {
      const part = partById.get(mapping.revisionPartId);
      const expectedIndex = nextIndex.get(mapping.revisionPartId) ?? 0;
      if (!part || mapping.unitIndex !== expectedIndex || mapping.unitIndex >= part.quantityEffective) {
        throw new Error("Required-unit set is incomplete");
      }
      nextIndex.set(mapping.revisionPartId, expectedIndex + 1);
      parseRequiredUnitToken(mapping.token);
      validateRequiredUnitObjectName(mapping.objectName, mapping.token);
      const completed = mapping.completed ?? false;
      const assembled = mapping.assembled ?? false;
      if (assembled && !completed) {
        throw new Error("Required-unit progress is corrupt");
      }
      return {
        token: mapping.token,
        objectName: mapping.objectName,
        revisionPartId: mapping.revisionPartId,
        unitIndex: mapping.unitIndex,
        required: part.included,
        completed,
        assembled,
      };
    });
    for (const part of parts) {
      if ((nextIndex.get(part.id) ?? 0) !== part.quantityEffective) {
        throw new Error("Required-unit set is incomplete");
      }
    }
    const createdTokens = this.db
      .select({ token: this.schema.requiredUnits.token })
      .from(this.schema.requiredUnits)
      .where(
        and(
          eq(this.schema.requiredUnits.tenantId, this.tenantId),
          eq(this.schema.requiredUnits.profileId, profileId),
          eq(this.schema.requiredUnits.createdInRevisionId, revisionId),
        ),
      )
      .all();
    const mappedTokens = new Set(units.map((unit) => unit.token));
    if (createdTokens.some(({ token }) => !mappedTokens.has(token))) {
      throw new Error("Required-unit set contains an orphan unit");
    }
    const digest = digestRequiredUnitMap({
      revisionId,
      expectedUnitCount,
      rows: units.map((unit) => ({
        revisionPartId: unit.revisionPartId,
        unitIndex: unit.unitIndex,
        token: unit.token,
        objectName: unit.objectName,
      })),
    });
    if (digest !== set.mappingDigest) {
      throw new Error("Required-unit set digest is corrupt");
    }
    return { kind: "ready", revisionId, mappingDigest: digest, units };
  }

  async ping(): Promise<boolean> {
    this.db.select({ key: this.schema.appSettings.key }).from(this.schema.appSettings).limit(1).all();
    return true;
  }

  getSetting(key: string, defaultValue: string | null = null): string | null {
    const row = this.db
      .select()
      .from(this.schema.appSettings)
      .where(and(eq(this.schema.appSettings.tenantId, this.tenantId), eq(this.schema.appSettings.key, key)))
      .all()[0];
    if (!row?.value) return defaultValue;
    return row.value;
  }

  setSetting(key: string, value: string): void {
    this.db
      .insert(this.schema.appSettings)
      .values({ tenantId: this.tenantId, key, value })
      .onConflictDoUpdate({
        target: [this.schema.appSettings.tenantId, this.schema.appSettings.key],
        set: { value },
      })
      .run();
  }

  /**
   * Serialize settings-row RMW mutations.
   * SQLite: native sync transaction. Postgres: in-process queue (sync bridge cannot
   * rebind queries onto an async tx client).
   */
  transaction<T>(fn: () => T, behavior: "deferred" | "immediate" = "deferred"): T {
    if (this.syncSqlite) {
      return this.db.transaction(fn, { behavior });
    }
    return runSerializedSettingsMutation(fn);
  }

  // -------------------------------------------------------------------------
  // Slicer profiles (printer / process / filament) — imported slicer configs.
  // The `resolved_flat_config` column carries the inheritance-resolved flat
  // key/value document the slicer sidecar needs as its settings file.
  // -------------------------------------------------------------------------

  listSlicerPrinterProfiles(): SlicerProfileRow[] {
    return this.db
      .select({
        id: this.schema.printerProfiles.id,
        name: this.schema.printerProfiles.name,
        slicerFormat: this.schema.printerProfiles.slicerFormat,
        resolvedFlatConfig: this.schema.printerProfiles.resolvedFlatConfig,
      })
      .from(this.schema.printerProfiles)
      .where(eq(this.schema.printerProfiles.tenantId, this.tenantId))
      .orderBy(asc(this.schema.printerProfiles.name))
      .all();
  }

  listSlicerProcessProfiles(): SlicerProfileRow[] {
    return this.db
      .select({
        id: this.schema.processProfiles.id,
        name: this.schema.processProfiles.name,
        slicerFormat: this.schema.processProfiles.slicerFormat,
        resolvedFlatConfig: this.schema.processProfiles.resolvedFlatConfig,
      })
      .from(this.schema.processProfiles)
      .where(eq(this.schema.processProfiles.tenantId, this.tenantId))
      .orderBy(asc(this.schema.processProfiles.name))
      .all();
  }

  listSlicerFilamentProfiles(): SlicerProfileRow[] {
    return this.db
      .select({
        id: this.schema.filamentProfiles.id,
        name: this.schema.filamentProfiles.name,
        materialType: this.schema.filamentProfiles.materialType,
        resolvedFlatConfig: this.schema.filamentProfiles.resolvedFlatConfig,
      })
      .from(this.schema.filamentProfiles)
      .where(eq(this.schema.filamentProfiles.tenantId, this.tenantId))
      .orderBy(asc(this.schema.filamentProfiles.name))
      .all()
      .map((r) => ({
        id: r.id,
        name: r.name,
        // filament_profiles carries no slicer_format column — the rows are
        // portable across slicers, so report no dialect rather than
        // mislabelling the material type as one.
        slicerFormat: null,
        materialType: r.materialType,
        resolvedFlatConfig: r.resolvedFlatConfig,
      }));
  }

  // -------------------------------------------------------------------------
  // Profile library (read-only UI) + profile-sync watcher upserts.
  // -------------------------------------------------------------------------

  /** Full profile library for the read-only UI — all three kinds, with sync provenance. */
  listProfileLibrary(): ProfileLibraryRow[] {
    const printers = this.db
      .select({
        id: this.schema.printerProfiles.id,
        name: this.schema.printerProfiles.name,
        slicerFormat: this.schema.printerProfiles.slicerFormat,
        resolvedFlatConfig: this.schema.printerProfiles.resolvedFlatConfig,
        sourcePath: this.schema.printerProfiles.sourcePath,
        syncedFromSlicerVersion: this.schema.printerProfiles.syncedFromSlicerVersion,
        lastSyncedAt: this.schema.printerProfiles.lastSyncedAt,
        importedAt: this.schema.printerProfiles.importedAt,
      })
      .from(this.schema.printerProfiles)
      .where(eq(this.schema.printerProfiles.tenantId, this.tenantId))
      .all()
      .map((r) => ({ ...r, kind: "printer" as const, materialType: null }));

    const processes = this.db
      .select({
        id: this.schema.processProfiles.id,
        name: this.schema.processProfiles.name,
        slicerFormat: this.schema.processProfiles.slicerFormat,
        resolvedFlatConfig: this.schema.processProfiles.resolvedFlatConfig,
        sourcePath: this.schema.processProfiles.sourcePath,
        syncedFromSlicerVersion: this.schema.processProfiles.syncedFromSlicerVersion,
        lastSyncedAt: this.schema.processProfiles.lastSyncedAt,
        importedAt: this.schema.processProfiles.importedAt,
      })
      .from(this.schema.processProfiles)
      .where(eq(this.schema.processProfiles.tenantId, this.tenantId))
      .all()
      .map((r) => ({ ...r, kind: "process" as const, materialType: null }));

    const filaments = this.db
      .select({
        id: this.schema.filamentProfiles.id,
        name: this.schema.filamentProfiles.name,
        materialType: this.schema.filamentProfiles.materialType,
        resolvedFlatConfig: this.schema.filamentProfiles.resolvedFlatConfig,
        sourcePath: this.schema.filamentProfiles.sourcePath,
        syncedFromSlicerVersion: this.schema.filamentProfiles.syncedFromSlicerVersion,
        lastSyncedAt: this.schema.filamentProfiles.lastSyncedAt,
        importedAt: this.schema.filamentProfiles.importedAt,
      })
      .from(this.schema.filamentProfiles)
      .where(eq(this.schema.filamentProfiles.tenantId, this.tenantId))
      .all()
      .map((r) => ({ ...r, kind: "filament" as const, slicerFormat: null }));

    return [...printers, ...processes, ...filaments].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Upsert a printer/machine profile synced from a slicer config volume (identity: tenant + name). */
  upsertSyncedPrinterProfile(input: SyncedPrinterProfileInput): void {
    const now = new Date().toISOString();
    this.db
      .insert(this.schema.printerProfiles)
      .values({
        tenantId: this.tenantId,
        name: input.name,
        slicerFormat: input.slicerFormat,
        slicerVersionAtImport: input.slicerVersion ?? null,
        nozzleDiameterMm: input.nozzleDiameterMm ?? null,
        extruderCount: input.extruderCount ?? 1,
        rawJson: input.rawJson ?? null,
        resolvedFlatConfig: input.resolvedFlatConfig,
        importedAt: now,
        sourcePath: input.sourcePath,
        syncedFromSlicerVersion: input.slicerVersion ?? null,
        lastSyncedAt: now,
      })
      .onConflictDoUpdate({
        target: [this.schema.printerProfiles.tenantId, this.schema.printerProfiles.name],
        set: {
          slicerFormat: input.slicerFormat,
          slicerVersionAtImport: input.slicerVersion ?? null,
          nozzleDiameterMm: input.nozzleDiameterMm ?? null,
          extruderCount: input.extruderCount ?? 1,
          rawJson: input.rawJson ?? null,
          resolvedFlatConfig: input.resolvedFlatConfig,
          sourcePath: input.sourcePath,
          syncedFromSlicerVersion: input.slicerVersion ?? null,
          lastSyncedAt: now,
        },
      })
      .run();
  }

  /** Upsert a process (print settings) profile synced from a slicer config volume. */
  upsertSyncedProcessProfile(input: SyncedProcessProfileInput): void {
    const now = new Date().toISOString();
    this.db
      .insert(this.schema.processProfiles)
      .values({
        tenantId: this.tenantId,
        name: input.name,
        slicerFormat: input.slicerFormat,
        compatiblePrinters: input.compatiblePrinters ?? null,
        resolvedFlatConfig: input.resolvedFlatConfig,
        importedAt: now,
        sourcePath: input.sourcePath,
        syncedFromSlicerVersion: input.slicerVersion ?? null,
        lastSyncedAt: now,
      })
      .onConflictDoUpdate({
        target: [this.schema.processProfiles.tenantId, this.schema.processProfiles.name],
        set: {
          slicerFormat: input.slicerFormat,
          compatiblePrinters: input.compatiblePrinters ?? null,
          resolvedFlatConfig: input.resolvedFlatConfig,
          sourcePath: input.sourcePath,
          syncedFromSlicerVersion: input.slicerVersion ?? null,
          lastSyncedAt: now,
        },
      })
      .run();
  }

  /** Upsert a filament profile synced from a slicer config volume. */
  upsertSyncedFilamentProfile(input: SyncedFilamentProfileInput): void {
    const now = new Date().toISOString();
    this.db
      .insert(this.schema.filamentProfiles)
      .values({
        tenantId: this.tenantId,
        name: input.name,
        materialType: input.materialType,
        materialTier: input.materialTier ?? 1,
        nozzleTempC: input.nozzleTempC ?? null,
        bedTempC: input.bedTempC ?? null,
        fanPct: input.fanPct ?? null,
        extrusionMultiplier: input.extrusionMultiplier ?? null,
        pressureAdvance: input.pressureAdvance ?? null,
        retraction: input.retraction ?? null,
        rawJson: input.rawJson ?? null,
        rawIni: input.rawIni ?? null,
        resolvedFlatConfig: input.resolvedFlatConfig,
        importedAt: now,
        sourcePath: input.sourcePath,
        syncedFromSlicerVersion: input.slicerVersion ?? null,
        lastSyncedAt: now,
      })
      .onConflictDoUpdate({
        target: [this.schema.filamentProfiles.tenantId, this.schema.filamentProfiles.name],
        set: {
          materialType: input.materialType,
          materialTier: input.materialTier ?? 1,
          nozzleTempC: input.nozzleTempC ?? null,
          bedTempC: input.bedTempC ?? null,
          fanPct: input.fanPct ?? null,
          extrusionMultiplier: input.extrusionMultiplier ?? null,
          pressureAdvance: input.pressureAdvance ?? null,
          retraction: input.retraction ?? null,
          rawJson: input.rawJson ?? null,
          rawIni: input.rawIni ?? null,
          resolvedFlatConfig: input.resolvedFlatConfig,
          sourcePath: input.sourcePath,
          syncedFromSlicerVersion: input.slicerVersion ?? null,
          lastSyncedAt: now,
        },
      })
      .run();
  }

  /** Global slicer-printer-name -> PP fleet printer id map (all tenants). */
  listPrinterNameMap(): Array<{ slicerName: string; ppFleetId: string }> {
    return this.db
      .select({
        slicerName: this.schema.printerNameMap.slicerName,
        ppFleetId: this.schema.printerNameMap.ppFleetId,
      })
      .from(this.schema.printerNameMap)
      .all();
  }

  getPrinterProfileAssignment(printerId: string): {
    machineProfileId: number | null;
    profileSource: ProfileSourceMode;
    updatedAt: string;
  } | null {
    const row = this.db
      .select({
        machineProfileId: this.schema.printerProfileAssignments.machineProfileId,
        profileSource: this.schema.printerProfileAssignments.profileSource,
        updatedAt: this.schema.printerProfileAssignments.updatedAt,
      })
      .from(this.schema.printerProfileAssignments)
      .where(
        and(
          eq(this.schema.printerProfileAssignments.tenantId, this.tenantId),
          eq(this.schema.printerProfileAssignments.printerId, printerId),
        ),
      )
      .get();
    if (!row) return null;
    const profileSource = row.profileSource === "assigned" ? "assigned" : "auto_match";
    return {
      machineProfileId: row.machineProfileId ?? null,
      profileSource,
      updatedAt: row.updatedAt,
    };
  }

  listFilamentSlotAssignments(printerId: string): Array<{ slotIndex: number; filamentProfileId: number | null }> {
    return this.db
      .select({
        slotIndex: this.schema.printerFilamentSlotAssignments.slotIndex,
        filamentProfileId: this.schema.printerFilamentSlotAssignments.filamentProfileId,
      })
      .from(this.schema.printerFilamentSlotAssignments)
      .where(
        and(
          eq(this.schema.printerFilamentSlotAssignments.tenantId, this.tenantId),
          eq(this.schema.printerFilamentSlotAssignments.printerId, printerId),
        ),
      )
      .orderBy(asc(this.schema.printerFilamentSlotAssignments.slotIndex))
      .all()
      .map((row) => ({
        slotIndex: row.slotIndex,
        filamentProfileId: row.filamentProfileId ?? null,
      }));
  }

  upsertPrinterProfileAssignment(input: {
    printerId: string;
    machineProfileId: number | null;
    profileSource: ProfileSourceMode;
    filamentSlots: Array<{
      slotIndex: number;
      filamentProfileId: number | null;
    }>;
  }): void {
    if (input.profileSource !== "assigned" && input.profileSource !== "auto_match") {
      throw new Error(`Invalid profile_source: ${String(input.profileSource)}`);
    }
    const now = new Date().toISOString();
    const normalizedSlots = input.filamentSlots
      .filter((slot) => slot.slotIndex >= 1 && slot.slotIndex <= 4)
      .sort((a, b) => a.slotIndex - b.slotIndex);

    this.transaction(() => {
      this.db
        .insert(this.schema.printerProfileAssignments)
        .values({
          printerId: input.printerId,
          tenantId: this.tenantId,
          machineProfileId: input.machineProfileId,
          profileSource: input.profileSource,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: this.schema.printerProfileAssignments.printerId,
          set: {
            machineProfileId: input.machineProfileId,
            profileSource: input.profileSource,
            updatedAt: now,
          },
        })
        .run();

      this.db
        .delete(this.schema.printerFilamentSlotAssignments)
        .where(
          and(
            eq(this.schema.printerFilamentSlotAssignments.tenantId, this.tenantId),
            eq(this.schema.printerFilamentSlotAssignments.printerId, input.printerId),
          ),
        )
        .run();

      for (const slot of normalizedSlots) {
        this.db
          .insert(this.schema.printerFilamentSlotAssignments)
          .values({
            tenantId: this.tenantId,
            printerId: input.printerId,
            slotIndex: slot.slotIndex,
            filamentProfileId: slot.filamentProfileId,
          })
          .run();
      }
    });
  }

  listSlicerInstances(): SlicerInstanceRow[] {
    return this.db
      .select()
      .from(this.schema.slicerInstances)
      .where(eq(this.schema.slicerInstances.tenantId, this.tenantId))
      .orderBy(asc(this.schema.slicerInstances.name))
      .all()
      .map((row) => this.mapSlicerInstance(row));
  }

  getSlicerInstance(id: string): SlicerInstanceRow | null {
    const row = this.db
      .select()
      .from(this.schema.slicerInstances)
      .where(and(eq(this.schema.slicerInstances.tenantId, this.tenantId), eq(this.schema.slicerInstances.id, id)))
      .get();
    return row ? this.mapSlicerInstance(row) : null;
  }

  upsertSlicerInstance(input: {
    id?: string;
    name: string;
    kind: string;
    dialect: string;
    guiUrl?: string;
    watchPath?: string;
    enabled?: boolean;
    dockerTarget?: string;
    dockerHost?: string | null;
    composeService?: string | null;
    image?: string | null;
    containerName?: string | null;
    portsJson?: string;
    volumesJson?: string;
    envJson?: string;
    statusCache?: string;
    statusMessage?: string | null;
  }): SlicerInstanceRow {
    const now = new Date().toISOString();
    const id = input.id?.trim() || `slicer-${crypto.randomUUID()}`;
    const ownedElsewhere = this.db
      .select({
        tenantId: this.schema.slicerInstances.tenantId,
      })
      .from(this.schema.slicerInstances)
      .where(eq(this.schema.slicerInstances.id, id))
      .get();
    if (ownedElsewhere && ownedElsewhere.tenantId !== this.tenantId) {
      throw new Error(`Slicer instance id belongs to another tenant: ${id}`);
    }
    const existing = this.getSlicerInstance(id);
    const enabled = input.enabled ?? existing?.enabled ?? true;
    const values = {
      id,
      tenantId: this.tenantId,
      name: input.name.trim(),
      kind: input.kind,
      dialect: input.dialect,
      guiUrl: input.guiUrl ?? existing?.guiUrl ?? "",
      watchPath: input.watchPath ?? existing?.watchPath ?? "",
      dockerTarget: input.dockerTarget ?? existing?.dockerTarget ?? "local",
      dockerHost: input.dockerHost !== undefined ? input.dockerHost : (existing?.dockerHost ?? null),
      composeService: input.composeService !== undefined ? input.composeService : (existing?.composeService ?? null),
      image: input.image !== undefined ? input.image : (existing?.image ?? null),
      containerName: input.containerName !== undefined ? input.containerName : (existing?.containerName ?? null),
      portsJson: input.portsJson ?? existing?.portsJson ?? "[]",
      volumesJson: input.volumesJson ?? existing?.volumesJson ?? "[]",
      envJson: input.envJson ?? existing?.envJson ?? "{}",
      statusCache: input.statusCache ?? existing?.statusCache ?? "unknown",
      statusMessage: input.statusMessage !== undefined ? input.statusMessage : (existing?.statusMessage ?? null),
      enabled: enabled ? 1 : 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.db
      .insert(this.schema.slicerInstances)
      .values(values)
      .onConflictDoUpdate({
        target: this.schema.slicerInstances.id,
        set: {
          name: values.name,
          kind: values.kind,
          dialect: values.dialect,
          guiUrl: values.guiUrl,
          watchPath: values.watchPath,
          dockerTarget: values.dockerTarget,
          dockerHost: values.dockerHost,
          composeService: values.composeService,
          image: values.image,
          containerName: values.containerName,
          portsJson: values.portsJson,
          volumesJson: values.volumesJson,
          envJson: values.envJson,
          statusCache: values.statusCache,
          statusMessage: values.statusMessage,
          enabled: values.enabled,
          updatedAt: values.updatedAt,
        },
      })
      .run();

    const row = this.getSlicerInstance(id);
    if (!row) throw new Error(`Failed to upsert slicer instance ${id}`);
    return row;
  }

  deleteSlicerInstance(id: string): boolean {
    const existing = this.getSlicerInstance(id);
    if (!existing) return false;
    this.db
      .delete(this.schema.slicerInstances)
      .where(and(eq(this.schema.slicerInstances.tenantId, this.tenantId), eq(this.schema.slicerInstances.id, id)))
      .run();
    return true;
  }

  /**
   * Insert stock Orca/Prusa/Bambu presets when the tenant has zero instances.
   * Returns the number of rows inserted (0 if already seeded).
   */
  seedStockSlicerInstancesIfEmpty(env: NodeJS.ProcessEnv = process.env): number {
    return this.transaction(() => {
      if (this.listSlicerInstances().length > 0) return 0;
      let inserted = 0;
      for (const preset of stockPresets(env)) {
        const docker = dockerPresetsForKind(preset.kind);
        this.upsertSlicerInstance({
          name: preset.name,
          kind: preset.kind,
          dialect: preset.dialect,
          guiUrl: preset.gui_url,
          watchPath: preset.watch_path,
          enabled: true,
          image: docker.image || null,
          containerName: docker.container_name,
          composeService: docker.compose_service,
          portsJson: docker.ports_json,
          volumesJson: docker.volumes_json,
          envJson: docker.env_json,
          dockerTarget: "pp_compose",
        });
        inserted += 1;
      }
      return inserted;
    });
  }

  private mapSlicerInstance(row: typeof defaultSchema.slicerInstances.$inferSelect): SlicerInstanceRow {
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      dialect: row.dialect,
      guiUrl: row.guiUrl,
      watchPath: row.watchPath,
      dockerTarget: row.dockerTarget,
      dockerHost: row.dockerHost ?? null,
      composeService: row.composeService ?? null,
      image: row.image ?? null,
      containerName: row.containerName ?? null,
      portsJson: row.portsJson,
      volumesJson: row.volumesJson,
      envJson: row.envJson,
      statusCache: row.statusCache,
      statusMessage: row.statusMessage ?? null,
      enabled: Boolean(row.enabled),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  getSlicerPrinterProfileById(id: number): (SlicerProfileRow & { lastSyncedAt: string | null }) | null {
    const row = this.db
      .select({
        id: this.schema.printerProfiles.id,
        name: this.schema.printerProfiles.name,
        slicerFormat: this.schema.printerProfiles.slicerFormat,
        resolvedFlatConfig: this.schema.printerProfiles.resolvedFlatConfig,
        lastSyncedAt: this.schema.printerProfiles.lastSyncedAt,
      })
      .from(this.schema.printerProfiles)
      .where(and(eq(this.schema.printerProfiles.tenantId, this.tenantId), eq(this.schema.printerProfiles.id, id)))
      .get();
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      slicerFormat: row.slicerFormat,
      resolvedFlatConfig: row.resolvedFlatConfig,
      lastSyncedAt: row.lastSyncedAt ?? null,
    };
  }

  getSlicerFilamentProfileById(id: number): (SlicerProfileRow & { lastSyncedAt: string | null }) | null {
    const row = this.db
      .select({
        id: this.schema.filamentProfiles.id,
        name: this.schema.filamentProfiles.name,
        materialType: this.schema.filamentProfiles.materialType,
        resolvedFlatConfig: this.schema.filamentProfiles.resolvedFlatConfig,
        lastSyncedAt: this.schema.filamentProfiles.lastSyncedAt,
      })
      .from(this.schema.filamentProfiles)
      .where(and(eq(this.schema.filamentProfiles.tenantId, this.tenantId), eq(this.schema.filamentProfiles.id, id)))
      .get();
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      slicerFormat: null,
      materialType: row.materialType,
      resolvedFlatConfig: row.resolvedFlatConfig,
      lastSyncedAt: row.lastSyncedAt ?? null,
    };
  }

  listSlicerProcessProfilesDetailed(): Array<SlicerProfileRow & { compatiblePrinters: string | null }> {
    return this.db
      .select({
        id: this.schema.processProfiles.id,
        name: this.schema.processProfiles.name,
        slicerFormat: this.schema.processProfiles.slicerFormat,
        resolvedFlatConfig: this.schema.processProfiles.resolvedFlatConfig,
        compatiblePrinters: this.schema.processProfiles.compatiblePrinters,
      })
      .from(this.schema.processProfiles)
      .where(eq(this.schema.processProfiles.tenantId, this.tenantId))
      .orderBy(asc(this.schema.processProfiles.name))
      .all()
      .map((row) => ({
        id: row.id,
        name: row.name,
        slicerFormat: row.slicerFormat,
        resolvedFlatConfig: row.resolvedFlatConfig,
        compatiblePrinters: row.compatiblePrinters ?? null,
      }));
  }

  getGlobalNaming(): StlNamingProfileDict {
    const raw = this.getSetting(STL_NAMING_DEFAULTS_KEY);
    if (!raw) return structuredClone(DEFAULT_NAMING_PROFILE);
    try {
      return validateNamingProfile(JSON.parse(raw));
    } catch {
      return structuredClone(DEFAULT_NAMING_PROFILE);
    }
  }

  saveGlobalNaming(profile: StlNamingProfileDict): StlNamingProfileDict {
    const normalized = validateNamingProfile(profile);
    this.setSetting(STL_NAMING_DEFAULTS_KEY, JSON.stringify(normalized));
    return normalized;
  }

  getSourceNaming(sourceId: number): SourceNamingReadResult {
    const row = this.getProjectRow(sourceId);
    if (!row) return { kind: "source_not_found" };
    const metadata = parseProjectMetadata(row.metadataJson);
    try {
      const { useDefaults, override } = parseSourceNamingMetadataStrict(metadata);
      const effective = resolveNamingProfile(this.getGlobalNaming(), metadata).toDict();
      return {
        kind: "found",
        settings: sourceNamingResponse({
          useDefaults,
          override,
          effective,
        }),
      };
    } catch {
      return { kind: "invalid_state" };
    }
  }

  saveSourceNaming(sourceId: number, input: SourceNamingCommand): SourceNamingSaveResult {
    const naming =
      input.kind === "use_defaults"
        ? { use_defaults: true, override: {} }
        : { use_defaults: false, override: input.profile };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const row = this.getProjectRow(sourceId);
      if (!row) return { kind: "source_not_found" };
      const metadata = parseProjectMetadata(row.metadataJson) ?? {};
      const nextMetadata = { ...metadata, naming };
      const effective = resolveNamingProfile(this.getGlobalNaming(), nextMetadata).toDict();
      const result = this.db
        .update(this.schema.projects)
        .set({ metadataJson: JSON.stringify(nextMetadata) })
        .where(
          and(
            eq(this.schema.projects.tenantId, this.tenantId),
            eq(this.schema.projects.id, sourceId),
            row.metadataJson === null
              ? isNull(this.schema.projects.metadataJson)
              : eq(this.schema.projects.metadataJson, row.metadataJson),
          ),
        )
        .run();
      if (result.changes === 1) {
        return {
          kind: "saved",
          settings: sourceNamingResponse({
            useDefaults: naming.use_defaults,
            override: naming.override,
            effective,
          }),
        };
      }
    }
    return { kind: "conflict" };
  }

  /** Saved categories as a flat, ordered list of "/"-separated paths. */
  getSourceCategories(): string[] {
    return loadSourceCategories(this.getSetting(SOURCE_CATEGORIES_KEY));
  }

  /** The same categories as a nested tree, for rails, menus, and MCP callers. */
  getSourceCategoryTree(): SourceCategoryNode[] {
    return buildSourceCategoryTree(this.getSourceCategories());
  }

  /**
   * Replace the saved category list and move every affected source with it.
   *
   * `replacements` maps an old path to its new path (or `null` to uncategorise)
   * and always wins. Paths with no replacement follow the subtree: a source
   * under a renamed ancestor moves along with it, and a source whose category
   * disappeared falls back to the nearest surviving ancestor before it is
   * uncategorised — deleting "Printers/Frame" leaves its sources under "Printers".
   */
  saveSourceCategories(
    categories: readonly string[],
    replacements: Readonly<Record<string, string | null>> = {},
  ): string[] {
    const normalized = normalizeSourceCategories(categories);
    const previousByKey = new Map(
      this.getSourceCategories().map((category) => [category.toLowerCase(), category]),
    );
    const nextByKey = new Map(
      normalized.map((category) => [category.toLowerCase(), category]),
    );
    const replacementByKey = new Map<string, string | null>();

    for (const [rawSource, rawTarget] of Object.entries(replacements)) {
      const source = previousByKey.get(normalizeCategoryPath(rawSource).toLowerCase());
      if (!source) throw new Error(`Unknown source category: ${rawSource}`);
      if (rawTarget === null) {
        replacementByKey.set(source.toLowerCase(), null);
        continue;
      }
      const target = nextByKey.get(normalizeCategoryPath(rawTarget).toLowerCase());
      if (!target) {
        throw new Error("Replacement category must be in the saved category list");
      }
      if (isCategoryPathWithin(target, source)) {
        throw new Error(`Cannot move “${source}” inside itself`);
      }
      replacementByKey.set(source.toLowerCase(), target);
    }

    /** Where a source sitting at `current` belongs after the save; "" = uncategorised. */
    const nextCategoryFor = (current: string | null): string => {
      if (current === null) return "";
      const key = current.toLowerCase();
      if (replacementByKey.has(key)) return replacementByKey.get(key) ?? "";

      // Deepest replaced ancestor first, so an inner move beats an outer one.
      const ancestors = categoryAncestorPaths(current).reverse();
      for (const ancestor of ancestors) {
        const ancestorKey = ancestor.toLowerCase();
        if (!replacementByKey.has(ancestorKey)) continue;
        const target = replacementByKey.get(ancestorKey) ?? null;
        if (target === null) return "";
        const remainder = categoryPathSegments(current).slice(
          categoryPathSegments(ancestor).length,
        );
        const moved = joinCategoryPath([...categoryPathSegments(target), ...remainder]);
        return nextByKey.get(moved.toLowerCase()) ?? target;
      }

      const kept = nextByKey.get(key);
      if (kept) return kept;
      for (const ancestor of categoryAncestorPaths(current).reverse()) {
        const survivor = nextByKey.get(ancestor.toLowerCase());
        if (survivor) return survivor;
      }
      return "";
    };

    return this.transaction(() => {
      const rows = this.db
        .select()
        .from(this.schema.projects)
        .where(eq(this.schema.projects.tenantId, this.tenantId))
        .all();

      for (const row of rows) {
        const current = resolveSourceCategory(row.metadataJson, row.role);
        const category = nextCategoryFor(current === null ? null : normalizeCategoryPath(current));
        const metadata = parseProjectMetadata(row.metadataJson) ?? {};
        const hasExplicitCategory = Object.prototype.hasOwnProperty.call(metadata, "category");
        const explicitCategory =
          typeof metadata.category === "string" ? metadata.category.trim() : "";
        if (hasExplicitCategory && explicitCategory === category) continue;
        this.db
          .update(this.schema.projects)
          .set({ metadataJson: JSON.stringify({ ...metadata, category }) })
          .where(
            and(
              eq(this.schema.projects.tenantId, this.tenantId),
              eq(this.schema.projects.id, row.id),
            ),
          )
          .run();
      }

      this.setSetting(SOURCE_CATEGORIES_KEY, JSON.stringify(normalized));
      return normalized;
    }, "immediate");
  }

  listSources(): SourceSummary[] {
    const rows = this.db
      .select()
      .from(this.schema.projects)
      .where(eq(this.schema.projects.tenantId, this.tenantId))
      .orderBy(asc(this.schema.projects.name))
      .all();
    const counts = this.docCountByProjectId();
    return rows.map((row) => sourceSummary(row, counts.get(row.id) ?? 0));
  }

  getSource(id: number): SourceSummary | null {
    const row = this.db
      .select()
      .from(this.schema.projects)
      .where(and(eq(this.schema.projects.tenantId, this.tenantId), eq(this.schema.projects.id, id)))
      .get();
    if (!row) return null;
    const counts = this.docCountByProjectId([id]);
    return sourceSummary(row, counts.get(id) ?? 0);
  }

  getPartRow(id: number): PartDbRow | null {
    return (
      this.db
        .select()
        .from(this.schema.parts)
        .where(and(eq(this.schema.parts.tenantId, this.tenantId), eq(this.schema.parts.id, id)))
        .get() ?? null
    );
  }

  /** All raw part rows for a profile (used e.g. for thumbnail regeneration). */
  getProfilePartRows(profileId: number): PartDbRow[] {
    return this.listPartRows(profileId);
  }

  getProjectRow(id: number): ProjectRow | null {
    return (
      this.db
        .select()
        .from(this.schema.projects)
        .where(and(eq(this.schema.projects.tenantId, this.tenantId), eq(this.schema.projects.id, id)))
        .get() ?? null
    );
  }

  recordSourceRevision(input: {
    sourceId: number;
    upstreamRevisionKey: string;
    manifestDigest: string;
    snapshotLocator: string;
    syncedAt: string;
    completeness: string;
  }): SourceRevision {
    if (input.completeness !== "complete") {
      throw new Error("Incomplete sync attempt is not a Source revision");
    }
    if (!this.getProjectRow(input.sourceId)) throw new Error("Source not found");

    const upstreamRevisionKey = requiredText(input.upstreamRevisionKey, "Upstream revision key");
    const digest = sha256Digest(input.manifestDigest, "Manifest digest");
    const snapshotLocator = requiredText(input.snapshotLocator, "Snapshot locator");
    const syncedAt = requiredText(input.syncedAt, "Sync time");
    if (Number.isNaN(Date.parse(syncedAt))) throw new Error("Sync time must be an ISO timestamp");

    const findRegistered = () =>
      this.db
        .select()
        .from(this.schema.sourceRevisions)
        .where(
          and(
            eq(this.schema.sourceRevisions.tenantId, this.tenantId),
            eq(this.schema.sourceRevisions.projectId, input.sourceId),
            eq(this.schema.sourceRevisions.upstreamRevisionKey, upstreamRevisionKey),
          ),
        )
        .get();

    const existing = findRegistered();
    if (existing) {
      if (existing.manifestDigest !== digest || existing.snapshotLocator !== snapshotLocator) {
        throw new Error("Source revision conflict for the upstream revision key");
      }
      return sourceRevision(existing);
    }

    this.db
      .insert(this.schema.sourceRevisions)
      .values({
        tenantId: this.tenantId,
        projectId: input.sourceId,
        upstreamRevisionKey,
        manifestDigest: digest,
        snapshotLocator,
        syncedAt,
        completeness: "complete",
      })
      .onConflictDoNothing()
      .run();

    const registered = findRegistered();
    if (!registered) throw new Error("Source revision could not be registered");
    if (registered.manifestDigest !== digest || registered.snapshotLocator !== snapshotLocator) {
      throw new Error("Source revision conflict for the upstream revision key");
    }
    return sourceRevision(registered);
  }

  getSourceRevision(id: number): SourceRevision | null {
    const row = this.db
      .select()
      .from(this.schema.sourceRevisions)
      .where(and(eq(this.schema.sourceRevisions.tenantId, this.tenantId), eq(this.schema.sourceRevisions.id, id)))
      .get();
    return row ? sourceRevision(row) : null;
  }

  listSourceRevisions(sourceId: number): SourceRevision[] {
    if (!this.getProjectRow(sourceId)) throw new Error("Source not found");
    return this.db
      .select()
      .from(this.schema.sourceRevisions)
      .where(
        and(
          eq(this.schema.sourceRevisions.tenantId, this.tenantId),
          eq(this.schema.sourceRevisions.projectId, sourceId),
        ),
      )
      .orderBy(asc(this.schema.sourceRevisions.id))
      .all()
      .map(sourceRevision);
  }

  activateSourceRevision(input: {
    sourceId: number;
    revisionId: number;
    observed: SourceActivationObservation;
  }): SourceSummary {
    const revision = this.db
      .select()
      .from(this.schema.sourceRevisions)
      .where(
        and(
          eq(this.schema.sourceRevisions.tenantId, this.tenantId),
          eq(this.schema.sourceRevisions.projectId, input.sourceId),
          eq(this.schema.sourceRevisions.id, input.revisionId),
          eq(this.schema.sourceRevisions.completeness, "complete"),
        ),
      )
      .get();
    if (!revision) throw new Error("Source revision not found for source");

    const snapshotLocator = requiredText(revision.snapshotLocator, "Snapshot locator");
    const localPath = resolveStoredSnapshotPath(this.reposDir, snapshotLocator);
    if (!localPath) {
      throw new Error("Snapshot locator must be a canonical storage-relative path");
    }

    const observed = input.observed;
    const current = this.getProjectRow(input.sourceId);
    if (
      current?.currentSourceRevisionId === revision.id &&
      current.url === observed.url &&
      current.branch === observed.branch &&
      current.tag === observed.tag &&
      current.sourceKind === observed.sourceKind &&
      current.sourceType === observed.sourceType &&
      current.localPath === localPath &&
      current.lastCommitSha === revision.upstreamRevisionKey &&
      current.lastSyncedAt === revision.syncedAt
    ) {
      const alreadyActive = this.getSource(input.sourceId);
      if (!alreadyActive) throw new Error("Active Source revision could not be read");
      return alreadyActive;
    }
    const result = this.db
      .update(this.schema.projects)
      .set({
        currentSourceRevisionId: revision.id,
        localPath,
        lastCommitSha: revision.upstreamRevisionKey,
        lastSyncedAt: revision.syncedAt,
      })
      .where(
        and(
          eq(this.schema.projects.tenantId, this.tenantId),
          eq(this.schema.projects.id, input.sourceId),
          observed.currentSourceRevisionId === null
            ? isNull(this.schema.projects.currentSourceRevisionId)
            : eq(this.schema.projects.currentSourceRevisionId, observed.currentSourceRevisionId),
          eq(this.schema.projects.url, observed.url),
          eq(this.schema.projects.branch, observed.branch),
          observed.tag === null ? isNull(this.schema.projects.tag) : eq(this.schema.projects.tag, observed.tag),
          eq(this.schema.projects.sourceKind, observed.sourceKind),
          eq(this.schema.projects.sourceType, observed.sourceType),
          observed.localPath === null
            ? isNull(this.schema.projects.localPath)
            : eq(this.schema.projects.localPath, observed.localPath),
          observed.lastCommitSha === null
            ? isNull(this.schema.projects.lastCommitSha)
            : eq(this.schema.projects.lastCommitSha, observed.lastCommitSha),
        ),
      )
      .run();
    if (result.changes !== 1) {
      throw new Error("Source changed during sync; revision was not activated");
    }

    const activated = this.getSource(input.sourceId);
    if (!activated) throw new Error("Activated Source could not be read");
    return activated;
  }

  markSourceRevisionCurrent(sourceId: number, revisionId: number, checkedAt = new Date().toISOString()): void {
    if (Number.isNaN(Date.parse(checkedAt))) {
      throw new Error("Source update check time must be an ISO timestamp");
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const row = this.getProjectRow(sourceId);
      if (!row || row.currentSourceRevisionId !== revisionId) {
        throw new Error("Source revision is no longer active");
      }
      const metadata = parseProjectMetadata(row.metadataJson) ?? {};
      metadata[REMOTE_UPDATE_STATUS_KEY] = "up_to_date";
      metadata[REMOTE_CHECKED_AT_KEY] = checkedAt;
      const result = this.db
        .update(this.schema.projects)
        .set({ metadataJson: JSON.stringify(metadata) })
        .where(
          and(
            eq(this.schema.projects.tenantId, this.tenantId),
            eq(this.schema.projects.id, sourceId),
            eq(this.schema.projects.currentSourceRevisionId, revisionId),
            row.metadataJson === null
              ? isNull(this.schema.projects.metadataJson)
              : eq(this.schema.projects.metadataJson, row.metadataJson),
          ),
        )
        .run();
      if (result.changes === 1) return;
    }
    throw new Error("Source metadata changed repeatedly while marking revision current");
  }

  private capturePlanInputs(profileId: number, context?: PlanFreshnessContext): CapturedPlanInputs {
    if (!context) this.requireProfile(profileId);
    const layers = context
      ? [...(context.layersByProfile.get(profileId) ?? [])]
      : this.db
          .select()
          .from(this.schema.profileLayers)
          .where(
            and(
              eq(this.schema.profileLayers.tenantId, this.tenantId),
              eq(this.schema.profileLayers.profileId, profileId),
            ),
          )
          .orderBy(asc(this.schema.profileLayers.layerOrder))
          .all();
    const globalNaming = context?.globalNaming ?? this.getGlobalNaming();
    const seenSources = new Set<number>();
    const capturedLayers: CapturedPlanLayer[] = [];

    for (const layer of layers) {
      if (!layer.projectId) continue;
      if (seenSources.has(layer.projectId)) {
        throw new Error("A Source can only be attached to a Plan once");
      }
      seenSources.add(layer.projectId);
      const source = context ? context.sourcesById.get(layer.projectId) : this.getProjectRow(layer.projectId);
      if (!source) throw new Error("Plan Source not found");
      const metadata = parseProjectMetadata(source.metadataJson);
      const { useDefaults, override } = parseSourceNamingMetadataStrict(metadata);
      const namingProfile = (
        useDefaults
          ? namingProfileFromDict(globalNaming)
          : namingProfileFromDict(mergeNamingProfiles(globalNaming, override))
      ).toDict();
      const revision = source.currentSourceRevisionId
        ? context
          ? (context.revisionsById.get(source.currentSourceRevisionId) ?? null)
          : (this.db
              .select()
              .from(this.schema.sourceRevisions)
              .where(
                and(
                  eq(this.schema.sourceRevisions.tenantId, this.tenantId),
                  eq(this.schema.sourceRevisions.id, source.currentSourceRevisionId),
                ),
              )
              .get() ?? null)
        : null;
      if (source.currentSourceRevisionId && (!revision || revision.projectId !== source.id)) {
        throw new Error("Active Source revision not found");
      }
      const localPath = revision
        ? resolveStoredSnapshotPath(this.reposDir, revision.snapshotLocator)
        : source.localPath;
      if (revision && !localPath) {
        throw new Error("Active Source revision has an unsafe snapshot locator");
      }
      const sourceLayer = `${layer.layerType}:${source.name}`;
      const input: CurrentPlanInput = {
        source_id: source.id,
        source_name: source.name,
        source_layer: sourceLayer,
        layer_order: layer.layerOrder,
        tracking_kind: revision ? "revision" : "untracked",
        source_revision_id: revision?.id ?? null,
        manifest_digest: revision?.manifestDigest ?? null,
        effective_naming_digest: digestEffectiveNaming(namingProfile),
      };
      capturedLayers.push({
        layerId: layer.id,
        layerOrder: layer.layerOrder,
        layerType: layer.layerType,
        projectId: source.id,
        sourceName: source.name,
        sourceLayer,
        localPath,
        importRules: importRulesForProject(source.importedPaths),
        namingProfile,
        input,
      });
    }

    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify(
          capturedLayers.map((layer) => ({
            layer_id: layer.layerId,
            layer_order: layer.layerOrder,
            layer_type: layer.layerType,
            project_id: layer.projectId,
            source_name: layer.sourceName,
            local_path: layer.localPath,
            import_rules: layer.importRules,
            input: layer.input,
          })),
        ),
      )
      .digest("hex");
    return {
      fingerprint,
      layers: capturedLayers,
      inputs: capturedLayers.map((layer) => layer.input),
    };
  }

  private currentPlanAttachmentIdentity(profileId: number): Array<{
    readonly sourceId: number;
    readonly sourceLayer: string;
    readonly layerOrder: number;
  }> {
    this.requireProfile(profileId);
    const layers = this.db
      .select()
      .from(this.schema.profileLayers)
      .where(
        and(eq(this.schema.profileLayers.tenantId, this.tenantId), eq(this.schema.profileLayers.profileId, profileId)),
      )
      .orderBy(asc(this.schema.profileLayers.layerOrder))
      .all();
    const sourceIds = new Set<number>();
    const identity: Array<{
      sourceId: number;
      sourceLayer: string;
      layerOrder: number;
    }> = [];
    for (const layer of layers) {
      if (layer.projectId == null) continue;
      if (sourceIds.has(layer.projectId)) {
        throw new Error("A Source can only be attached to a Plan once");
      }
      sourceIds.add(layer.projectId);
      const source = this.getProjectRow(layer.projectId);
      if (!source) throw new Error("Plan Source not found");
      identity.push({
        sourceId: source.id,
        sourceLayer: `${layer.layerType}:${source.name}`,
        layerOrder: layer.layerOrder,
      });
    }
    return identity;
  }

  private validatePlanRevisionInputs(
    profileId: number,
    inputs: readonly PlanRevisionInput[],
  ): ReturnType<typeof canonicalPlanInputs> {
    this.requireProfile(profileId);
    const canonical = canonicalPlanInputs(
      inputs.map((input) => ({
        source_id: input.source_id,
        source_layer: requiredText(input.source_layer, "Source layer"),
        layer_order: input.layer_order,
        tracking_kind: input.tracking_kind,
        source_revision_id: input.source_revision_id,
        manifest_digest: input.manifest_digest == null ? null : sha256Digest(input.manifest_digest, "Manifest digest"),
        effective_naming_digest: sha256Digest(input.effective_naming_digest, "Effective naming digest"),
      })),
    );

    for (let index = 1; index < canonical.length; index += 1) {
      if (canonical[index - 1]!.source_id === canonical[index]!.source_id) {
        throw new Error("Plan revision inputs cannot contain duplicate Sources");
      }
    }
    for (const input of canonical) {
      validateAcceptedOperationalTextRow([
        this.tenantId,
        input.source_layer,
        input.tracking_kind,
        input.manifest_digest,
        input.effective_naming_digest,
      ]);
      const source = this.getSource(input.source_id);
      if (!source) throw new Error("Source not found");
      if (input.tracking_kind === "revision") {
        if (input.source_revision_id == null || input.manifest_digest == null) {
          throw new Error("Tracked Plan input requires a Source revision and manifest digest");
        }
        const revision = this.getSourceRevision(input.source_revision_id);
        if (!revision || revision.source_id !== input.source_id) {
          throw new Error("Source revision not found for Plan input Source");
        }
        if (revision.manifest_digest !== input.manifest_digest) {
          throw new Error("Plan revision input digest does not match the Source revision");
        }
        validateAcceptedOperationalTextRow([
          this.tenantId,
          revision.upstream_revision_key,
          revision.manifest_digest,
          revision.snapshot_locator,
          revision.synced_at,
          revision.completeness,
        ]);
      } else if (input.source_revision_id != null || input.manifest_digest != null) {
        throw new Error("Untracked Plan input cannot carry revision identity");
      }
    }
    return canonical;
  }

  publishPlanRevisionInputs(
    profileId: number,
    inputs: readonly PlanRevisionInput[],
    publishedAt?: string,
  ): PlanRevisionInputSet {
    const canonical = this.validatePlanRevisionInputs(profileId, inputs);

    const inputSetDigest = digestPlanInputs(canonical);
    const recordedAt = publishedAt ?? new Date().toISOString();
    validateAcceptedOperationalTextRow([this.tenantId, inputSetDigest, recordedAt, recordedAt]);
    this.db
      .insert(this.schema.planRevisionInputSets)
      .values({
        tenantId: this.tenantId,
        profileId,
        inputSetDigest,
        expectedInputCount: canonical.length,
        formatVersion: 2,
        recordedAt,
      })
      .onConflictDoNothing()
      .run();

    const setRow = this.db
      .select()
      .from(this.schema.planRevisionInputSets)
      .where(
        and(
          eq(this.schema.planRevisionInputSets.tenantId, this.tenantId),
          eq(this.schema.planRevisionInputSets.profileId, profileId),
          eq(this.schema.planRevisionInputSets.inputSetDigest, inputSetDigest),
        ),
      )
      .get();
    if (!setRow) throw new Error("Plan revision input set could not be created");
    if (setRow.expectedInputCount !== canonical.length || setRow.formatVersion !== 2) {
      throw new Error("Plan revision input set has conflicting content");
    }

    for (const input of canonical) {
      this.db
        .insert(this.schema.planRevisionInputs)
        .values({
          tenantId: this.tenantId,
          inputSetId: setRow.id,
          sourceId: input.source_id,
          sourceLayer: input.source_layer,
          layerOrder: input.layer_order,
          trackingKind: input.tracking_kind,
          sourceRevisionId: input.source_revision_id,
          manifestDigest: input.manifest_digest,
          effectiveNamingDigest: input.effective_naming_digest,
        })
        .onConflictDoNothing()
        .run();
    }

    const storedInputs = this.db
      .select()
      .from(this.schema.planRevisionInputs)
      .where(
        and(
          eq(this.schema.planRevisionInputs.tenantId, this.tenantId),
          eq(this.schema.planRevisionInputs.inputSetId, setRow.id),
        ),
      )
      .orderBy(asc(this.schema.planRevisionInputs.sourceId))
      .all();
    const exactMatch =
      storedInputs.length === canonical.length &&
      storedInputs.every(
        (stored, index) =>
          stored.sourceId === canonical[index]!.source_id &&
          stored.sourceLayer === canonical[index]!.source_layer &&
          stored.layerOrder === canonical[index]!.layer_order &&
          stored.trackingKind === canonical[index]!.tracking_kind &&
          stored.sourceRevisionId === canonical[index]!.source_revision_id &&
          stored.manifestDigest === canonical[index]!.manifest_digest &&
          stored.effectiveNamingDigest === canonical[index]!.effective_naming_digest,
      );
    if (!exactMatch) throw new Error("Plan revision input set has conflicting content");

    if (!setRow.publishedAt) {
      this.db
        .update(this.schema.planRevisionInputSets)
        .set({ publishedAt: publishedAt ?? new Date().toISOString() })
        .where(
          and(
            eq(this.schema.planRevisionInputSets.tenantId, this.tenantId),
            eq(this.schema.planRevisionInputSets.id, setRow.id),
            isNull(this.schema.planRevisionInputSets.publishedAt),
          ),
        )
        .run();
    }
    const published = this.db
      .select()
      .from(this.schema.planRevisionInputSets)
      .where(
        and(
          eq(this.schema.planRevisionInputSets.tenantId, this.tenantId),
          eq(this.schema.planRevisionInputSets.id, setRow.id),
          isNotNull(this.schema.planRevisionInputSets.publishedAt),
        ),
      )
      .get();
    if (!published) throw new Error("Plan revision input set was not published");
    validateAcceptedOperationalTextRow([
      published.tenantId,
      published.inputSetDigest,
      published.recordedAt,
      published.publishedAt,
    ]);
    for (const stored of storedInputs) {
      validateAcceptedOperationalTextRow([
        stored.tenantId,
        stored.sourceLayer,
        stored.trackingKind,
        stored.manifestDigest,
        stored.effectiveNamingDigest,
      ]);
    }
    return this.planRevisionInputSet(published);
  }

  private acceptPlanRevisionInputSet(profileId: number, inputSetId: number, acceptedAt: string): void {
    const inputSet = this.db
      .select()
      .from(this.schema.planRevisionInputSets)
      .where(
        and(
          eq(this.schema.planRevisionInputSets.tenantId, this.tenantId),
          eq(this.schema.planRevisionInputSets.profileId, profileId),
          eq(this.schema.planRevisionInputSets.id, inputSetId),
          isNotNull(this.schema.planRevisionInputSets.publishedAt),
        ),
      )
      .get();
    if (!inputSet || inputSet.formatVersion !== 2) {
      throw new Error("Published Plan input set cannot be accepted");
    }
    this.db
      .insert(this.schema.planAcceptedInputSets)
      .values({
        tenantId: this.tenantId,
        profileId,
        inputSetId,
        acceptedAt,
      })
      .onConflictDoUpdate({
        target: this.schema.planAcceptedInputSets.profileId,
        set: { inputSetId, acceptedAt },
      })
      .run();
  }

  getAcceptedPlanRevisionInputSet(profileId: number): PlanRevisionInputSet | null {
    this.requireProfile(profileId);
    const accepted = this.db
      .select()
      .from(this.schema.planAcceptedInputSets)
      .where(
        and(
          eq(this.schema.planAcceptedInputSets.tenantId, this.tenantId),
          eq(this.schema.planAcceptedInputSets.profileId, profileId),
        ),
      )
      .get();
    if (!accepted) return null;
    const row = this.db
      .select()
      .from(this.schema.planRevisionInputSets)
      .where(
        and(
          eq(this.schema.planRevisionInputSets.tenantId, this.tenantId),
          eq(this.schema.planRevisionInputSets.profileId, profileId),
          eq(this.schema.planRevisionInputSets.id, accepted.inputSetId),
          isNotNull(this.schema.planRevisionInputSets.publishedAt),
        ),
      )
      .get();
    return row ? this.planRevisionInputSet(row) : null;
  }

  getAcceptedProfileStlRoots(profileId: number): Array<{ sourceLayer: string; rootPath: string }> | null {
    const accepted = this.getAcceptedPlanRevisionInputSet(profileId);
    if (!accepted || accepted.format_version !== 2) return null;
    const roots: Array<{
      sourceLayer: string;
      rootPath: string;
      layerOrder: number;
    }> = [];
    for (const input of accepted.inputs) {
      let rootPath: string | null;
      if (input.tracking_kind === "revision" && input.source_revision_id != null) {
        const revision = this.getSourceRevision(input.source_revision_id);
        if (!revision) throw new Error("Accepted Source revision not found");
        rootPath = resolveStoredSnapshotPath(this.reposDir, revision.snapshot_locator);
        if (!rootPath) {
          throw new Error("Accepted Source revision has an unsafe snapshot locator");
        }
      } else {
        rootPath = this.getProjectRow(input.source_id)?.localPath ?? null;
      }
      if (rootPath) {
        roots.push({
          sourceLayer: input.source_layer,
          rootPath,
          layerOrder: input.layer_order,
        });
      }
    }
    return roots
      .sort((left, right) => left.layerOrder - right.layerOrder)
      .map(({ sourceLayer, rootPath }) => ({ sourceLayer, rootPath }));
  }

  getLatestPlanRevisionInputSet(profileId: number): PlanRevisionInputSet | null {
    this.requireProfile(profileId);
    const row = this.db
      .select()
      .from(this.schema.planRevisionInputSets)
      .where(
        and(
          eq(this.schema.planRevisionInputSets.tenantId, this.tenantId),
          eq(this.schema.planRevisionInputSets.profileId, profileId),
          isNotNull(this.schema.planRevisionInputSets.publishedAt),
        ),
      )
      .orderBy(desc(this.schema.planRevisionInputSets.publishedAt), desc(this.schema.planRevisionInputSets.id))
      .limit(1)
      .get();
    return row ? this.planRevisionInputSet(row) : null;
  }

  listPlanRevisionInputSets(profileId: number): PlanRevisionInputSet[] {
    this.requireProfile(profileId);
    return this.db
      .select()
      .from(this.schema.planRevisionInputSets)
      .where(
        and(
          eq(this.schema.planRevisionInputSets.tenantId, this.tenantId),
          eq(this.schema.planRevisionInputSets.profileId, profileId),
          isNotNull(this.schema.planRevisionInputSets.publishedAt),
        ),
      )
      .orderBy(asc(this.schema.planRevisionInputSets.id))
      .all()
      .map((row) => this.planRevisionInputSet(row));
  }

  createSource(input: {
    name: string;
    url?: string;
    branch?: string;
    tag?: string | null;
    source_kind?: string;
    source_type?: string;
    role?: string;
    local_path?: string;
    metadata?: Record<string, unknown>;
  }): SourceSummary {
    const name = input.name.trim();
    if (!name) throw new Error("Source name is required");
    const sourceKind = (input.source_kind ?? "github").toLowerCase();
    const sourceType = input.source_type ?? (sourceKind === "local" ? "local" : "git");
    const existing = this.db
      .select()
      .from(this.schema.projects)
      .where(and(eq(this.schema.projects.tenantId, this.tenantId), eq(this.schema.projects.name, name)))
      .get();
    if (existing) throw new Error(`Source already exists: ${name}`);

    const reposRoot = resolve(this.reposDir);
    let trustedLocalPath: string | null = null;
    if (input.local_path) {
      const candidate = resolve(input.local_path);
      if (candidate.startsWith(reposRoot + sep) || candidate === reposRoot) {
        trustedLocalPath = candidate;
      }
    }

    const localPath = trustedLocalPath;

    const inserted = this.db
      .insert(this.schema.projects)
      .values({
        tenantId: this.tenantId,
        name,
        url: input.url ?? "",
        branch: input.branch ?? "main",
        tag: input.tag?.trim() || null,
        sourceKind,
        sourceType,
        role: input.role ?? "unassigned",
        localPath,
        metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
      })
      .returning()
      .get();

    if (!inserted) throw new Error("Failed to create source");

    const repoPath = join(this.reposDir, String(inserted.id));
    if (!inserted.localPath) {
      this.db
        .update(this.schema.projects)
        .set({ localPath: repoPath })
        .where(eq(this.schema.projects.id, inserted.id))
        .run();
      inserted.localPath = repoPath;
    }

    return sourceSummary(inserted);
  }

  updateSource(
    id: number,
    patch: Partial<{
      name: string;
      url: string;
      branch: string;
      tag: string | null;
      source_kind: string;
      source_type: string;
      role: string;
      local_path: string;
      metadata: Record<string, unknown>;
      manifest_community_slug: string | null;
      last_synced_at: string | null;
      last_commit_sha: string | null;
      localPath: string;
    }>,
  ): SourceSummary {
    const row = this.getProjectRow(id);
    if (!row) throw new Error("Source not found");

    const updates: Partial<typeof this.schema.projects.$inferInsert> = {};
    if (patch.name != null) updates.name = patch.name.trim();
    if (patch.url != null) updates.url = patch.url;
    if (patch.branch != null) updates.branch = patch.branch;
    if (patch.tag !== undefined) updates.tag = patch.tag?.trim() || null;
    if (patch.source_kind != null) updates.sourceKind = patch.source_kind;
    if (patch.source_type != null) updates.sourceType = patch.source_type;
    if (patch.role != null) updates.role = patch.role;
    if (patch.local_path != null) updates.localPath = patch.local_path;
    if (patch.localPath != null) updates.localPath = patch.localPath;
    if (patch.last_synced_at !== undefined) updates.lastSyncedAt = patch.last_synced_at;
    if (patch.last_commit_sha !== undefined) updates.lastCommitSha = patch.last_commit_sha;
    if (patch.metadata != null) {
      const base = parseProjectMetadata(row.metadataJson) ?? {};
      const merged = { ...base, ...patch.metadata };
      // Categories are "/"-separated paths; canonicalize here so every caller
      // (REST, bulk assign, MCP apply, importers) stores the same spelling.
      if (typeof merged.category === "string") {
        merged.category = normalizeCategoryPath(merged.category);
      }
      updates.metadataJson = JSON.stringify(merged);
    }
    if (patch.manifest_community_slug !== undefined) {
      updates.manifestCommunitySlug = patch.manifest_community_slug;
    }

    this.db.update(this.schema.projects).set(updates).where(eq(this.schema.projects.id, id)).run();
    return this.getSource(id)!;
  }

  deleteSource(id: number): void {
    const revision = this.db
      .select({ id: this.schema.sourceRevisions.id })
      .from(this.schema.sourceRevisions)
      .where(
        and(eq(this.schema.sourceRevisions.tenantId, this.tenantId), eq(this.schema.sourceRevisions.projectId, id)),
      )
      .limit(1)
      .get();
    if (revision) {
      throw new Error("Source has immutable revision history; archive it instead");
    }
    this.db
      .delete(this.schema.projects)
      .where(and(eq(this.schema.projects.tenantId, this.tenantId), eq(this.schema.projects.id, id)))
      .run();
  }

  listProfileHeaders(): ProfileHeader[] {
    const rows = this.db
      .select({
        profile: this.schema.buildProfiles,
        partCount: count(this.schema.parts.id),
      })
      .from(this.schema.buildProfiles)
      .leftJoin(this.schema.parts, eq(this.schema.parts.profileId, this.schema.buildProfiles.id))
      .where(eq(this.schema.buildProfiles.tenantId, this.tenantId))
      .groupBy(this.schema.buildProfiles.id)
      .orderBy(asc(this.schema.buildProfiles.name))
      .all();
    const freshnessContext = this.buildPlanFreshnessContext(rows.map(({ profile }) => profile.id));

    return rows.map(({ profile, partCount }) => {
      const freshness = this.planFreshness(profile, freshnessContext);
      return this.toProfileHeader(profile, Number(partCount ?? 0), freshness);
    });
  }

  listAcceptedProfileSummaries(): readonly AcceptedProfileSummary[] {
    const headers = this.listProfileHeaders();
    const summaries: AcceptedProfileSummary[] = [];
    for (let offset = 0; offset < headers.length; offset += MAX_ACCEPTED_PROGRESS_SUMMARY_BATCH) {
      const chunk = headers.slice(offset, offset + MAX_ACCEPTED_PROGRESS_SUMMARY_BATCH);
      const reads = readAcceptedPlanProgressBatch(
        {
          db: this.db,
          schema: this.schema,
          tenantId: this.tenantId,
          sqlite: this.syncSqlite,
        },
        chunk.map(({ id }) => id),
      );
      for (const header of chunk) {
        const read = reads.get(header.id);
        if (!read) throw new Error("Accepted Plan Progress result is missing");
        if (read.kind === "missing") continue;
        summaries.push({ header, progress: acceptedProfileProgress(read) });
      }
    }
    return summaries;
  }

  private buildPlanFreshnessContext(profileIds: readonly number[]): PlanFreshnessContext {
    const layers = profileIds.length
      ? this.db
          .select()
          .from(this.schema.profileLayers)
          .where(
            and(
              eq(this.schema.profileLayers.tenantId, this.tenantId),
              inArray(this.schema.profileLayers.profileId, [...profileIds]),
            ),
          )
          .orderBy(asc(this.schema.profileLayers.layerOrder))
          .all()
      : [];
    const layersByProfile = new Map<number, LayerRow[]>();
    for (const layer of layers) {
      const profileLayers = layersByProfile.get(layer.profileId) ?? [];
      profileLayers.push(layer);
      layersByProfile.set(layer.profileId, profileLayers);
    }

    const sourceIds = [...new Set(layers.flatMap((layer) => (layer.projectId == null ? [] : [layer.projectId])))];
    const sources = sourceIds.length
      ? this.db
          .select()
          .from(this.schema.projects)
          .where(and(eq(this.schema.projects.tenantId, this.tenantId), inArray(this.schema.projects.id, sourceIds)))
          .all()
      : [];
    const sourcesById = new Map(sources.map((source) => [source.id, source]));

    const revisionIds = [
      ...new Set(
        sources.flatMap((source) => (source.currentSourceRevisionId == null ? [] : [source.currentSourceRevisionId])),
      ),
    ];
    const revisions = revisionIds.length
      ? this.db
          .select()
          .from(this.schema.sourceRevisions)
          .where(
            and(
              eq(this.schema.sourceRevisions.tenantId, this.tenantId),
              inArray(this.schema.sourceRevisions.id, revisionIds),
            ),
          )
          .all()
      : [];
    const revisionsById = new Map(revisions.map((revision) => [revision.id, revision]));

    const acceptedRows = profileIds.length
      ? this.db
          .select()
          .from(this.schema.planAcceptedInputSets)
          .where(
            and(
              eq(this.schema.planAcceptedInputSets.tenantId, this.tenantId),
              inArray(this.schema.planAcceptedInputSets.profileId, [...profileIds]),
            ),
          )
          .all()
      : [];
    const inputSetIds = [...new Set(acceptedRows.map((accepted) => accepted.inputSetId))];
    const inputSets = inputSetIds.length
      ? this.db
          .select()
          .from(this.schema.planRevisionInputSets)
          .where(
            and(
              eq(this.schema.planRevisionInputSets.tenantId, this.tenantId),
              inArray(this.schema.planRevisionInputSets.id, inputSetIds),
              isNotNull(this.schema.planRevisionInputSets.publishedAt),
            ),
          )
          .all()
      : [];
    const inputSetsById = new Map(inputSets.map((inputSet) => [inputSet.id, inputSet]));
    const inputRows = inputSetIds.length
      ? this.db
          .select()
          .from(this.schema.planRevisionInputs)
          .where(
            and(
              eq(this.schema.planRevisionInputs.tenantId, this.tenantId),
              inArray(this.schema.planRevisionInputs.inputSetId, inputSetIds),
            ),
          )
          .all()
      : [];
    const inputsBySet = new Map<number, PlanRevisionInput[]>();
    for (const row of inputRows) {
      const inputs = inputsBySet.get(row.inputSetId) ?? [];
      inputs.push({
        source_id: row.sourceId,
        source_layer: row.sourceLayer,
        layer_order: row.layerOrder,
        tracking_kind: planInputTrackingKind(row.trackingKind),
        source_revision_id: row.sourceRevisionId,
        manifest_digest: row.manifestDigest,
        effective_naming_digest: row.effectiveNamingDigest ?? "",
      });
      inputsBySet.set(row.inputSetId, inputs);
    }

    const acceptedByProfile = new Map<number, AcceptedPlanInputIdentity>();
    const invalidProfiles = new Set<number>();
    for (const accepted of acceptedRows) {
      const inputSet = inputSetsById.get(accepted.inputSetId);
      const inputs = canonicalPlanInputs(inputsBySet.get(accepted.inputSetId) ?? []);
      if (!inputSet || inputSet.profileId !== accepted.profileId || inputs.length !== inputSet.expectedInputCount) {
        invalidProfiles.add(accepted.profileId);
      }
      acceptedByProfile.set(accepted.profileId, {
        id: inputSet?.id ?? accepted.inputSetId,
        accepted_at: accepted.acceptedAt,
        format_version: inputSet?.formatVersion ?? 2,
        inputs,
      });
    }

    return {
      globalNaming: this.getGlobalNaming(),
      layersByProfile,
      sourcesById,
      revisionsById,
      acceptedByProfile,
      invalidProfiles,
    };
  }

  private toProfileHeader(
    profile: typeof this.schema.buildProfiles.$inferSelect,
    partCount: number,
    freshness: PlanFreshness,
  ): ProfileHeader {
    return {
      id: profile.id,
      name: profile.name,
      order_number: profile.orderNumber,
      special_request: profile.specialRequest?.trim() ? profile.specialRequest.trim() : null,
      part_count: partCount,
      build_stale: freshness.status === "stale",
      freshness,
      archived_at: profile.archivedAt ?? null,
      last_used_at: profile.lastUsedAt ?? null,
    };
  }

  private isProfileStale(profile: { configModifiedAt: string | null; lastRecomputedAt: string | null }): boolean {
    if (!profile.lastRecomputedAt) return true;
    if (!profile.configModifiedAt) return false;
    return profile.configModifiedAt > profile.lastRecomputedAt;
  }

  private planFreshness(profile: ProfileRow, providedContext?: PlanFreshnessContext): PlanFreshness {
    const context = providedContext ?? this.buildPlanFreshnessContext([profile.id]);
    const accepted = context.acceptedByProfile.get(profile.id) ?? null;
    let currentInputs: readonly CurrentPlanInput[] = [];
    let inputsInvalid = context.invalidProfiles.has(profile.id);
    try {
      currentInputs = this.capturePlanInputs(profile.id, context).inputs;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message !== "A Source can only be attached to a Plan once" &&
        message !== "Plan Source not found" &&
        message !== "Active Source revision not found"
      ) {
        throw error;
      }
      inputsInvalid = true;
    }
    return evaluatePlanFreshness({
      accepted,
      current: currentInputs,
      configurationChanged: this.isProfileStale(profile),
      inputsInvalid,
    });
  }

  markProfileConfigModified(profileId: number): void {
    const now = new Date().toISOString();
    this.db
      .update(this.schema.buildProfiles)
      .set({ configModifiedAt: now })
      .where(and(eq(this.schema.buildProfiles.tenantId, this.tenantId), eq(this.schema.buildProfiles.id, profileId)))
      .run();
  }

  markProfilesUsingProjectStale(projectId: number): void {
    const layers = this.db
      .select({ profileId: this.schema.profileLayers.profileId })
      .from(this.schema.profileLayers)
      .where(
        and(eq(this.schema.profileLayers.tenantId, this.tenantId), eq(this.schema.profileLayers.projectId, projectId)),
      )
      .all();
    const seen = new Set<number>();
    for (const layer of layers) {
      if (seen.has(layer.profileId)) continue;
      seen.add(layer.profileId);
      this.markProfileConfigModified(layer.profileId);
    }
  }

  touchLastRecomputed(profileId: number, now = new Date().toISOString()): void {
    this.db
      .update(this.schema.buildProfiles)
      .set({ lastRecomputedAt: now })
      .where(and(eq(this.schema.buildProfiles.tenantId, this.tenantId), eq(this.schema.buildProfiles.id, profileId)))
      .run();
  }

  getProfileHeader(id: number): ProfileHeader | null {
    const profile = this.db
      .select()
      .from(this.schema.buildProfiles)
      .where(and(eq(this.schema.buildProfiles.tenantId, this.tenantId), eq(this.schema.buildProfiles.id, id)))
      .get();
    if (!profile) return null;
    const partCount = this.db
      .select({ c: count() })
      .from(this.schema.parts)
      .where(eq(this.schema.parts.profileId, id))
      .get();
    return this.toProfileHeader(profile, Number(partCount?.c ?? 0), this.planFreshness(profile));
  }

  readAcceptedProfileSummary(profileId: number): ReadAcceptedProfileSummary {
    const header = this.getProfileHeader(profileId);
    if (!header) return { kind: "missing" };
    const read = readAcceptedPlanProgressBatch(
      {
        db: this.db,
        schema: this.schema,
        tenantId: this.tenantId,
        sqlite: this.syncSqlite,
      },
      [profileId],
    ).get(profileId);
    if (!read) throw new Error("Accepted Plan Progress result is missing");
    if (read.kind === "missing") return { kind: "missing" };
    return {
      kind: "found",
      summary: { header, progress: acceptedProfileProgress(read) },
    };
  }

  getOwnedProfileIdentity(id: number): OwnedProfileIdentity | null {
    return (
      this.db
        .select({
          id: this.schema.buildProfiles.id,
          name: this.schema.buildProfiles.name,
          orderNumber: this.schema.buildProfiles.orderNumber,
          archivedAt: this.schema.buildProfiles.archivedAt,
        })
        .from(this.schema.buildProfiles)
        .where(and(eq(this.schema.buildProfiles.tenantId, this.tenantId), eq(this.schema.buildProfiles.id, id)))
        .get() ?? null
    );
  }

  getAcceptedPlanRevision(profileId: number): AcceptedPlanRevision | null {
    const profile = this.db
      .select({
        revisionId: this.schema.buildProfiles.acceptedPlanRevisionId,
        planVersion: this.schema.buildProfiles.acceptedPlanVersion,
      })
      .from(this.schema.buildProfiles)
      .where(and(eq(this.schema.buildProfiles.tenantId, this.tenantId), eq(this.schema.buildProfiles.id, profileId)))
      .get();
    if (!profile?.revisionId) return null;
    return this.getPlanRevisionById(profileId, profile.revisionId, profile.planVersion);
  }

  private getPlanRevisionById(profileId: number, revisionId: number, planVersion: number): AcceptedPlanRevision {
    const revision = this.db
      .select()
      .from(this.schema.planRevisions)
      .where(
        and(
          eq(this.schema.planRevisions.tenantId, this.tenantId),
          eq(this.schema.planRevisions.profileId, profileId),
          eq(this.schema.planRevisions.id, revisionId),
        ),
      )
      .get();
    if (!revision) {
      throw new Error("Accepted Plan revision is missing");
    }
    const identity = acceptedPlanRevisionIdentity(revision);
    const parts = this.db
      .select()
      .from(this.schema.planRevisionParts)
      .where(
        and(
          eq(this.schema.planRevisionParts.tenantId, this.tenantId),
          eq(this.schema.planRevisionParts.revisionId, revision.id),
        ),
      )
      .orderBy(asc(this.schema.planRevisionParts.filename), asc(this.schema.planRevisionParts.id))
      .all()
      .map((part) => ({
        ...part,
        effectiveRole: part.roleOverride ?? part.roleInferred,
        effectiveQuantity: part.quantityEffective,
      }));
    return { ...identity, planVersion, parts };
  }

  getAcceptedPlanPartRows(profileId: number): PartRow[] | null {
    const revision = this.getAcceptedPlanRevision(profileId);
    return revision?.parts.map(acceptedRevisionPartRow) ?? null;
  }

  private planDraftOrigin(row: PlanDraftRow): PlanDraftSnapshot["origin"] {
    if (
      row.rebasedFromDraftId == null &&
      row.rebasedFromLifecycleVersion == null &&
      row.rebasedFromSnapshotDigest == null
    ) {
      return { kind: "recompute" };
    }
    if (
      row.rebasedFromDraftId != null &&
      row.rebasedFromLifecycleVersion != null &&
      row.rebasedFromSnapshotDigest != null
    ) {
      return {
        kind: "rebase",
        sourceDraftId: row.rebasedFromDraftId,
        sourceLifecycleVersion: row.rebasedFromLifecycleVersion,
        sourceSnapshotDigest: row.rebasedFromSnapshotDigest,
      };
    }
    throw new Error("Plan draft rebase origin is invalid");
  }

  getPlanDraft(profileId: number, draftId: number): PlanDraftSnapshot | null {
    this.requireProfile(profileId);
    const row = this.db
      .select()
      .from(this.schema.planDrafts)
      .where(
        and(
          eq(this.schema.planDrafts.tenantId, this.tenantId),
          eq(this.schema.planDrafts.profileId, profileId),
          eq(this.schema.planDrafts.id, draftId),
        ),
      )
      .get();
    if (!row) return null;
    const inputs = this.db
      .select()
      .from(this.schema.planDraftInputs)
      .where(
        and(eq(this.schema.planDraftInputs.tenantId, this.tenantId), eq(this.schema.planDraftInputs.draftId, draftId)),
      )
      .orderBy(asc(this.schema.planDraftInputs.layerOrder), asc(this.schema.planDraftInputs.sourceId))
      .all();
    const parts = this.db
      .select()
      .from(this.schema.planDraftParts)
      .where(
        and(eq(this.schema.planDraftParts.tenantId, this.tenantId), eq(this.schema.planDraftParts.draftId, draftId)),
      )
      .orderBy(asc(this.schema.planDraftParts.id))
      .all();
    const selectedReconciliation =
      row.currentRequiredUnitReconciliationId == null
        ? null
        : this.db
            .select({
              id: this.schema.planDraftRequiredUnitReconciliations.id,
              tenantId: this.schema.planDraftRequiredUnitReconciliations.tenantId,
              profileId: this.schema.planDraftRequiredUnitReconciliations.profileId,
              draftId: this.schema.planDraftRequiredUnitReconciliations.draftId,
              finalizedAt: this.schema.planDraftRequiredUnitReconciliations.finalizedAt,
            })
            .from(this.schema.planDraftRequiredUnitReconciliations)
            .where(eq(this.schema.planDraftRequiredUnitReconciliations.id, row.currentRequiredUnitReconciliationId))
            .get();
    if (
      row.currentRequiredUnitReconciliationId != null &&
      (!selectedReconciliation ||
        selectedReconciliation.tenantId !== this.tenantId ||
        selectedReconciliation.profileId !== profileId ||
        selectedReconciliation.draftId !== draftId ||
        selectedReconciliation.finalizedAt == null)
    ) {
      throw new Error("Plan draft Required-unit selection is corrupt");
    }
    const verifiedReconciliation = selectedReconciliation
      ? this.readSavedRequiredUnitReconciliation(selectedReconciliation.id)
      : null;
    const draft: PlanDraftSnapshot = {
      id: row.id,
      profileId: row.profileId,
      baseRevisionId: row.baseRevisionId,
      basePlanVersion: row.basePlanVersion,
      state: row.state,
      lifecycleVersion: row.lifecycleVersion,
      consumedRevisionId: row.consumedRevisionId,
      consumedAt: row.consumedAt,
      origin: this.planDraftOrigin(row),
      digestFormat: row.digestFormat,
      snapshotDigest: row.snapshotDigest,
      createdBy: row.createdBy,
      idempotencyKey: row.idempotencyKey,
      createdAt: row.createdAt,
      requiredUnitReconciliation: verifiedReconciliation
        ? {
            id: verifiedReconciliation.id,
            format: verifiedReconciliation.format,
            digest: verifiedReconciliation.reconciliationDigest,
          }
        : null,
      inputs: inputs.map((input) => ({
        id: input.id,
        draftId: input.draftId,
        sourceId: input.sourceId,
        sourceLayer: input.sourceLayer,
        layerOrder: input.layerOrder,
        trackingKind: input.trackingKind,
        sourceRevisionId: input.sourceRevisionId,
        manifestDigest: input.manifestDigest,
        effectiveNamingDigest: input.effectiveNamingDigest,
      })),
      parts: parts.map((part) => ({
        id: part.id,
        draftId: part.draftId,
        baseRevisionPartId: part.baseRevisionPartId,
        partKey: part.partKey,
        relativePath: part.relativePath,
        filename: part.filename,
        sourceLayer: part.sourceLayer,
        status: part.status,
        roleInferred: part.roleInferred,
        roleOverride: part.roleOverride,
        filamentColorId: part.filamentColorId,
        filamentCustomHex: part.filamentCustomHex,
        spoolmanSpoolId: part.spoolmanSpoolId,
        quantityInferred: part.quantityInferred,
        quantityOverride: part.quantityOverride,
        quantityEffective: part.quantityEffective,
        included: part.included,
        notes: part.notes,
        githubBlobUrl: part.githubBlobUrl,
        geometrySame: part.geometrySame,
        requirement: part.requirement,
        optionGroupId: part.optionGroupId,
        manifestSource: part.manifestSource,
        artifactDigest: part.artifactDigest,
      })),
    };
    const planningDigest = digestPlanDraft(draft);
    const digest =
      draft.digestFormat === PLAN_DRAFT_DIGEST_FORMAT
        ? planningDigest
        : draft.digestFormat === PLAN_DRAFT_SELECTION_DIGEST_FORMAT
          ? digestPlanDraftSelection({
              planningDigest,
              requiredUnitReconciliation: draft.requiredUnitReconciliation
                ? {
                    format: draft.requiredUnitReconciliation.format,
                    digest: draft.requiredUnitReconciliation.digest,
                  }
                : null,
            })
          : null;
    if (digest == null) throw new Error("Plan draft digest format is unsupported");
    if (draft.digestFormat === PLAN_DRAFT_DIGEST_FORMAT && draft.requiredUnitReconciliation != null) {
      throw new Error("Plan draft v1 cannot select a Required-unit reconciliation");
    }
    if (digest !== draft.snapshotDigest) throw new Error("Plan draft snapshot digest mismatch");
    return draft;
  }

  listPlanDrafts(profileId: number): PlanDraftSnapshot[] {
    this.requireProfile(profileId);
    return this.db
      .select({ id: this.schema.planDrafts.id })
      .from(this.schema.planDrafts)
      .where(and(eq(this.schema.planDrafts.tenantId, this.tenantId), eq(this.schema.planDrafts.profileId, profileId)))
      .orderBy(asc(this.schema.planDrafts.createdAt), asc(this.schema.planDrafts.id))
      .all()
      .map((row) => this.getPlanDraft(profileId, row.id))
      .filter((draft): draft is PlanDraftSnapshot => draft != null);
  }

  private planDraftNeedsAcceptedBaseline(
    profileId: number,
    base: { baseRevisionId: number | null; basePlanVersion: number },
  ): boolean {
    if (base.baseRevisionId == null && base.basePlanVersion !== 0) return true;
    if (base.baseRevisionId != null && base.basePlanVersion <= 0) return true;
    if (base.baseRevisionId != null) return false;
    return Boolean(
      this.db
        .select({ id: this.schema.parts.id })
        .from(this.schema.parts)
        .where(and(eq(this.schema.parts.tenantId, this.tenantId), eq(this.schema.parts.profileId, profileId)))
        .limit(1)
        .get(),
    );
  }

  private preparePlanDraft(
    profileId: number,
    base: {
      readonly baseRevisionId: number | null;
      readonly basePlanVersion: number;
    },
    excludedPathsBySourceId?: ReadonlyMap<number, ReadonlySet<string>>,
    includedPathsBySourceId?: ReadonlyMap<number, ReadonlySet<string>>,
  ): PreparePlanDraftResult {
    const accepted =
      base.baseRevisionId == null
        ? null
        : this.getPlanRevisionById(profileId, base.baseRevisionId, base.basePlanVersion);
    const capture = this.capturePlanInputs(profileId);
    const acceptedByKey = new Map<string, AcceptedPlanRevisionPart>();
    for (const part of [...(accepted?.parts ?? [])].sort((left, right) => left.id - right.id)) {
      if (!acceptedByKey.has(part.partKey)) acceptedByKey.set(part.partKey, part);
    }
    const existingParts: Record<string, MergePart> = {};
    for (const part of acceptedByKey.values()) {
      existingParts[part.partKey] = {
        matchKey: part.partKey,
        relativePath: part.relativePath,
        filename: part.filename,
        sourceLayer: part.sourceLayer,
        status: part.status,
        role: part.roleOverride ?? part.roleInferred,
        quantityAuto: part.quantityInferred,
        partSlug: part.filename,
        included: part.included,
        quantityOverride: part.quantityOverride,
        notes: part.notes,
        geometrySame: part.geometrySame,
        absolutePath: null,
      };
    }
    const scans: Array<[string, ReturnType<typeof scanRepo>]> = [];
    for (const layer of capture.layers) {
      if (!layer.localPath) continue;
      const excludedPaths = excludedPathsBySourceId?.get(layer.projectId);
      const includedPaths = includedPathsBySourceId?.get(layer.projectId);
      scans.push([
        layer.sourceLayer,
        scanRepo(
          layer.localPath,
          layer.sourceLayer,
          layer.importRules,
          resolveNamingProfile(layer.namingProfile, null),
        ).filter(
          (part) =>
            !excludedPaths?.has(part.relativePath) &&
            (!includedPaths || matchesPlanningPathScope(part.relativePath, includedPaths)),
        ),
      ]);
    }
    if (!scans.length) return { kind: "no_layers" };
    if (scans.every(([, rows]) => rows.length === 0)) return { kind: "no_stls" };
    let merged: ReturnType<typeof mergeLayers>;
    try {
      merged = mergeLayers(scans, existingParts, { geometryCompare: false });
      if (!merged.parts.length && (accepted?.parts.length ?? 0) > 0) {
        throw new MergeWouldWipeProfileError("Scan found no STL files");
      }
    } catch (error) {
      if (error instanceof MergeWouldWipeProfileError) return { kind: "would_wipe" };
      throw error;
    }
    const roleDefaults = loadRoleFilamentDefaults(this, profileId);
    const draftInputs: PlanSnapshotInput[] = capture.inputs.map((captured) => ({
      sourceId: captured.source_id,
      sourceLayer: captured.source_layer,
      layerOrder: captured.layer_order,
      trackingKind: captured.tracking_kind,
      sourceRevisionId: captured.source_revision_id,
      manifestDigest: captured.manifest_digest,
      effectiveNamingDigest: captured.effective_naming_digest,
    }));
    const trackingBySourceLayer = new Map(draftInputs.map((captured) => [captured.sourceLayer, captured.trackingKind]));
    const scannedDraftParts = merged.parts.map(
      (
        part,
      ): PlanSnapshotPart & {
        baseRevisionPartId: number | null;
      } => {
        const prior = acceptedByKey.get(part.matchKey);
        const defaults = roleDefaults[normalizePartRole(part.role)];
        const editableBaseline = prior ?? newPlanDraftPartDecisionBaseline();
        const quantityOverride = editableBaseline.quantityOverride;
        const trackingKind = trackingBySourceLayer.get(part.sourceLayer);
        if (!trackingKind) throw new Error("Draft Part Source layer is not captured");
        let artifactDigest: string | null = null;
        if (trackingKind === "revision") {
          if (!part.absolutePath) throw new Error("Tracked draft Part has no STL path");
          artifactDigest = sha256File(part.absolutePath);
        }
        return {
          baseRevisionPartId: prior?.id ?? null,
          partKey: part.matchKey,
          relativePath: part.relativePath,
          filename: part.filename,
          sourceLayer: part.sourceLayer,
          status: part.status,
          roleInferred: part.role,
          roleOverride: prior?.roleOverride ?? null,
          filamentColorId: prior ? prior.filamentColorId : (defaults?.filament_color_id ?? null),
          filamentCustomHex: prior ? prior.filamentCustomHex : (defaults?.filament_custom_hex ?? null),
          spoolmanSpoolId: prior ? prior.spoolmanSpoolId : (defaults?.spoolman_spool_id ?? null),
          quantityInferred: part.quantityAuto,
          quantityOverride,
          quantityEffective: quantityOverride ?? part.quantityAuto,
          included: editableBaseline.included,
          notes: part.notes,
          githubBlobUrl: prior?.githubBlobUrl ?? null,
          geometrySame: prior?.geometrySame ?? part.geometrySame,
          requirement: prior?.requirement ?? null,
          optionGroupId: prior?.optionGroupId ?? null,
          manifestSource: prior?.manifestSource ?? null,
          artifactDigest,
        };
      },
    );
    const draftParts = applyManifestToDraftParts(this, profileId, scannedDraftParts);
    return {
      kind: "prepared",
      value: {
        baseRevisionId: base.baseRevisionId,
        basePlanVersion: base.basePlanVersion,
        capture,
        inputs: draftInputs,
        parts: draftParts,
        snapshotDigest: digestPlanDraft({
          baseRevisionId: base.baseRevisionId,
          basePlanVersion: base.basePlanVersion,
          inputs: draftInputs,
          parts: draftParts,
        }),
      },
    };
  }

  private rebaseAcceptedParts(profileId: number, revisionId: number | null): RebaseAcceptedPart[] {
    if (revisionId == null) return [];
    const revision = this.db
      .select({ id: this.schema.planRevisions.id })
      .from(this.schema.planRevisions)
      .where(
        and(
          eq(this.schema.planRevisions.tenantId, this.tenantId),
          eq(this.schema.planRevisions.profileId, profileId),
          eq(this.schema.planRevisions.id, revisionId),
        ),
      )
      .get();
    if (!revision) throw new Error("Plan draft base revision is missing");
    return this.db
      .select()
      .from(this.schema.planRevisionParts)
      .where(
        and(
          eq(this.schema.planRevisionParts.tenantId, this.tenantId),
          eq(this.schema.planRevisionParts.revisionId, revisionId),
        ),
      )
      .orderBy(asc(this.schema.planRevisionParts.id))
      .all()
      .map((part) => ({
        id: part.id,
        projectionPartId: part.projectionPartId,
        partKey: part.partKey,
        relativePath: part.relativePath,
        filename: part.filename,
        sourceLayer: part.sourceLayer,
        status: part.status,
        roleInferred: part.roleInferred,
        roleOverride: part.roleOverride,
        filamentColorId: part.filamentColorId,
        filamentCustomHex: part.filamentCustomHex,
        spoolmanSpoolId: part.spoolmanSpoolId,
        quantityInferred: part.quantityInferred,
        quantityOverride: part.quantityOverride,
        quantityEffective: part.quantityEffective,
        included: part.included,
        notes: part.notes,
        githubBlobUrl: part.githubBlobUrl,
        geometrySame: part.geometrySame,
        requirement: part.requirement,
        optionGroupId: part.optionGroupId,
        manifestSource: part.manifestSource,
        artifactDigest: part.artifactDigest,
      }));
  }

  recomputePlanDraft(input: {
    profileId: number;
    actor: string;
    idempotencyKey: string;
    excludedPathsBySourceId?: ReadonlyMap<number, ReadonlySet<string>>;
    includedPathsBySourceId?: ReadonlyMap<number, ReadonlySet<string>>;
  }): RecomputePlanDraftResult {
    const actor = requiredText(input.actor, "Plan draft actor");
    const idempotencyKey = requiredText(input.idempotencyKey, "Plan draft idempotency key");
    this.requireProfile(input.profileId);
    const existing = this.db
      .select({ id: this.schema.planDrafts.id })
      .from(this.schema.planDrafts)
      .where(
        and(
          eq(this.schema.planDrafts.tenantId, this.tenantId),
          eq(this.schema.planDrafts.profileId, input.profileId),
          eq(this.schema.planDrafts.createdBy, actor),
          eq(this.schema.planDrafts.idempotencyKey, idempotencyKey),
        ),
      )
      .get();
    if (existing) {
      const draft = this.getPlanDraft(input.profileId, existing.id);
      if (!draft) throw new Error("Saved Plan draft is missing");
      if (draft.origin.kind !== "recompute") return { kind: "idempotency_conflict" };
      return { kind: "existing", draft };
    }

    if (!this.syncSqlite) return { kind: "transaction_unavailable" };
    const profile = this.db
      .select({
        baseRevisionId: this.schema.buildProfiles.acceptedPlanRevisionId,
        basePlanVersion: this.schema.buildProfiles.acceptedPlanVersion,
      })
      .from(this.schema.buildProfiles)
      .where(
        and(eq(this.schema.buildProfiles.tenantId, this.tenantId), eq(this.schema.buildProfiles.id, input.profileId)),
      )
      .get();
    if (!profile) throw new Error("Profile not found");
    if (this.planDraftNeedsAcceptedBaseline(input.profileId, profile)) {
      return { kind: "accepted_baseline_required" };
    }
    const preparation = this.preparePlanDraft(
      input.profileId,
      profile,
      input.excludedPathsBySourceId,
      input.includedPathsBySourceId,
    );
    if (preparation.kind !== "prepared") return preparation;
    const prepared = preparation.value;

    const writeResult = this.transaction(
      ():
        | { kind: "created"; draftId: number }
        | { kind: "existing"; draftId: number }
        | { kind: "accepted_baseline_required" }
        | { kind: "base_changed" }
        | { kind: "inputs_changed" }
        | { kind: "idempotency_conflict" } => {
        const concurrentWinner = this.db
          .select({ id: this.schema.planDrafts.id })
          .from(this.schema.planDrafts)
          .where(
            and(
              eq(this.schema.planDrafts.tenantId, this.tenantId),
              eq(this.schema.planDrafts.profileId, input.profileId),
              eq(this.schema.planDrafts.createdBy, actor),
              eq(this.schema.planDrafts.idempotencyKey, idempotencyKey),
            ),
          )
          .get();
        if (concurrentWinner) {
          const winner = this.getPlanDraft(input.profileId, concurrentWinner.id);
          if (!winner) throw new Error("Saved Plan draft is missing");
          return winner.origin.kind === "recompute"
            ? { kind: "existing", draftId: concurrentWinner.id }
            : { kind: "idempotency_conflict" };
        }
        const currentProfile = this.db
          .select({
            baseRevisionId: this.schema.buildProfiles.acceptedPlanRevisionId,
            basePlanVersion: this.schema.buildProfiles.acceptedPlanVersion,
          })
          .from(this.schema.buildProfiles)
          .where(
            and(
              eq(this.schema.buildProfiles.tenantId, this.tenantId),
              eq(this.schema.buildProfiles.id, input.profileId),
            ),
          )
          .get();
        if (!currentProfile) return { kind: "base_changed" };
        if (this.planDraftNeedsAcceptedBaseline(input.profileId, currentProfile)) {
          return { kind: "accepted_baseline_required" };
        }
        if (
          currentProfile.baseRevisionId !== profile.baseRevisionId ||
          currentProfile.basePlanVersion !== profile.basePlanVersion
        ) {
          return { kind: "base_changed" };
        }
        if (this.capturePlanInputs(input.profileId).fingerprint !== prepared.capture.fingerprint) {
          return { kind: "inputs_changed" };
        }
        // A recompute supersedes any older open draft. Leaving them open
        // strands the Plan sheet after the newer draft is applied: the sheet
        // falls back to the stale survivor, whose base version can never
        // match again, and every edit 409s. Abandoned drafts stay resumable
        // while their base still matches.
        this.db
          .update(this.schema.planDrafts)
          .set({
            state: "abandoned",
            lifecycleVersion: sql`${this.schema.planDrafts.lifecycleVersion} + 1`,
          })
          .where(
            and(
              eq(this.schema.planDrafts.tenantId, this.tenantId),
              eq(this.schema.planDrafts.profileId, input.profileId),
              eq(this.schema.planDrafts.state, "open"),
            ),
          )
          .run();
        const inserted = this.db
          .insert(this.schema.planDrafts)
          .values({
            tenantId: this.tenantId,
            profileId: input.profileId,
            baseRevisionId: profile.baseRevisionId,
            basePlanVersion: profile.basePlanVersion,
            state: "open",
            digestFormat: PLAN_DRAFT_DIGEST_FORMAT,
            snapshotDigest: prepared.snapshotDigest,
            createdBy: actor,
            idempotencyKey,
            createdAt: new Date().toISOString(),
          })
          .returning({ id: this.schema.planDrafts.id })
          .get();
        if (!inserted) throw new Error("Plan draft could not be created");
        for (const captured of prepared.inputs) {
          this.db
            .insert(this.schema.planDraftInputs)
            .values({
              tenantId: this.tenantId,
              draftId: inserted.id,
              ...captured,
            })
            .run();
        }
        for (const part of prepared.parts) {
          this.db
            .insert(this.schema.planDraftParts)
            .values({ tenantId: this.tenantId, draftId: inserted.id, ...part })
            .run();
        }
        return { kind: "created", draftId: inserted.id };
      },
      "immediate",
    );
    if (
      writeResult.kind === "accepted_baseline_required" ||
      writeResult.kind === "base_changed" ||
      writeResult.kind === "inputs_changed" ||
      writeResult.kind === "idempotency_conflict"
    ) {
      return writeResult;
    }
    const draft = this.getPlanDraft(input.profileId, writeResult.draftId);
    if (!draft) throw new Error("Created Plan draft is missing");
    return { kind: writeResult.kind, draft };
  }

  private storedRebasePlanDraft(input: {
    readonly profileId: number;
    readonly sourceDraftId: number;
    readonly sourceLifecycleVersion: number;
    readonly sourceSnapshotDigest: string;
    readonly actor: string;
    readonly idempotencyKey: string;
  }): StoredRebasePlanDraftResult | null {
    const winnerRow = this.db
      .select({ id: this.schema.planDrafts.id })
      .from(this.schema.planDrafts)
      .where(
        and(
          eq(this.schema.planDrafts.tenantId, this.tenantId),
          eq(this.schema.planDrafts.profileId, input.profileId),
          eq(this.schema.planDrafts.createdBy, input.actor),
          eq(this.schema.planDrafts.idempotencyKey, input.idempotencyKey),
        ),
      )
      .get();
    if (winnerRow) {
      const winner = this.getPlanDraft(input.profileId, winnerRow.id);
      if (!winner) throw new Error("Saved Plan draft is missing");
      return winner.origin.kind === "rebase" &&
        winner.origin.sourceDraftId === input.sourceDraftId &&
        winner.origin.sourceLifecycleVersion === input.sourceLifecycleVersion &&
        winner.origin.sourceSnapshotDigest === input.sourceSnapshotDigest
        ? { kind: "existing", draft: winner }
        : { kind: "idempotency_conflict" };
    }
    const successorRow = this.db
      .select({ id: this.schema.planDrafts.id })
      .from(this.schema.planDrafts)
      .where(
        and(
          eq(this.schema.planDrafts.tenantId, this.tenantId),
          eq(this.schema.planDrafts.profileId, input.profileId),
          eq(this.schema.planDrafts.rebasedFromDraftId, input.sourceDraftId),
          eq(this.schema.planDrafts.rebasedFromLifecycleVersion, input.sourceLifecycleVersion),
        ),
      )
      .get();
    if (!successorRow) return null;
    const successor = this.getPlanDraft(input.profileId, successorRow.id);
    if (!successor) throw new Error("Rebased Plan draft is missing");
    if (successor.origin.kind === "rebase" && successor.origin.sourceSnapshotDigest === input.sourceSnapshotDigest) {
      return { kind: "existing", draft: successor };
    }
    const sourceRow = this.db
      .select({ id: this.schema.planDrafts.id })
      .from(this.schema.planDrafts)
      .where(
        and(
          eq(this.schema.planDrafts.tenantId, this.tenantId),
          eq(this.schema.planDrafts.profileId, input.profileId),
          eq(this.schema.planDrafts.id, input.sourceDraftId),
        ),
      )
      .get();
    if (!sourceRow) return { kind: "not_found" };
    const source = this.getPlanDraft(input.profileId, sourceRow.id);
    return source ? { kind: "source_conflict", draft: source } : { kind: "not_found" };
  }

  rebasePlanDraft(input: {
    readonly profileId: number;
    readonly sourceDraftId: number;
    readonly expectedSourceLifecycleVersion: number;
    readonly expectedSourceSnapshotDigest: string;
    readonly actor: string;
    readonly idempotencyKey: string;
  }): RebasePlanDraftResult {
    const actor = requiredText(input.actor, "Plan draft actor");
    const idempotencyKey = requiredText(input.idempotencyKey, "Plan draft idempotency key");
    const expectedDigest = sha256Digest(
      input.expectedSourceSnapshotDigest,
      "Expected source Plan draft snapshot digest",
    );
    if (
      !Number.isSafeInteger(input.expectedSourceLifecycleVersion) ||
      input.expectedSourceLifecycleVersion < 0 ||
      input.expectedSourceLifecycleVersion > MAX_PLAN_DRAFT_LIFECYCLE_VERSION
    ) {
      throw new Error("Expected source Plan draft lifecycle version is invalid");
    }
    const storedInput = {
      profileId: input.profileId,
      sourceDraftId: input.sourceDraftId,
      sourceLifecycleVersion: input.expectedSourceLifecycleVersion,
      sourceSnapshotDigest: expectedDigest,
      actor,
      idempotencyKey,
    };
    const stored = this.storedRebasePlanDraft(storedInput);
    if (stored) return stored;
    if (!this.syncSqlite) return { kind: "transaction_unavailable" };
    const sourceHeader = this.db
      .select({ id: this.schema.planDrafts.id })
      .from(this.schema.planDrafts)
      .where(
        and(
          eq(this.schema.planDrafts.tenantId, this.tenantId),
          eq(this.schema.planDrafts.profileId, input.profileId),
          eq(this.schema.planDrafts.id, input.sourceDraftId),
        ),
      )
      .get();
    if (!sourceHeader) return { kind: "not_found" };
    const source = this.getPlanDraft(input.profileId, input.sourceDraftId);
    if (!source) return { kind: "not_found" };
    if (source.state !== "abandoned") return { kind: "not_abandoned", state: source.state };
    if (source.lifecycleVersion !== input.expectedSourceLifecycleVersion || source.snapshotDigest !== expectedDigest) {
      return { kind: "source_conflict", draft: source };
    }
    const profile = this.db
      .select({
        baseRevisionId: this.schema.buildProfiles.acceptedPlanRevisionId,
        basePlanVersion: this.schema.buildProfiles.acceptedPlanVersion,
      })
      .from(this.schema.buildProfiles)
      .where(
        and(eq(this.schema.buildProfiles.tenantId, this.tenantId), eq(this.schema.buildProfiles.id, input.profileId)),
      )
      .get();
    if (!profile) return { kind: "not_found" };
    if (this.planDraftNeedsAcceptedBaseline(input.profileId, profile)) {
      return { kind: "accepted_baseline_required" };
    }
    if (profile.baseRevisionId === source.baseRevisionId && profile.basePlanVersion === source.basePlanVersion) {
      return this.transaction((): RebasePlanDraftResult => {
        const transactionStored = this.storedRebasePlanDraft(storedInput);
        if (transactionStored) return transactionStored;
        const currentSourceHeader = this.db
          .select({ id: this.schema.planDrafts.id })
          .from(this.schema.planDrafts)
          .where(
            and(
              eq(this.schema.planDrafts.tenantId, this.tenantId),
              eq(this.schema.planDrafts.profileId, input.profileId),
              eq(this.schema.planDrafts.id, input.sourceDraftId),
            ),
          )
          .get();
        if (!currentSourceHeader) return { kind: "not_found" };
        const currentSource = this.getPlanDraft(input.profileId, input.sourceDraftId);
        if (!currentSource) return { kind: "not_found" };
        if (currentSource.state !== "abandoned") {
          return { kind: "not_abandoned", state: currentSource.state };
        }
        if (
          currentSource.lifecycleVersion !== input.expectedSourceLifecycleVersion ||
          currentSource.snapshotDigest !== expectedDigest
        ) {
          return { kind: "source_conflict", draft: currentSource };
        }
        const currentProfile = this.db
          .select({
            baseRevisionId: this.schema.buildProfiles.acceptedPlanRevisionId,
            basePlanVersion: this.schema.buildProfiles.acceptedPlanVersion,
          })
          .from(this.schema.buildProfiles)
          .where(
            and(
              eq(this.schema.buildProfiles.tenantId, this.tenantId),
              eq(this.schema.buildProfiles.id, input.profileId),
            ),
          )
          .get();
        if (!currentProfile) return { kind: "not_found" };
        if (this.planDraftNeedsAcceptedBaseline(input.profileId, currentProfile)) {
          return { kind: "accepted_baseline_required" };
        }
        return currentProfile.baseRevisionId === currentSource.baseRevisionId &&
          currentProfile.basePlanVersion === currentSource.basePlanVersion
          ? { kind: "base_unchanged" }
          : { kind: "base_changed" };
      }, "immediate");
    }
    const preparation = this.preparePlanDraft(input.profileId, profile);
    if (preparation.kind !== "prepared") return preparation;
    const prepared = preparation.value;
    const virtualDraft: PlanDraftSnapshot = {
      id: 0,
      profileId: input.profileId,
      baseRevisionId: prepared.baseRevisionId,
      basePlanVersion: prepared.basePlanVersion,
      state: "open",
      lifecycleVersion: 0,
      origin: { kind: "recompute" },
      digestFormat: PLAN_DRAFT_DIGEST_FORMAT,
      snapshotDigest: prepared.snapshotDigest,
      createdBy: actor,
      idempotencyKey,
      createdAt: "",
      inputs: prepared.inputs.map((captured, index) => ({
        ...captured,
        id: index + 1,
        draftId: 0,
      })),
      parts: prepared.parts.map((part, index) => ({
        ...part,
        id: index + 1,
        draftId: 0,
      })),
    };
    const merged = mergeRebasedPlanDraft({
      source,
      sourceBaseParts: this.rebaseAcceptedParts(input.profileId, source.baseRevisionId),
      fresh: virtualDraft,
      currentBaseParts: this.rebaseAcceptedParts(input.profileId, profile.baseRevisionId),
    });
    if (merged.kind === "conflicts") {
      return { kind: "merge_conflicts", conflicts: merged.conflicts };
    }

    const writeResult = this.transaction(
      ():
        | { readonly kind: "created"; readonly draftId: number }
        | Exclude<RebasePlanDraftResult, { readonly kind: "rebased" } | { readonly kind: "merge_conflicts" }> => {
        const transactionStored = this.storedRebasePlanDraft(storedInput);
        if (transactionStored) return transactionStored;
        const currentSourceHeader = this.db
          .select({ id: this.schema.planDrafts.id })
          .from(this.schema.planDrafts)
          .where(
            and(
              eq(this.schema.planDrafts.tenantId, this.tenantId),
              eq(this.schema.planDrafts.profileId, input.profileId),
              eq(this.schema.planDrafts.id, input.sourceDraftId),
            ),
          )
          .get();
        if (!currentSourceHeader) return { kind: "not_found" };
        const currentSource = this.getPlanDraft(input.profileId, input.sourceDraftId);
        if (!currentSource) return { kind: "not_found" };
        if (currentSource.state !== "abandoned") {
          return { kind: "not_abandoned", state: currentSource.state };
        }
        if (
          currentSource.lifecycleVersion !== input.expectedSourceLifecycleVersion ||
          currentSource.snapshotDigest !== expectedDigest
        ) {
          return { kind: "source_conflict", draft: currentSource };
        }
        const currentProfile = this.db
          .select({
            baseRevisionId: this.schema.buildProfiles.acceptedPlanRevisionId,
            basePlanVersion: this.schema.buildProfiles.acceptedPlanVersion,
          })
          .from(this.schema.buildProfiles)
          .where(
            and(
              eq(this.schema.buildProfiles.tenantId, this.tenantId),
              eq(this.schema.buildProfiles.id, input.profileId),
            ),
          )
          .get();
        if (!currentProfile) return { kind: "not_found" };
        if (this.planDraftNeedsAcceptedBaseline(input.profileId, currentProfile)) {
          return { kind: "accepted_baseline_required" };
        }
        if (
          currentProfile.baseRevisionId === currentSource.baseRevisionId &&
          currentProfile.basePlanVersion === currentSource.basePlanVersion
        ) {
          return { kind: "base_unchanged" };
        }
        if (
          currentProfile.baseRevisionId !== prepared.baseRevisionId ||
          currentProfile.basePlanVersion !== prepared.basePlanVersion
        ) {
          return { kind: "base_changed" };
        }
        if (this.capturePlanInputs(input.profileId).fingerprint !== prepared.capture.fingerprint) {
          return { kind: "inputs_changed" };
        }
        const inserted = this.db
          .insert(this.schema.planDrafts)
          .values({
            tenantId: this.tenantId,
            profileId: input.profileId,
            baseRevisionId: prepared.baseRevisionId,
            basePlanVersion: prepared.basePlanVersion,
            state: "open",
            lifecycleVersion: 0,
            rebasedFromDraftId: input.sourceDraftId,
            rebasedFromLifecycleVersion: input.expectedSourceLifecycleVersion,
            rebasedFromSnapshotDigest: expectedDigest,
            digestFormat: PLAN_DRAFT_DIGEST_FORMAT,
            snapshotDigest: merged.draft.snapshotDigest,
            createdBy: actor,
            idempotencyKey,
            createdAt: new Date().toISOString(),
          })
          .returning({ id: this.schema.planDrafts.id })
          .get();
        if (!inserted) throw new Error("Rebased Plan draft could not be created");
        for (const captured of merged.draft.inputs) {
          const { id: _id, draftId: _draftId, ...values } = captured;
          this.db
            .insert(this.schema.planDraftInputs)
            .values({
              tenantId: this.tenantId,
              draftId: inserted.id,
              ...values,
            })
            .run();
        }
        for (const part of merged.draft.parts) {
          const { id: _id, draftId: _draftId, ...values } = part;
          this.db
            .insert(this.schema.planDraftParts)
            .values({
              tenantId: this.tenantId,
              draftId: inserted.id,
              ...values,
            })
            .run();
        }
        const persisted = this.getPlanDraft(input.profileId, inserted.id);
        if (
          !persisted ||
          persisted.snapshotDigest !== merged.draft.snapshotDigest ||
          persisted.origin.kind !== "rebase" ||
          persisted.origin.sourceDraftId !== input.sourceDraftId ||
          persisted.origin.sourceLifecycleVersion !== input.expectedSourceLifecycleVersion ||
          persisted.origin.sourceSnapshotDigest !== expectedDigest ||
          persisted.baseRevisionId !== prepared.baseRevisionId ||
          persisted.basePlanVersion !== prepared.basePlanVersion ||
          persisted.state !== "open" ||
          persisted.lifecycleVersion !== 0
        ) {
          throw new Error("Rebased Plan draft could not be verified");
        }
        return { kind: "created", draftId: inserted.id };
      },
      "immediate",
    );
    if (writeResult.kind !== "created") return writeResult;
    const draft = this.getPlanDraft(input.profileId, writeResult.draftId);
    if (!draft) throw new Error("Rebased Plan draft is missing");
    return { kind: "rebased", draft };
  }

  private requiredUnitReconciliationBase(
    profileId: number,
    draft: PlanDraftSnapshot,
  ):
    | {
        readonly kind: "ready";
        readonly mappingDigest: string | null;
        readonly parts: readonly RequiredUnitReconciliationBasePart[];
      }
    | { readonly kind: "unavailable" } {
    if (draft.baseRevisionId == null) {
      return { kind: "ready", mappingDigest: null, parts: [] };
    }
    const currentSet = this.readCurrentRequiredUnitSet(profileId);
    if (currentSet.kind !== "ready" || currentSet.revisionId !== draft.baseRevisionId) {
      return { kind: "unavailable" };
    }
    const revision = this.db
      .select({ inputSetId: this.schema.planRevisions.inputSetId })
      .from(this.schema.planRevisions)
      .where(
        and(
          eq(this.schema.planRevisions.tenantId, this.tenantId),
          eq(this.schema.planRevisions.profileId, profileId),
          eq(this.schema.planRevisions.id, draft.baseRevisionId),
        ),
      )
      .get();
    if (!revision) throw new Error("Plan draft base revision is missing");
    const sourceIdByLayer = new Map<string, number | null>();
    if (revision.inputSetId != null) {
      const inputs = this.db
        .select({
          sourceId: this.schema.planRevisionInputs.sourceId,
          sourceLayer: this.schema.planRevisionInputs.sourceLayer,
        })
        .from(this.schema.planRevisionInputs)
        .where(
          and(
            eq(this.schema.planRevisionInputs.tenantId, this.tenantId),
            eq(this.schema.planRevisionInputs.inputSetId, revision.inputSetId),
          ),
        )
        .all();
      for (const input of inputs) {
        sourceIdByLayer.set(input.sourceLayer, sourceIdByLayer.has(input.sourceLayer) ? null : input.sourceId);
      }
    }
    const tokens = currentSet.units.map((unit) => unit.token);
    const createdAtByToken = new Map<string, string>();
    if (tokens.length > 0) {
      for (const unit of this.db
        .select({
          token: this.schema.requiredUnits.token,
          createdAt: this.schema.requiredUnits.createdAt,
        })
        .from(this.schema.requiredUnits)
        .where(
          and(
            eq(this.schema.requiredUnits.tenantId, this.tenantId),
            eq(this.schema.requiredUnits.profileId, profileId),
            inArray(this.schema.requiredUnits.token, tokens),
          ),
        )
        .all()) {
        createdAtByToken.set(unit.token, unit.createdAt);
      }
    }
    const unitsByPart = new Map<number, RequiredUnitReconciliationBasePart["units"]>();
    for (const unit of currentSet.units) {
      const createdAt = createdAtByToken.get(unit.token);
      if (!createdAt) throw new Error("Required-unit creation time is missing");
      const units = unitsByPart.get(unit.revisionPartId) ?? [];
      unitsByPart.set(unit.revisionPartId, [
        ...units,
        {
          token: unit.token,
          priorIndex: unit.unitIndex,
          createdAt,
          completed: unit.completed,
          assembled: unit.assembled,
        },
      ]);
    }
    const parts = this.db
      .select({
        id: this.schema.planRevisionParts.id,
        sourceLayer: this.schema.planRevisionParts.sourceLayer,
        artifactDigest: this.schema.planRevisionParts.artifactDigest,
        roleInferred: this.schema.planRevisionParts.roleInferred,
        roleOverride: this.schema.planRevisionParts.roleOverride,
      })
      .from(this.schema.planRevisionParts)
      .where(
        and(
          eq(this.schema.planRevisionParts.tenantId, this.tenantId),
          eq(this.schema.planRevisionParts.revisionId, draft.baseRevisionId),
        ),
      )
      .orderBy(asc(this.schema.planRevisionParts.id))
      .all()
      .map((part): RequiredUnitReconciliationBasePart => ({
        id: part.id,
        sourceId: sourceIdByLayer.get(part.sourceLayer) ?? null,
        artifactDigest: part.artifactDigest,
        roleInferred: part.roleInferred,
        roleOverride: part.roleOverride,
        units: unitsByPart.get(part.id) ?? [],
      }));
    return { kind: "ready", mappingDigest: currentSet.mappingDigest, parts };
  }

  private readSavedRequiredUnitReconciliation(reconciliationId: number): SavedRequiredUnitReconciliation {
    const header = this.db
      .select()
      .from(this.schema.planDraftRequiredUnitReconciliations)
      .where(
        and(
          eq(this.schema.planDraftRequiredUnitReconciliations.tenantId, this.tenantId),
          eq(this.schema.planDraftRequiredUnitReconciliations.id, reconciliationId),
        ),
      )
      .get();
    if (!header || header.finalizedAt == null) {
      throw new Error("Required-unit reconciliation is not finalized");
    }
    if (header.format !== REQUIRED_UNIT_RECONCILIATION_FORMAT) {
      throw new Error("Required-unit reconciliation format is unsupported");
    }
    const selectionBasis = parseRequiredUnitSelectionBasis(header.selectionBasisJson);
    const result = parseRequiredUnitReconciliationResult({
      resultJson: header.resultJson,
      selectionBasis,
    });
    if (result.kind !== header.resultKind) {
      throw new Error("Required-unit reconciliation result kind mismatch");
    }
    const selectionBasisDigest = digestRequiredUnitSelectionBasis({
      baseMappingDigest: header.baseMappingDigest,
      rows: selectionBasis,
    });
    if (selectionBasisDigest !== header.selectionBasisDigest) {
      throw new Error("Required-unit reconciliation selection basis digest mismatch");
    }
    const resultDigest = digestRequiredUnitReconciliationResult(result);
    if (resultDigest !== header.resultDigest) {
      throw new Error("Required-unit reconciliation result digest mismatch");
    }
    const decisions = this.db
      .select()
      .from(this.schema.planDraftRequiredUnitDecisions)
      .where(
        and(
          eq(this.schema.planDraftRequiredUnitDecisions.tenantId, this.tenantId),
          eq(this.schema.planDraftRequiredUnitDecisions.reconciliationId, reconciliationId),
        ),
      )
      .orderBy(asc(this.schema.planDraftRequiredUnitDecisions.targetDraftPartId))
      .all()
      .map((row): RequiredUnitReconciliationDecision => {
        if (row.kind === "replace") {
          if (row.predecessorRevisionPartId != null) {
            throw new Error("Required-unit replacement decision is corrupt");
          }
          return { kind: "replace", targetDraftPartId: row.targetDraftPartId };
        }
        if (row.predecessorRevisionPartId == null) {
          throw new Error("Required-unit predecessor decision is corrupt");
        }
        return {
          kind: row.kind,
          targetDraftPartId: row.targetDraftPartId,
          predecessorRevisionPartId: row.predecessorRevisionPartId,
        };
      });
    if (digestRequiredUnitDecisions(decisions) !== header.decisionDigest) {
      throw new Error("Required-unit reconciliation decision digest mismatch");
    }
    const assignments = this.db
      .select()
      .from(this.schema.planDraftRequiredUnitAssignments)
      .where(
        and(
          eq(this.schema.planDraftRequiredUnitAssignments.tenantId, this.tenantId),
          eq(this.schema.planDraftRequiredUnitAssignments.reconciliationId, reconciliationId),
        ),
      )
      .orderBy(
        asc(this.schema.planDraftRequiredUnitAssignments.targetDraftPartId),
        asc(this.schema.planDraftRequiredUnitAssignments.unitIndex),
      )
      .all()
      .map((row): RequiredUnitAssignment => {
        if (row.kind === "create") {
          if (row.requiredUnitToken != null) {
            throw new Error("Required-unit create assignment is corrupt");
          }
          return {
            kind: "create",
            draftPartId: row.targetDraftPartId,
            unitIndex: row.unitIndex,
          };
        }
        if (row.requiredUnitToken == null) {
          throw new Error("Required-unit reuse assignment is corrupt");
        }
        return {
          kind: "reuse",
          draftPartId: row.targetDraftPartId,
          unitIndex: row.unitIndex,
          token: row.requiredUnitToken,
        };
      });
    if (
      (header.resultKind === "unresolved" && assignments.length !== 0) ||
      (header.resultKind === "ready" && assignments.length !== header.expectedAssignmentCount)
    ) {
      throw new Error("Required-unit reconciliation assignment count mismatch");
    }
    const expectedAssignments = result.kind === "ready" ? result.assignments : [];
    if (JSON.stringify(assignments) !== JSON.stringify(expectedAssignments)) {
      throw new Error("Required-unit reconciliation assignments do not match the saved result");
    }
    const reconciliationDigest = digestRequiredUnitReconciliation({
      baseRevisionId: header.baseRevisionId,
      baseMappingDigest: header.baseMappingDigest,
      planningDigest: header.planningDigest,
      selectionBasisDigest: header.selectionBasisDigest,
      decisionDigest: header.decisionDigest,
      resultKind: header.resultKind,
      resultDigest: header.resultDigest,
    });
    if (reconciliationDigest !== header.reconciliationDigest) {
      throw new Error("Required-unit reconciliation digest mismatch");
    }
    return {
      id: header.id,
      format: header.format,
      planningDigest: header.planningDigest,
      baseRevisionId: header.baseRevisionId,
      baseMappingDigest: header.baseMappingDigest,
      selectionBasisDigest: header.selectionBasisDigest,
      decisionDigest: header.decisionDigest,
      resultKind: header.resultKind,
      resultDigest: header.resultDigest,
      reconciliationDigest: header.reconciliationDigest,
      expectedAssignmentCount: header.expectedAssignmentCount,
      decisions,
      assignments,
      surplus: result.kind === "ready" ? result.surplus : [],
      conflicts: result.kind === "unresolved" ? result.conflicts : [],
      selectionBasis,
    };
  }

  getPlanDraftRequiredUnitReconciliation(
    profileId: number,
    draftId: number,
    reconciliationId: number,
  ): SavedRequiredUnitReconciliation | null {
    this.requireProfile(profileId);
    const owned = this.db
      .select({ id: this.schema.planDraftRequiredUnitReconciliations.id })
      .from(this.schema.planDraftRequiredUnitReconciliations)
      .where(
        and(
          eq(this.schema.planDraftRequiredUnitReconciliations.tenantId, this.tenantId),
          eq(this.schema.planDraftRequiredUnitReconciliations.profileId, profileId),
          eq(this.schema.planDraftRequiredUnitReconciliations.draftId, draftId),
          eq(this.schema.planDraftRequiredUnitReconciliations.id, reconciliationId),
        ),
      )
      .get();
    return owned ? this.readSavedRequiredUnitReconciliation(owned.id) : null;
  }

  savePlanDraftRequiredUnitReconciliation(input: {
    readonly profileId: number;
    readonly draftId: number;
    readonly expectedSnapshotDigest: string;
    readonly decisions: readonly RequiredUnitReconciliationDecision[];
    readonly actorId: string;
    readonly idempotencyKey: string;
  }): SavePlanDraftRequiredUnitReconciliationResult {
    const actorId = requiredText(input.actorId, "Required-unit reconciliation actor");
    const idempotencyKey = requiredText(input.idempotencyKey, "Required-unit reconciliation idempotency key");
    const expectedSnapshotDigest = sha256Digest(input.expectedSnapshotDigest, "Expected Plan draft snapshot digest");
    const decisionDigest = digestRequiredUnitDecisions(input.decisions);
    const payloadDigest = createHash("sha256")
      .update(
        JSON.stringify({
          profile_id: input.profileId,
          draft_id: input.draftId,
          expected_snapshot_digest: expectedSnapshotDigest,
          decision_digest: decisionDigest,
        }),
      )
      .digest("hex");
    if (!this.syncSqlite) return { kind: "transaction_unavailable" };

    return this.transaction((): SavePlanDraftRequiredUnitReconciliationResult => {
      const transactionExisting = this.db
        .select({
          id: this.schema.planDraftRequiredUnitReconciliations.id,
          payloadDigest: this.schema.planDraftRequiredUnitReconciliations.payloadDigest,
        })
        .from(this.schema.planDraftRequiredUnitReconciliations)
        .where(
          and(
            eq(this.schema.planDraftRequiredUnitReconciliations.tenantId, this.tenantId),
            eq(this.schema.planDraftRequiredUnitReconciliations.profileId, input.profileId),
            eq(this.schema.planDraftRequiredUnitReconciliations.draftId, input.draftId),
            eq(this.schema.planDraftRequiredUnitReconciliations.actorId, actorId),
            eq(this.schema.planDraftRequiredUnitReconciliations.idempotencyKey, idempotencyKey),
          ),
        )
        .get();
      if (transactionExisting) {
        if (transactionExisting.payloadDigest !== payloadDigest) {
          return { kind: "idempotency_conflict" };
        }
        const draftRow = this.db
          .select({
            selected: this.schema.planDrafts.currentRequiredUnitReconciliationId,
          })
          .from(this.schema.planDrafts)
          .where(
            and(
              eq(this.schema.planDrafts.tenantId, this.tenantId),
              eq(this.schema.planDrafts.profileId, input.profileId),
              eq(this.schema.planDrafts.id, input.draftId),
            ),
          )
          .get();
        if (!draftRow) return { kind: "not_found" };
        if (draftRow.selected !== transactionExisting.id) {
          return {
            kind: "superseded",
            reconciliationId: transactionExisting.id,
          };
        }
        const transactionDraft = this.getPlanDraft(input.profileId, input.draftId);
        if (!transactionDraft) return { kind: "not_found" };
        return {
          kind: "existing",
          draft: transactionDraft,
          reconciliation: this.readSavedRequiredUnitReconciliation(transactionExisting.id),
        };
      }
      const draft = this.getPlanDraft(input.profileId, input.draftId);
      if (!draft) return { kind: "not_found" };
      if (draft.state !== "open") return { kind: "not_open", state: draft.state };
      if (draft.snapshotDigest !== expectedSnapshotDigest) {
        return { kind: "conflict", draft };
      }
      const profile = this.db
        .select({
          baseRevisionId: this.schema.buildProfiles.acceptedPlanRevisionId,
          basePlanVersion: this.schema.buildProfiles.acceptedPlanVersion,
        })
        .from(this.schema.buildProfiles)
        .where(
          and(eq(this.schema.buildProfiles.tenantId, this.tenantId), eq(this.schema.buildProfiles.id, input.profileId)),
        )
        .get();
      if (!profile) return { kind: "not_found" };
      if (this.planDraftNeedsAcceptedBaseline(input.profileId, profile)) {
        return { kind: "accepted_baseline_required" };
      }
      if (profile.baseRevisionId !== draft.baseRevisionId || profile.basePlanVersion !== draft.basePlanVersion) {
        return { kind: "base_changed", draft };
      }
      const base = this.requiredUnitReconciliationBase(input.profileId, draft);
      if (base.kind !== "ready") return { kind: "required_unit_set_unavailable" };
      const result = reconcileRequiredUnits({
        draft,
        baseParts: base.parts,
        baseMappingDigest: base.mappingDigest,
        decisions: input.decisions,
      });
      const planningDigest = digestPlanDraft(draft);
      const selectionBasisDigest = digestRequiredUnitSelectionBasis({
        baseMappingDigest: base.mappingDigest,
        rows: result.selectionBasis,
      });
      const selectionBasisJson = serializeRequiredUnitSelectionBasis(result.selectionBasis);
      const resultDigest = digestRequiredUnitReconciliationResult(result);
      const resultJson = serializeRequiredUnitReconciliationResult(result);
      const reconciliationDigest = digestRequiredUnitReconciliation({
        baseRevisionId: draft.baseRevisionId,
        baseMappingDigest: base.mappingDigest,
        planningDigest,
        selectionBasisDigest,
        decisionDigest,
        resultKind: result.kind,
        resultDigest,
      });
      const expectedAssignmentCount = draft.parts.reduce((total, part) => total + part.quantityEffective, 0);
      const createdAt = new Date().toISOString();
      const inserted = this.db
        .insert(this.schema.planDraftRequiredUnitReconciliations)
        .values({
          tenantId: this.tenantId,
          profileId: input.profileId,
          draftId: input.draftId,
          format: REQUIRED_UNIT_RECONCILIATION_FORMAT,
          planningDigest,
          baseRevisionId: draft.baseRevisionId,
          baseMappingDigest: base.mappingDigest,
          selectionBasisDigest,
          selectionBasisJson,
          decisionDigest,
          resultKind: result.kind,
          resultDigest,
          resultJson,
          reconciliationDigest,
          expectedAssignmentCount,
          actorId,
          idempotencyKey,
          payloadDigest,
          createdAt,
          finalizedAt: null,
        })
        .returning({
          id: this.schema.planDraftRequiredUnitReconciliations.id,
        })
        .get();
      if (!inserted) throw new Error("Required-unit reconciliation could not be created");
      for (const decision of input.decisions) {
        this.db
          .insert(this.schema.planDraftRequiredUnitDecisions)
          .values({
            tenantId: this.tenantId,
            reconciliationId: inserted.id,
            targetDraftPartId: decision.targetDraftPartId,
            kind: decision.kind,
            predecessorRevisionPartId: decision.kind === "replace" ? null : decision.predecessorRevisionPartId,
          })
          .run();
      }
      if (result.kind === "ready") {
        for (const assignment of result.assignments) {
          this.db
            .insert(this.schema.planDraftRequiredUnitAssignments)
            .values({
              tenantId: this.tenantId,
              reconciliationId: inserted.id,
              targetDraftPartId: assignment.draftPartId,
              unitIndex: assignment.unitIndex,
              kind: assignment.kind,
              requiredUnitToken: assignment.kind === "reuse" ? assignment.token : null,
            })
            .run();
        }
      }
      const finalized = this.db
        .update(this.schema.planDraftRequiredUnitReconciliations)
        .set({ finalizedAt: createdAt })
        .where(
          and(
            eq(this.schema.planDraftRequiredUnitReconciliations.tenantId, this.tenantId),
            eq(this.schema.planDraftRequiredUnitReconciliations.id, inserted.id),
            isNull(this.schema.planDraftRequiredUnitReconciliations.finalizedAt),
          ),
        )
        .run();
      if (finalized.changes !== 1) {
        throw new Error("Required-unit reconciliation could not be finalized");
      }
      const persisted = this.readSavedRequiredUnitReconciliation(inserted.id);
      if (
        persisted.selectionBasisDigest !== selectionBasisDigest ||
        persisted.resultDigest !== resultDigest ||
        persisted.reconciliationDigest !== reconciliationDigest ||
        JSON.stringify(persisted.selectionBasis) !== JSON.stringify(result.selectionBasis) ||
        JSON.stringify(persisted.assignments) !== JSON.stringify(result.kind === "ready" ? result.assignments : []) ||
        JSON.stringify(persisted.surplus) !== JSON.stringify(result.kind === "ready" ? result.surplus : []) ||
        JSON.stringify(persisted.conflicts) !== JSON.stringify(result.kind === "unresolved" ? result.conflicts : [])
      ) {
        throw new Error("Required-unit reconciliation persisted result mismatch");
      }
      const nextSnapshotDigest = digestPlanDraftSelection({
        planningDigest,
        requiredUnitReconciliation: {
          format: REQUIRED_UNIT_RECONCILIATION_FORMAT,
          digest: reconciliationDigest,
        },
      });
      const selected = this.db
        .update(this.schema.planDrafts)
        .set({
          currentRequiredUnitReconciliationId: inserted.id,
          digestFormat: PLAN_DRAFT_SELECTION_DIGEST_FORMAT,
          snapshotDigest: nextSnapshotDigest,
        })
        .where(
          and(
            eq(this.schema.planDrafts.tenantId, this.tenantId),
            eq(this.schema.planDrafts.profileId, input.profileId),
            eq(this.schema.planDrafts.id, input.draftId),
            eq(this.schema.planDrafts.state, "open"),
            eq(this.schema.planDrafts.snapshotDigest, expectedSnapshotDigest),
          ),
        )
        .run();
      if (selected.changes !== 1) throw new Error("Required-unit reconciliation selection failed");
      const persistedDraft = this.getPlanDraft(input.profileId, input.draftId);
      if (
        !persistedDraft ||
        persistedDraft.snapshotDigest !== nextSnapshotDigest ||
        persistedDraft.requiredUnitReconciliation?.digest !== reconciliationDigest
      ) {
        throw new Error("Required-unit reconciliation selection could not be verified");
      }
      return {
        kind: "saved",
        draft: persistedDraft,
        reconciliation: persisted,
      };
    }, "immediate");
  }

  private appliedPlanReceipt(row: PlanApplyRequestRow): AppliedPlanReceipt {
    if (
      row.requestFormat !== PLAN_APPLY_REQUEST_FORMAT ||
      row.requestDigest !==
        planApplyRequestDigest({
          profileId: row.profileId,
          draftId: row.draftId,
          expectedSnapshotDigest: row.expectedSnapshotDigest,
          expectedLifecycleVersion: row.expectedLifecycleVersion,
          expectedBaseRevisionId: row.expectedBaseRevisionId,
          expectedBasePlanVersion: row.expectedBasePlanVersion,
        }) ||
      row.planVersion !== row.expectedBasePlanVersion + 1 ||
      row.draftLifecycleVersion !== row.expectedLifecycleVersion + 1
    ) {
      throw new Error("Plan Apply receipt is corrupt");
    }
    const draft = this.db
      .select({
        state: this.schema.planDrafts.state,
        lifecycleVersion: this.schema.planDrafts.lifecycleVersion,
        snapshotDigest: this.schema.planDrafts.snapshotDigest,
        baseRevisionId: this.schema.planDrafts.baseRevisionId,
        basePlanVersion: this.schema.planDrafts.basePlanVersion,
        reconciliationId: this.schema.planDrafts.currentRequiredUnitReconciliationId,
        consumedRevisionId: this.schema.planDrafts.consumedRevisionId,
        consumedAt: this.schema.planDrafts.consumedAt,
      })
      .from(this.schema.planDrafts)
      .where(
        and(
          eq(this.schema.planDrafts.tenantId, this.tenantId),
          eq(this.schema.planDrafts.profileId, row.profileId),
          eq(this.schema.planDrafts.id, row.draftId),
        ),
      )
      .get();
    const reconciliation = this.db
      .select({
        profileId: this.schema.planDraftRequiredUnitReconciliations.profileId,
        draftId: this.schema.planDraftRequiredUnitReconciliations.draftId,
        digest: this.schema.planDraftRequiredUnitReconciliations.reconciliationDigest,
        finalizedAt: this.schema.planDraftRequiredUnitReconciliations.finalizedAt,
      })
      .from(this.schema.planDraftRequiredUnitReconciliations)
      .where(
        and(
          eq(this.schema.planDraftRequiredUnitReconciliations.tenantId, this.tenantId),
          eq(this.schema.planDraftRequiredUnitReconciliations.id, row.reconciliationId),
        ),
      )
      .get();
    const revision = this.db
      .select({
        profileId: this.schema.planRevisions.profileId,
        parentRevisionId: this.schema.planRevisions.parentRevisionId,
        digest: this.schema.planRevisions.snapshotDigest,
      })
      .from(this.schema.planRevisions)
      .where(
        and(
          eq(this.schema.planRevisions.tenantId, this.tenantId),
          eq(this.schema.planRevisions.profileId, row.profileId),
          eq(this.schema.planRevisions.id, row.revisionId),
        ),
      )
      .get();
    const mapping = this.db
      .select({
        profileId: this.schema.planRevisionRequiredUnitSets.profileId,
        revisionId: this.schema.planRevisionRequiredUnitSets.revisionId,
        digest: this.schema.planRevisionRequiredUnitSets.mappingDigest,
      })
      .from(this.schema.planRevisionRequiredUnitSets)
      .where(
        and(
          eq(this.schema.planRevisionRequiredUnitSets.tenantId, this.tenantId),
          eq(this.schema.planRevisionRequiredUnitSets.profileId, row.profileId),
          eq(this.schema.planRevisionRequiredUnitSets.revisionId, row.revisionId),
        ),
      )
      .get();
    const verifiedReconciliation = this.readSavedRequiredUnitReconciliation(row.reconciliationId);
    const verifiedMapping = this.readRequiredUnitSetByRevision(row.profileId, row.revisionId);
    if (
      !draft ||
      draft.state !== "consumed" ||
      draft.lifecycleVersion !== row.draftLifecycleVersion ||
      draft.snapshotDigest !== row.expectedSnapshotDigest ||
      draft.baseRevisionId !== row.expectedBaseRevisionId ||
      draft.basePlanVersion !== row.expectedBasePlanVersion ||
      draft.reconciliationId !== row.reconciliationId ||
      draft.consumedRevisionId !== row.revisionId ||
      draft.consumedAt !== row.appliedAt ||
      !reconciliation ||
      reconciliation.profileId !== row.profileId ||
      reconciliation.draftId !== row.draftId ||
      reconciliation.digest !== row.reconciliationDigest ||
      reconciliation.finalizedAt == null ||
      verifiedReconciliation.reconciliationDigest !== row.reconciliationDigest ||
      revision?.profileId !== row.profileId ||
      revision.parentRevisionId !== row.expectedBaseRevisionId ||
      revision?.digest !== row.revisionDigest ||
      mapping?.profileId !== row.profileId ||
      mapping.revisionId !== row.revisionId ||
      mapping?.digest !== row.requiredUnitMappingDigest ||
      verifiedMapping.kind !== "ready" ||
      verifiedMapping.mappingDigest !== row.requiredUnitMappingDigest
    ) {
      throw new Error("Plan Apply receipt linkage is corrupt");
    }
    return {
      profileId: row.profileId,
      draftId: row.draftId,
      revisionId: row.revisionId,
      planVersion: row.planVersion,
      draftLifecycleVersion: row.draftLifecycleVersion,
      revisionDigest: row.revisionDigest,
      requiredUnitMappingDigest: row.requiredUnitMappingDigest,
      appliedAt: row.appliedAt,
    };
  }

  private applyCheckoffRemap(plan: CheckoffRemapPlan, finalRemap: ReadonlyMap<string, number>): void {
    if (finalRemap.size === 0) return;
    const remapUnit = (unit: { part_id: number; unit_index: number }) => {
      const next = finalRemap.get(`${unit.part_id}:${unit.unit_index}`);
      return next ? { ...unit, part_id: next } : unit;
    };
    if (plan.checkoffLinksRaw != null) {
      const links = JSON.parse(plan.checkoffLinksRaw) as Array<Record<string, unknown>>;
      const remapped = links.map((link) => {
        if (!Array.isArray(link.units)) return link;
        return {
          ...link,
          units: (link.units as Array<{ part_id: number; unit_index: number }>).map(remapUnit),
          resolved_units: Array.isArray(link.resolved_units)
            ? (
                link.resolved_units as Array<{
                  part_id: number;
                  unit_index: number;
                  result: string;
                }>
              ).map(remapUnit)
            : link.resolved_units,
        };
      });
      this.setSetting("printer.checkoff_links", JSON.stringify(remapped));
    }
    if (plan.sendQueueRaw != null) {
      const queue = JSON.parse(plan.sendQueueRaw) as Array<Record<string, unknown>>;
      const remapped = queue.map((item) => {
        if (!Array.isArray(item.checkoff_units)) return item;
        return {
          ...item,
          checkoff_units: (
            item.checkoff_units as Array<{
              part_id: number;
              unit_index: number;
            }>
          ).map(remapUnit),
        };
      });
      this.setSetting("printer.send_queue", JSON.stringify(remapped));
    }
  }

  private strictProductionState(profileId: number): {
    readonly checkoffLinkCount: number;
    readonly sendQueueItemCount: number;
  } {
    const checkoffStates = new Set(["watching", "awaiting_verify", "host_failed", "dismissed", "verified", "applied"]);
    let checkoffLinkCount = 0;
    for (const value of applySettingArray(this.getSetting("printer.checkoff_links"), "Printer Checkoff links")) {
      const row = applyJsonRecord(value, "Printer Checkoff link");
      if (
        typeof row.state !== "string" ||
        !checkoffStates.has(row.state) ||
        !Number.isSafeInteger(row.profile_id) ||
        (row.profile_id as number) <= 0 ||
        !Array.isArray(row.units)
      ) {
        throw new Error("Printer Checkoff links are corrupt");
      }
      for (const unit of row.units) {
        const coordinate = applyJsonRecord(unit, "Printer Checkoff coordinate");
        if (
          !Number.isSafeInteger(coordinate.part_id) ||
          (coordinate.part_id as number) <= 0 ||
          !Number.isSafeInteger(coordinate.unit_index) ||
          (coordinate.unit_index as number) < 0
        ) {
          throw new Error("Printer Checkoff links are corrupt");
        }
      }
      if (row.profile_id === profileId && (row.state === "watching" || row.state === "awaiting_verify")) {
        checkoffLinkCount += 1;
      }
    }
    const queueStates = new Set(["queued", "sending", "done", "error", "cancelled"]);
    let sendQueueItemCount = 0;
    for (const value of applySettingArray(this.getSetting("printer.send_queue"), "Printer send queue")) {
      const row = applyJsonRecord(value, "Printer send queue item");
      if (typeof row.state !== "string" || !queueStates.has(row.state)) {
        throw new Error("Printer send queue is corrupt");
      }
      const explicitProfileId =
        row.profile_id == null
          ? null
          : Number.isSafeInteger(row.profile_id) && (row.profile_id as number) > 0
            ? (row.profile_id as number)
            : NaN;
      if (Number.isNaN(explicitProfileId)) throw new Error("Printer send queue is corrupt");
      const units = row.checkoff_units == null ? [] : row.checkoff_units;
      if (!Array.isArray(units)) throw new Error("Printer send queue is corrupt");
      const coordinateOwners = new Set<number>();
      for (const unit of units) {
        const coordinate = applyJsonRecord(unit, "Printer queue coordinate");
        if (
          !Number.isSafeInteger(coordinate.part_id) ||
          (coordinate.part_id as number) <= 0 ||
          !Number.isSafeInteger(coordinate.unit_index) ||
          (coordinate.unit_index as number) < 0
        ) {
          throw new Error("Printer send queue is corrupt");
        }
        const part = this.db
          .select({ profileId: this.schema.parts.profileId })
          .from(this.schema.parts)
          .where(
            and(eq(this.schema.parts.tenantId, this.tenantId), eq(this.schema.parts.id, coordinate.part_id as number)),
          )
          .get();
        if (part) coordinateOwners.add(part.profileId);
      }
      if (
        coordinateOwners.size > 1 ||
        (explicitProfileId != null && [...coordinateOwners].some((owner) => owner !== explicitProfileId))
      ) {
        throw new Error("Printer send queue ownership is corrupt");
      }
      const owner = explicitProfileId ?? [...coordinateOwners][0] ?? null;
      if (owner === profileId && (row.state === "queued" || row.state === "sending" || row.state === "error")) {
        sendQueueItemCount += 1;
      }
    }
    return { checkoffLinkCount, sendQueueItemCount };
  }

  applyPlanChanges(command: ApplyPlanChangesCommand): ApplyPlanChangesResult {
    const profileId = positiveSafeId(command.profileId, "Build ID");
    const draftId = positiveSafeId(command.draftId, "Plan draft ID");
    const expectedSnapshotDigest = sha256Digest(command.expectedSnapshotDigest, "Expected Plan draft snapshot digest");
    if (
      !Number.isSafeInteger(command.expectedLifecycleVersion) ||
      command.expectedLifecycleVersion < 0 ||
      command.expectedLifecycleVersion > 2_147_483_646
    ) {
      throw new Error("Expected Plan draft lifecycle version is invalid");
    }
    const actorId = requiredText(command.actorId, "Plan Apply actor");
    const idempotencyKey = requiredText(command.idempotencyKey, "Plan Apply idempotency key");
    if (actorId.length > 200 || idempotencyKey.length > 200) {
      throw new Error("Plan Apply actor and idempotency key must be at most 200 characters");
    }
    let expectedBaseRevisionId: number | null;
    let expectedBasePlanVersion: number;
    if (command.expectedBase.kind === "empty") {
      if (command.expectedBase.planVersion !== 0) throw new Error("Empty Plan base is invalid");
      expectedBaseRevisionId = null;
      expectedBasePlanVersion = 0;
    } else {
      expectedBaseRevisionId = positiveSafeId(command.expectedBase.revisionId, "Expected Plan revision ID");
      if (!Number.isSafeInteger(command.expectedBase.planVersion) || command.expectedBase.planVersion <= 0) {
        throw new Error("Expected Plan version is invalid");
      }
      expectedBasePlanVersion = command.expectedBase.planVersion;
    }
    const requestDigest = planApplyRequestDigest({
      profileId,
      draftId,
      expectedSnapshotDigest,
      expectedLifecycleVersion: command.expectedLifecycleVersion,
      expectedBaseRevisionId,
      expectedBasePlanVersion,
    });
    if (!this.syncSqlite) return { kind: "transaction_unavailable" };

    return this.transaction((): ApplyPlanChangesResult => {
      const keyed = this.db
        .select()
        .from(this.schema.planApplyRequests)
        .where(
          and(
            eq(this.schema.planApplyRequests.tenantId, this.tenantId),
            eq(this.schema.planApplyRequests.actorId, actorId),
            eq(this.schema.planApplyRequests.profileId, profileId),
            eq(this.schema.planApplyRequests.idempotencyKey, idempotencyKey),
          ),
        )
        .get();
      if (keyed) {
        return keyed.requestDigest === requestDigest
          ? { kind: "existing", receipt: this.appliedPlanReceipt(keyed) }
          : { kind: "idempotency_conflict" };
      }
      const appliedDraft = this.db
        .select()
        .from(this.schema.planApplyRequests)
        .where(
          and(
            eq(this.schema.planApplyRequests.tenantId, this.tenantId),
            eq(this.schema.planApplyRequests.profileId, profileId),
            eq(this.schema.planApplyRequests.draftId, draftId),
          ),
        )
        .get();
      if (appliedDraft) {
        return {
          kind: "already_applied",
          receipt: this.appliedPlanReceipt(appliedDraft),
        };
      }
      const profile = this.db
        .select()
        .from(this.schema.buildProfiles)
        .where(and(eq(this.schema.buildProfiles.tenantId, this.tenantId), eq(this.schema.buildProfiles.id, profileId)))
        .get();
      if (!profile) return { kind: "not_found" };
      if (profile.archivedAt != null) return { kind: "build_archived" };
      validateAcceptedOperationalTextRow([
        profile.tenantId,
        profile.name,
        profile.orderNumber,
        profile.specialRequest,
        profile.archivedAt,
      ]);
      const draftHeader = this.db
        .select()
        .from(this.schema.planDrafts)
        .where(
          and(
            eq(this.schema.planDrafts.tenantId, this.tenantId),
            eq(this.schema.planDrafts.profileId, profileId),
            eq(this.schema.planDrafts.id, draftId),
          ),
        )
        .get();
      if (!draftHeader) return { kind: "not_found" };
      if (draftHeader.state !== "open") return { kind: "not_open", state: draftHeader.state };
      if (
        draftHeader.lifecycleVersion !== command.expectedLifecycleVersion ||
        draftHeader.snapshotDigest !== expectedSnapshotDigest ||
        (draftHeader.digestFormat !== PLAN_DRAFT_DIGEST_FORMAT &&
          draftHeader.digestFormat !== PLAN_DRAFT_SELECTION_DIGEST_FORMAT)
      ) {
        return { kind: "draft_changed" };
      }
      if (
        this.planDraftNeedsAcceptedBaseline(profileId, {
          baseRevisionId: profile.acceptedPlanRevisionId,
          basePlanVersion: profile.acceptedPlanVersion,
        })
      ) {
        return { kind: "accepted_baseline_required" };
      }
      if (
        profile.acceptedPlanRevisionId !== expectedBaseRevisionId ||
        profile.acceptedPlanVersion !== expectedBasePlanVersion ||
        draftHeader.baseRevisionId !== expectedBaseRevisionId ||
        draftHeader.basePlanVersion !== expectedBasePlanVersion
      ) {
        return { kind: "base_changed" };
      }
      const draft = this.getPlanDraft(profileId, draftId);
      if (!draft) return { kind: "not_found" };
      const draftInputs = canonicalPlanInputs(
        draft.inputs.map((input) => ({
          source_id: input.sourceId,
          source_layer: input.sourceLayer,
          layer_order: input.layerOrder,
          tracking_kind: input.trackingKind,
          source_revision_id: input.sourceRevisionId,
          manifest_digest: input.manifestDigest,
          effective_naming_digest: input.effectiveNamingDigest,
        })),
      );
      const liveAttachments = this.currentPlanAttachmentIdentity(profileId);
      const draftAttachments = draftInputs
        .map((input) => ({
          sourceId: input.source_id,
          sourceLayer: input.source_layer,
          layerOrder: input.layer_order,
        }))
        .sort((left, right) => left.layerOrder - right.layerOrder || left.sourceId - right.sourceId);
      if (JSON.stringify(liveAttachments) !== JSON.stringify(draftAttachments)) {
        return { kind: "draft_changed" };
      }
      this.validatePlanRevisionInputs(profileId, draftInputs);
      const liveFilamentByProjectionId = new Map<
        number,
        {
          filamentColorId: string | null;
          filamentCustomHex: string | null;
          spoolmanSpoolId: string | null;
        }
      >();
      const predecessorProjectionByRevisionPartId = new Map<number, number>();
      if (expectedBaseRevisionId != null) {
        const accepted = this.getAcceptedPlanRevision(profileId);
        if (
          !accepted ||
          accepted.id !== expectedBaseRevisionId ||
          accepted.digestFormat !== PLAN_REVISION_DIGEST_FORMAT ||
          digestPlanRevisionParts(accepted.parts) !== accepted.snapshotDigest
        ) {
          throw new Error("Accepted Plan revision digest is corrupt");
        }
        const compatibility = this.db
          .select()
          .from(this.schema.parts)
          .where(and(eq(this.schema.parts.tenantId, this.tenantId), eq(this.schema.parts.profileId, profileId)))
          .all();
        const compatibilityById = new Map(compatibility.map((part) => [part.id, part]));
        for (const part of compatibility) {
          liveFilamentByProjectionId.set(part.id, {
            filamentColorId: part.filamentColorId,
            filamentCustomHex: part.filamentCustomHex,
            spoolmanSpoolId: part.spoolmanSpoolId,
          });
        }
        for (const part of accepted.parts) {
          if (part.projectionPartId != null) {
            predecessorProjectionByRevisionPartId.set(part.id, part.projectionPartId);
          }
        }
        if (
          compatibility.length !== accepted.parts.length ||
          accepted.parts.some((part) => {
            const projected = part.projectionPartId == null ? null : compatibilityById.get(part.projectionPartId);
            return (
              !projected ||
              !projectionPlanningFieldsMatch(projected, {
                partKey: part.partKey,
                relativePath: part.relativePath,
                filename: part.filename,
                sourceLayer: part.sourceLayer,
                status: part.status,
                role: part.effectiveRole,
                quantityInferred: part.quantityInferred,
                quantityOverride: part.quantityOverride,
                quantityEffective: part.quantityEffective,
                included: part.included,
                notes: part.notes,
                githubBlobUrl: part.githubBlobUrl,
                geometrySame: part.geometrySame,
                requirement: part.requirement,
                optionGroupId: part.optionGroupId,
                manifestSource: part.manifestSource,
              })
            );
          })
        ) {
          throw new Error("Accepted Plan compatibility projection is corrupt");
        }
      }
      if (draftHeader.currentRequiredUnitReconciliationId == null) {
        return { kind: "reconciliation_required", reason: "missing" };
      }
      const reconciliation = this.readSavedRequiredUnitReconciliation(draftHeader.currentRequiredUnitReconciliationId);
      if (reconciliation.resultKind !== "ready") {
        return { kind: "reconciliation_required", reason: "unresolved" };
      }
      const planningDigest = digestPlanDraft(draft);
      if (
        reconciliation.planningDigest !== planningDigest ||
        reconciliation.baseRevisionId !== expectedBaseRevisionId
      ) {
        throw new Error("Selected Required-unit reconciliation is corrupt");
      }
      const base = this.requiredUnitReconciliationBase(profileId, draft);
      if (base.kind !== "ready" || base.mappingDigest !== reconciliation.baseMappingDigest) {
        return { kind: "reconciliation_required", reason: "stale" };
      }
      const baseUnits = base.parts.flatMap((part) => part.units.map((unit) => ({ ...unit, revisionPartId: part.id })));
      const baseByToken = new Map(baseUnits.map((unit) => [unit.token, unit]));
      const liveBasis = reconciliation.selectionBasis.map((row) => {
        const current = baseByToken.get(row.token);
        if (
          !current ||
          current.revisionPartId !== row.revisionPartId ||
          current.priorIndex !== row.priorIndex ||
          current.createdAt !== row.createdAt
        ) {
          throw new Error("Required-unit reconciliation basis identity is corrupt");
        }
        return {
          ...row,
          completed: current.completed,
          assembled: current.assembled,
        };
      });
      if (
        digestRequiredUnitSelectionBasis({
          baseMappingDigest: base.mappingDigest,
          rows: liveBasis,
        }) !== reconciliation.selectionBasisDigest
      ) {
        return { kind: "reconciliation_required", reason: "stale" };
      }
      const objectNames = new Map<string, string>();
      const storedBaseUnits = new Map<
        string,
        {
          readonly tenantId: string;
          readonly profileId: number;
          readonly createdInRevisionId: number;
          readonly objectName: string;
          readonly createdAt: string;
        }
      >();
      if (baseUnits.length > 0) {
        for (const unit of this.db
          .select({
            token: this.schema.requiredUnits.token,
            tenantId: this.schema.requiredUnits.tenantId,
            profileId: this.schema.requiredUnits.profileId,
            createdInRevisionId: this.schema.requiredUnits.createdInRevisionId,
            objectName: this.schema.requiredUnits.objectName,
            createdAt: this.schema.requiredUnits.createdAt,
          })
          .from(this.schema.requiredUnits)
          .where(
            and(
              eq(this.schema.requiredUnits.tenantId, this.tenantId),
              eq(this.schema.requiredUnits.profileId, profileId),
              inArray(
                this.schema.requiredUnits.token,
                baseUnits.map((unit) => unit.token),
              ),
            ),
          )
          .all()) {
          objectNames.set(unit.token, unit.objectName);
          storedBaseUnits.set(unit.token, unit);
        }
      }
      const publicationBaseUnits: PlanPublicationBaseUnit[] = baseUnits.map((unit) => {
        const stored = storedBaseUnits.get(unit.token);
        if (
          !stored ||
          stored.tenantId !== this.tenantId ||
          stored.profileId !== profileId ||
          !Number.isSafeInteger(stored.createdInRevisionId) ||
          stored.createdInRevisionId <= 0 ||
          stored.createdAt !== unit.createdAt
        ) {
          throw new Error("Required-unit identity is corrupt");
        }
        validateAcceptedOperationalTextRow([unit.token, stored.tenantId, stored.objectName, stored.createdAt]);
        return {
          token: unit.token,
          objectName: stored.objectName,
          completed: unit.completed,
          assembled: unit.assembled,
        };
      });
      const production = this.strictProductionState(profileId);
      const prepared = preparePlanPublication({
        draft: {
          ...draft,
          parts: draft.parts.map((part) => {
            if (part.baseRevisionPartId == null) return part;
            const predecessorProjectionId = predecessorProjectionByRevisionPartId.get(part.baseRevisionPartId);
            const live =
              predecessorProjectionId == null ? undefined : liveFilamentByProjectionId.get(predecessorProjectionId);
            return live ? { ...part, ...live } : part;
          }),
        },
        assignments: reconciliation.assignments,
        baseUnits: publicationBaseUnits,
      });
      let checkoffRemapPlan: CheckoffRemapPlan | null = null;
      if (production.checkoffLinkCount > 0 || production.sendQueueItemCount > 0) {
        if (!command.remapCheckoffLinks) {
          return { kind: "production_active", ...production };
        }
        const oldPartMatchKeyById = new Map(
          this.db
            .select({
              id: this.schema.parts.id,
              matchKey: this.schema.parts.matchKey,
            })
            .from(this.schema.parts)
            .where(and(eq(this.schema.parts.tenantId, this.tenantId), eq(this.schema.parts.profileId, profileId)))
            .all()
            .map((row) => [row.id, row.matchKey] as const),
        );
        const newPartByMatchKey = new Map(
          prepared.parts.map((part) => [
            part.partKey,
            {
              draftPartId: part.draftPartId,
              quantityEffective: part.quantityEffective,
            },
          ]),
        );
        const assessment = assessCheckoffRemap({
          profileId,
          checkoffLinksRaw: this.getSetting("printer.checkoff_links"),
          sendQueueRaw: this.getSetting("printer.send_queue"),
          oldPartMatchKeyById,
          partProfileIdById: new Map(
            this.db
              .select({
                id: this.schema.parts.id,
                profileId: this.schema.parts.profileId,
              })
              .from(this.schema.parts)
              .where(eq(this.schema.parts.tenantId, this.tenantId))
              .all()
              .map((row) => [row.id, row.profileId] as const),
          ),
          newPartByMatchKey,
        });
        if (assessment.kind === "unsafe") {
          return {
            kind: "checkoff_remap_unsafe",
            unmappable: assessment.unmappable,
          };
        }
        checkoffRemapPlan = assessment;
      }
      for (const part of prepared.parts) {
        validateAcceptedOperationalTextRow([
          this.tenantId,
          part.partKey,
          part.relativePath,
          part.filename,
          part.sourceLayer,
          part.status,
          part.roleInferred,
          part.roleOverride,
          part.filamentColorId,
          part.filamentCustomHex,
          part.spoolmanSpoolId,
          part.notes,
          part.githubBlobUrl,
          part.requirement,
          part.optionGroupId,
          part.manifestSource,
          part.artifactDigest,
        ]);
      }
      const existingTokens = new Set(
        this.db
          .select({ token: this.schema.requiredUnits.token })
          .from(this.schema.requiredUnits)
          .all()
          .map((row) => row.token),
      );
      const existingObjectNames = new Set(
        this.db
          .select({ objectName: this.schema.requiredUnits.objectName })
          .from(this.schema.requiredUnits)
          .all()
          .map((row) => row.objectName.toLowerCase()),
      );
      const partById = new Map(prepared.parts.map((part) => [part.draftPartId, part]));
      const allocated = new Map<string, { token: string; objectName: string }>();
      for (const assignment of prepared.mappings) {
        if (assignment.kind !== "create") continue;
        const part = partById.get(assignment.draftPartId);
        if (!part) throw new Error("Plan publication Part is missing");
        let chosen: { token: string; objectName: string } | null = null;
        for (let attempt = 0; attempt < 32; attempt += 1) {
          try {
            const token = parseRequiredUnitToken(
              this.planApplyDependencies.tokenFactory?.() ?? generateRequiredUnitToken(),
            );
            const objectName = requiredUnitObjectName(part.filename, token);
            if (!existingTokens.has(token) && !existingObjectNames.has(objectName.toLowerCase())) {
              chosen = { token, objectName };
              existingTokens.add(token);
              existingObjectNames.add(objectName.toLowerCase());
              break;
            }
          } catch {
            chosen = null;
          }
        }
        if (!chosen) return { kind: "token_allocation_failed" };
        allocated.set(`${assignment.draftPartId}:${assignment.unitIndex}`, chosen);
      }
      const appliedAt = (this.planApplyDependencies.clock?.() ?? new Date()).toISOString();
      validateAcceptedOperationalTextRow([
        this.tenantId,
        "tracked",
        PLAN_REVISION_DIGEST_FORMAT,
        prepared.revisionDigest,
        actorId,
        actorId,
        appliedAt,
        appliedAt,
      ]);
      for (const unit of allocated.values()) {
        validateAcceptedOperationalTextRow([this.tenantId, unit.token, unit.objectName, appliedAt]);
      }
      this.db
        .delete(this.schema.acceptedPlateHeads)
        .where(
          and(
            eq(this.schema.acceptedPlateHeads.tenantId, this.tenantId),
            eq(this.schema.acceptedPlateHeads.profileId, profileId),
          ),
        )
        .run();
      const detached = this.db
        .update(this.schema.buildProfiles)
        .set({ acceptedPlanRevisionId: null })
        .where(
          and(
            eq(this.schema.buildProfiles.tenantId, this.tenantId),
            eq(this.schema.buildProfiles.id, profileId),
            expectedBaseRevisionId == null
              ? isNull(this.schema.buildProfiles.acceptedPlanRevisionId)
              : eq(this.schema.buildProfiles.acceptedPlanRevisionId, expectedBaseRevisionId),
            eq(this.schema.buildProfiles.acceptedPlanVersion, expectedBasePlanVersion),
          ),
        )
        .run();
      if (detached.changes !== 1) throw new Error("Accepted Plan pointer detach failed");
      const inputSet = this.publishPlanRevisionInputs(profileId, draftInputs, appliedAt);
      const revisionNumber = this.db
        .select({
          value: sql<number>`COALESCE(MAX(${this.schema.planRevisions.revisionNumber}), 0) + 1`,
        })
        .from(this.schema.planRevisions)
        .where(
          and(
            eq(this.schema.planRevisions.tenantId, this.tenantId),
            eq(this.schema.planRevisions.profileId, profileId),
          ),
        )
        .get()?.value;
      if (!revisionNumber) throw new Error("Plan revision number could not be allocated");
      const revision = this.db
        .insert(this.schema.planRevisions)
        .values({
          tenantId: this.tenantId,
          profileId,
          revisionNumber,
          parentRevisionId: expectedBaseRevisionId,
          inputSetId: inputSet.id,
          provenanceKind: "tracked",
          digestFormat: PLAN_REVISION_DIGEST_FORMAT,
          snapshotDigest: prepared.revisionDigest,
          createdBy: actorId,
          acceptedBy: actorId,
          createdAt: appliedAt,
          acceptedAt: appliedAt,
        })
        .returning({ id: this.schema.planRevisions.id })
        .get();
      if (!revision) throw new Error("Plan revision could not be created");
      const oldPartIds = this.db
        .select({ id: this.schema.parts.id })
        .from(this.schema.parts)
        .where(and(eq(this.schema.parts.tenantId, this.tenantId), eq(this.schema.parts.profileId, profileId)))
        .all()
        .map((row) => row.id);
      this.db
        .delete(this.schema.parts)
        .where(and(eq(this.schema.parts.tenantId, this.tenantId), eq(this.schema.parts.profileId, profileId)))
        .run();
      const projectionByDraftPart = new Map<number, number>();
      const revisionPartByDraftPart = new Map<number, number>();
      for (const part of prepared.parts) {
        const projection = this.db
          .insert(this.schema.parts)
          .values({
            tenantId: this.tenantId,
            profileId,
            matchKey: part.partKey,
            relativePath: part.relativePath,
            filename: part.filename,
            sourceLayer: part.sourceLayer,
            status: part.status,
            role: part.effectiveRole,
            filamentColorId: part.filamentColorId,
            filamentCustomHex: part.filamentCustomHex,
            spoolmanSpoolId: part.spoolmanSpoolId,
            quantityAuto: part.quantityInferred,
            quantityOverride: part.quantityOverride,
            quantityEffective: part.quantityEffective,
            included: part.included,
            notes: part.notes,
            githubBlobUrl: part.githubBlobUrl,
            geometrySame: part.geometrySame,
            requirement: part.requirement,
            optionGroupId: part.optionGroupId,
            manifestSource: part.manifestSource,
          })
          .returning({ id: this.schema.parts.id })
          .get();
        if (!projection) throw new Error("Compatibility Part could not be created");
        if (oldPartIds.includes(projection.id)) throw new Error("Compatibility Part ID was reused");
        projectionByDraftPart.set(part.draftPartId, projection.id);
        const revisionPart = this.db
          .insert(this.schema.planRevisionParts)
          .values({
            tenantId: this.tenantId,
            revisionId: revision.id,
            projectionPartId: projection.id,
            partKey: part.partKey,
            relativePath: part.relativePath,
            filename: part.filename,
            sourceLayer: part.sourceLayer,
            status: part.status,
            roleInferred: part.roleInferred,
            roleOverride: part.roleOverride,
            filamentColorId: part.filamentColorId,
            filamentCustomHex: part.filamentCustomHex,
            spoolmanSpoolId: part.spoolmanSpoolId,
            quantityInferred: part.quantityInferred,
            quantityOverride: part.quantityOverride,
            quantityEffective: part.quantityEffective,
            included: part.included,
            notes: part.notes,
            githubBlobUrl: part.githubBlobUrl,
            geometrySame: part.geometrySame,
            requirement: part.requirement,
            optionGroupId: part.optionGroupId,
            manifestSource: part.manifestSource,
            artifactDigest: part.artifactDigest,
          })
          .returning({ id: this.schema.planRevisionParts.id })
          .get();
        if (!revisionPart) throw new Error("Accepted Plan revision Part could not be created");
        revisionPartByDraftPart.set(part.draftPartId, revisionPart.id);
      }
      if (checkoffRemapPlan) {
        const finalRemap = new Map<string, number>();
        for (const [key, draftPartId] of checkoffRemapPlan.remapByDraftPart) {
          const projectionPartId = projectionByDraftPart.get(draftPartId);
          if (!projectionPartId) throw new Error("Checkoff remap target Part is missing");
          finalRemap.set(key, projectionPartId);
        }
        this.applyCheckoffRemap(checkoffRemapPlan, finalRemap);
      }
      for (const allocatedUnit of allocated.values()) {
        this.db
          .insert(this.schema.requiredUnits)
          .values({
            token: allocatedUnit.token,
            tenantId: this.tenantId,
            profileId,
            createdInRevisionId: revision.id,
            objectName: allocatedUnit.objectName,
            createdAt: appliedAt,
          })
          .run();
      }
      const mappingRows: Array<{
        revisionPartId: number;
        unitIndex: number;
        token: string;
        objectName: string;
      }> = [];
      for (const assignment of prepared.mappings) {
        const revisionPartId = revisionPartByDraftPart.get(assignment.draftPartId);
        if (!revisionPartId) throw new Error("Accepted revision Part mapping is missing");
        const allocatedUnit = allocated.get(`${assignment.draftPartId}:${assignment.unitIndex}`);
        const token = assignment.kind === "reuse" ? assignment.token : allocatedUnit?.token;
        if (!token) throw new Error("Required-unit assignment token is missing");
        const objectName = assignment.kind === "reuse" ? objectNames.get(token) : allocatedUnit?.objectName;
        if (!objectName) throw new Error("Required-unit Object name is missing");
        this.db
          .insert(this.schema.planRevisionRequiredUnits)
          .values({
            tenantId: this.tenantId,
            revisionId: revision.id,
            revisionPartId,
            unitIndex: assignment.unitIndex,
            requiredUnitToken: token,
          })
          .run();
        mappingRows.push({
          revisionPartId,
          unitIndex: assignment.unitIndex,
          token,
          objectName,
        });
      }
      const mappingDigest = digestRequiredUnitMap({
        revisionId: revision.id,
        expectedUnitCount: prepared.expectedUnitCount,
        rows: mappingRows,
      });
      validateAcceptedOperationalTextRow([this.tenantId, REQUIRED_UNIT_MAP_FORMAT, mappingDigest, appliedAt]);
      this.db
        .insert(this.schema.planRevisionRequiredUnitSets)
        .values({
          revisionId: revision.id,
          tenantId: this.tenantId,
          profileId,
          format: REQUIRED_UNIT_MAP_FORMAT,
          expectedUnitCount: prepared.expectedUnitCount,
          mappingDigest,
          createdAt: appliedAt,
        })
        .run();
      const progressBySlot = new Map(prepared.progress.map((row) => [`${row.draftPartId}:${row.unitIndex}`, row]));
      for (const assignment of prepared.mappings) {
        const projectionPartId = projectionByDraftPart.get(assignment.draftPartId);
        const progress = progressBySlot.get(`${assignment.draftPartId}:${assignment.unitIndex}`);
        if (!projectionPartId || !progress) throw new Error("Published progress target is missing");
        this.db
          .insert(this.schema.printProgress)
          .values({
            tenantId: this.tenantId,
            partId: projectionPartId,
            unitIndex: assignment.unitIndex,
            completed: progress.completed,
            assembled: progress.assembled,
          })
          .run();
      }
      this.acceptPlanRevisionInputSet(profileId, inputSet.id, appliedAt);
      const pointed = this.db
        .update(this.schema.buildProfiles)
        .set({
          acceptedPlanRevisionId: revision.id,
          acceptedPlanVersion: expectedBasePlanVersion + 1,
          lastRecomputedAt: appliedAt,
        })
        .where(
          and(
            eq(this.schema.buildProfiles.tenantId, this.tenantId),
            eq(this.schema.buildProfiles.id, profileId),
            isNull(this.schema.buildProfiles.acceptedPlanRevisionId),
            eq(this.schema.buildProfiles.acceptedPlanVersion, expectedBasePlanVersion),
          ),
        )
        .run();
      if (pointed.changes !== 1) throw new Error("Accepted Plan pointer publication failed");
      const consumed = this.db
        .update(this.schema.planDrafts)
        .set({
          state: "consumed",
          lifecycleVersion: command.expectedLifecycleVersion + 1,
          consumedRevisionId: revision.id,
          consumedAt: appliedAt,
        })
        .where(
          and(
            eq(this.schema.planDrafts.tenantId, this.tenantId),
            eq(this.schema.planDrafts.profileId, profileId),
            eq(this.schema.planDrafts.id, draftId),
            eq(this.schema.planDrafts.state, "open"),
            eq(this.schema.planDrafts.lifecycleVersion, command.expectedLifecycleVersion),
            eq(this.schema.planDrafts.snapshotDigest, expectedSnapshotDigest),
            eq(this.schema.planDrafts.currentRequiredUnitReconciliationId, reconciliation.id),
          ),
        )
        .run();
      if (consumed.changes !== 1) throw new Error("Plan draft consumption failed");
      const receiptRow = this.db
        .insert(this.schema.planApplyRequests)
        .values({
          tenantId: this.tenantId,
          profileId,
          draftId,
          actorId,
          idempotencyKey,
          requestFormat: PLAN_APPLY_REQUEST_FORMAT,
          requestDigest,
          expectedSnapshotDigest,
          expectedLifecycleVersion: command.expectedLifecycleVersion,
          expectedBaseRevisionId,
          expectedBasePlanVersion,
          reconciliationId: reconciliation.id,
          reconciliationDigest: reconciliation.reconciliationDigest,
          revisionId: revision.id,
          planVersion: expectedBasePlanVersion + 1,
          revisionDigest: prepared.revisionDigest,
          requiredUnitMappingDigest: mappingDigest,
          draftLifecycleVersion: command.expectedLifecycleVersion + 1,
          appliedAt,
        })
        .returning()
        .get();
      if (!receiptRow) throw new Error("Plan Apply receipt could not be created");
      const receipt = this.appliedPlanReceipt(receiptRow);
      const accepted = this.getAcceptedPlanRevision(profileId);
      const requiredUnits = this.readCurrentRequiredUnitSet(profileId);
      const consumedDraft = this.getPlanDraft(profileId, draftId);
      const acceptedInput = this.db
        .select({
          inputSetId: this.schema.planAcceptedInputSets.inputSetId,
          acceptedAt: this.schema.planAcceptedInputSets.acceptedAt,
        })
        .from(this.schema.planAcceptedInputSets)
        .where(
          and(
            eq(this.schema.planAcceptedInputSets.tenantId, this.tenantId),
            eq(this.schema.planAcceptedInputSets.profileId, profileId),
          ),
        )
        .get();
      const compatibility = this.db
        .select()
        .from(this.schema.parts)
        .where(and(eq(this.schema.parts.tenantId, this.tenantId), eq(this.schema.parts.profileId, profileId)))
        .all();
      const revisionParity =
        accepted != null &&
        publishedPlanPartsMatch({
          preparedParts: prepared.parts,
          revisionParts: accepted.parts,
          projectionParts: compatibility,
          revisionPartIdByDraftPart: revisionPartByDraftPart,
          projectionPartIdByDraftPart: projectionByDraftPart,
        });
      const publishedProgress = new Map(
        requiredUnits.kind === "ready"
          ? requiredUnits.units.map((unit) => [`${unit.revisionPartId}:${unit.unitIndex}`, unit])
          : [],
      );
      const progressParity = prepared.mappings.every((assignment) => {
        const revisionPartId = revisionPartByDraftPart.get(assignment.draftPartId);
        const progress = progressBySlot.get(`${assignment.draftPartId}:${assignment.unitIndex}`);
        const allocatedUnit = allocated.get(`${assignment.draftPartId}:${assignment.unitIndex}`);
        const token = assignment.kind === "reuse" ? assignment.token : allocatedUnit?.token;
        const published =
          revisionPartId == null ? null : publishedProgress.get(`${revisionPartId}:${assignment.unitIndex}`);
        return (
          progress != null &&
          token != null &&
          published?.token === token &&
          published.completed === progress.completed &&
          published.assembled === progress.assembled
        );
      });
      if (
        !accepted ||
        accepted.id !== revision.id ||
        accepted.inputSetId !== inputSet.id ||
        accepted.snapshotDigest !== prepared.revisionDigest ||
        digestPlanRevisionParts(accepted.parts) !== prepared.revisionDigest ||
        !acceptedInput ||
        acceptedInput.inputSetId !== inputSet.id ||
        acceptedInput.acceptedAt !== appliedAt ||
        compatibility.length !== prepared.parts.length ||
        !revisionParity ||
        requiredUnits.kind !== "ready" ||
        requiredUnits.mappingDigest !== mappingDigest ||
        requiredUnits.units.length !== prepared.expectedUnitCount ||
        !progressParity ||
        consumedDraft?.state !== "consumed" ||
        consumedDraft.consumedRevisionId !== revision.id ||
        consumedDraft.consumedAt !== appliedAt
      ) {
        throw new Error("Applied Plan verification failed");
      }
      return { kind: "applied", receipt };
    }, "immediate");
  }

  editPlanDraftParts(input: {
    readonly profileId: number;
    readonly draftId: number;
    readonly expectedSnapshotDigest: string;
    readonly decision: PlanDraftPartDecision;
  }): EditPlanDraftPartsResult {
    return this.editPlanDraftPartsBatch({
      profileId: input.profileId,
      draftId: input.draftId,
      expectedSnapshotDigest: input.expectedSnapshotDigest,
      decisions: [input.decision],
    });
  }

  editPlanDraftPartsBatch(input: {
    readonly profileId: number;
    readonly draftId: number;
    readonly expectedSnapshotDigest: string;
    readonly decisions: readonly PlanDraftPartDecision[];
  }): EditPlanDraftPartsResult {
    const expectedSnapshotDigest = sha256Digest(input.expectedSnapshotDigest, "Expected Plan draft snapshot digest");
    if (input.decisions.length === 0) {
      throw new Error("Plan draft edit batch requires at least one decision");
    }
    if (!this.syncSqlite) return { kind: "transaction_unavailable" };

    return this.transaction((): EditPlanDraftPartsResult => {
      const header = this.db
        .select({ id: this.schema.planDrafts.id })
        .from(this.schema.planDrafts)
        .where(
          and(
            eq(this.schema.planDrafts.tenantId, this.tenantId),
            eq(this.schema.planDrafts.profileId, input.profileId),
            eq(this.schema.planDrafts.id, input.draftId),
          ),
        )
        .get();
      if (!header) return { kind: "not_found" };
      const current = this.getPlanDraft(input.profileId, input.draftId);
      if (!current) return { kind: "not_found" };
      if (current.state !== "open") return { kind: "not_open", state: current.state };

      const profile = this.db
        .select({
          baseRevisionId: this.schema.buildProfiles.acceptedPlanRevisionId,
          basePlanVersion: this.schema.buildProfiles.acceptedPlanVersion,
        })
        .from(this.schema.buildProfiles)
        .where(
          and(eq(this.schema.buildProfiles.tenantId, this.tenantId), eq(this.schema.buildProfiles.id, input.profileId)),
        )
        .get();
      if (!profile) return { kind: "not_found" };
      if (this.planDraftNeedsAcceptedBaseline(input.profileId, profile)) {
        return { kind: "accepted_baseline_required" };
      }
      if (profile.baseRevisionId !== current.baseRevisionId || profile.basePlanVersion !== current.basePlanVersion) {
        return { kind: "base_changed", draft: current };
      }

      let next = current;
      try {
        for (const decision of input.decisions) {
          next = applyPlanDraftPartDecision({ draft: next, decision });
        }
      } catch (error) {
        if (error instanceof PlanDraftPartNotFoundError) return { kind: "not_found" };
        throw error;
      }
      if (next.snapshotDigest === current.snapshotDigest) {
        return { kind: "unchanged", draft: current };
      }
      if (current.snapshotDigest !== expectedSnapshotDigest) {
        return { kind: "conflict", draft: current };
      }

      const changedPartIds = current.parts
        .filter((part) => {
          const nextPart = next.parts.find((candidate) => candidate.id === part.id);
          if (!nextPart) throw new Error("Edited Plan draft lost a Part");
          return (
            part.included !== nextPart.included ||
            part.quantityOverride !== nextPart.quantityOverride ||
            part.quantityEffective !== nextPart.quantityEffective
          );
        })
        .map((part) => part.id);
      if (changedPartIds.length === 0) {
        return { kind: "unchanged", draft: current };
      }
      const nextPlanningDigest = digestPlanDraft(next);
      const nextDigestFormat = current.digestFormat;
      const nextSnapshotDigest =
        nextDigestFormat === PLAN_DRAFT_SELECTION_DIGEST_FORMAT
          ? digestPlanDraftSelection({
              planningDigest: nextPlanningDigest,
              requiredUnitReconciliation: null,
            })
          : nextPlanningDigest;

      const headerWrite = this.db
        .update(this.schema.planDrafts)
        .set({
          currentRequiredUnitReconciliationId: null,
          digestFormat: nextDigestFormat,
          snapshotDigest: nextSnapshotDigest,
        })
        .where(
          and(
            eq(this.schema.planDrafts.tenantId, this.tenantId),
            eq(this.schema.planDrafts.profileId, input.profileId),
            eq(this.schema.planDrafts.id, input.draftId),
            eq(this.schema.planDrafts.state, "open"),
            eq(this.schema.planDrafts.snapshotDigest, expectedSnapshotDigest),
          ),
        )
        .run();
      if (headerWrite.changes !== 1) return { kind: "conflict", draft: current };

      for (const decision of input.decisions) {
        const partScope = and(
          eq(this.schema.planDraftParts.tenantId, this.tenantId),
          eq(this.schema.planDraftParts.draftId, input.draftId),
          inArray(this.schema.planDraftParts.id, [...decision.partIds]),
        );
        const partWrite =
          decision.kind === "set_included"
            ? this.db.update(this.schema.planDraftParts).set({ included: decision.value }).where(partScope).run()
            : this.db
                .update(this.schema.planDraftParts)
                .set({
                  quantityOverride: decision.value,
                  quantityEffective: sql`COALESCE(${decision.value}, ${this.schema.planDraftParts.quantityInferred})`,
                })
                .where(partScope)
                .run();
        if (partWrite.changes !== decision.partIds.length) {
          throw new Error("Plan draft Part edit did not update every selected row");
        }
      }
      const persisted = this.getPlanDraft(input.profileId, input.draftId);
      if (
        !persisted ||
        persisted.snapshotDigest !== nextSnapshotDigest ||
        (nextDigestFormat === PLAN_DRAFT_SELECTION_DIGEST_FORMAT && persisted.requiredUnitReconciliation != null)
      ) {
        throw new Error("Edited Plan draft could not be verified");
      }
      return { kind: "updated", draft: persisted };
    }, "immediate");
  }

  transitionPlanDraft(input: {
    readonly profileId: number;
    readonly draftId: number;
    readonly transition: PlanDraftLifecycleTransition;
  }): TransitionPlanDraftResult {
    const expectedLifecycleVersion = input.transition.expectedLifecycleVersion;
    if (
      !Number.isSafeInteger(expectedLifecycleVersion) ||
      expectedLifecycleVersion < 0 ||
      expectedLifecycleVersion >= MAX_PLAN_DRAFT_LIFECYCLE_VERSION
    ) {
      throw new Error(
        `Expected Plan draft lifecycle version must be a nonnegative safe integer below ${MAX_PLAN_DRAFT_LIFECYCLE_VERSION}`,
      );
    }
    if (!this.syncSqlite) return { kind: "transaction_unavailable" };

    return this.transaction((): TransitionPlanDraftResult => {
      const header = this.db
        .select({ id: this.schema.planDrafts.id })
        .from(this.schema.planDrafts)
        .where(
          and(
            eq(this.schema.planDrafts.tenantId, this.tenantId),
            eq(this.schema.planDrafts.profileId, input.profileId),
            eq(this.schema.planDrafts.id, input.draftId),
          ),
        )
        .get();
      if (!header) return { kind: "not_found" };
      const current = this.getPlanDraft(input.profileId, input.draftId);
      if (!current) return { kind: "not_found" };
      if (current.state === "consumed") return { kind: "not_allowed", state: current.state };

      const source: PlanDraftState = input.transition.kind === "abandon" ? "open" : "abandoned";
      const target: PlanDraftState = input.transition.kind === "abandon" ? "abandoned" : "open";
      if (current.state === target && current.lifecycleVersion === expectedLifecycleVersion + 1) {
        return { kind: "unchanged", draft: current };
      }
      if (current.lifecycleVersion !== expectedLifecycleVersion) {
        return { kind: "conflict", draft: current };
      }
      if (current.state !== source) return { kind: "not_allowed", state: current.state };

      if (input.transition.kind === "resume") {
        const profile = this.db
          .select({
            baseRevisionId: this.schema.buildProfiles.acceptedPlanRevisionId,
            basePlanVersion: this.schema.buildProfiles.acceptedPlanVersion,
          })
          .from(this.schema.buildProfiles)
          .where(
            and(
              eq(this.schema.buildProfiles.tenantId, this.tenantId),
              eq(this.schema.buildProfiles.id, input.profileId),
            ),
          )
          .get();
        if (!profile) return { kind: "not_found" };
        if (this.planDraftNeedsAcceptedBaseline(input.profileId, profile)) {
          return { kind: "accepted_baseline_required" };
        }
        if (profile.baseRevisionId !== current.baseRevisionId || profile.basePlanVersion !== current.basePlanVersion) {
          return { kind: "base_changed", draft: current };
        }
      }

      const write = this.db
        .update(this.schema.planDrafts)
        .set({
          state: target,
          lifecycleVersion: sql`${this.schema.planDrafts.lifecycleVersion} + 1`,
        })
        .where(
          and(
            eq(this.schema.planDrafts.tenantId, this.tenantId),
            eq(this.schema.planDrafts.profileId, input.profileId),
            eq(this.schema.planDrafts.id, input.draftId),
            eq(this.schema.planDrafts.state, source),
            eq(this.schema.planDrafts.lifecycleVersion, expectedLifecycleVersion),
          ),
        )
        .run();
      if (write.changes !== 1) return { kind: "conflict", draft: current };
      const persisted = this.getPlanDraft(input.profileId, input.draftId);
      if (!persisted) throw new Error("Transitioned Plan draft is missing");
      if (
        persisted.state !== target ||
        persisted.lifecycleVersion !== expectedLifecycleVersion + 1 ||
        persisted.snapshotDigest !== current.snapshotDigest
      ) {
        throw new Error("Transitioned Plan draft is invalid");
      }
      return { kind: "transitioned", draft: persisted };
    }, "immediate");
  }

  diffPlanDraft(profileId: number, draftId: number): PlanDraftDiff {
    const draft = this.getPlanDraft(profileId, draftId);
    if (!draft) throw new Error("Plan draft not found");
    const current = this.db
      .select({
        revisionId: this.schema.buildProfiles.acceptedPlanRevisionId,
        planVersion: this.schema.buildProfiles.acceptedPlanVersion,
      })
      .from(this.schema.buildProfiles)
      .where(and(eq(this.schema.buildProfiles.tenantId, this.tenantId), eq(this.schema.buildProfiles.id, profileId)))
      .get();
    let baseInputs: PlanSnapshotInput[] = [];
    let baseParts: Array<PlanSnapshotPart & { id: number }> = [];
    if (draft.baseRevisionId != null) {
      const revision = this.db
        .select()
        .from(this.schema.planRevisions)
        .where(
          and(
            eq(this.schema.planRevisions.tenantId, this.tenantId),
            eq(this.schema.planRevisions.profileId, profileId),
            eq(this.schema.planRevisions.id, draft.baseRevisionId),
          ),
        )
        .get();
      if (!revision) throw new Error("Plan draft base revision is missing");
      if (revision.inputSetId != null) {
        baseInputs = this.db
          .select()
          .from(this.schema.planRevisionInputs)
          .where(
            and(
              eq(this.schema.planRevisionInputs.tenantId, this.tenantId),
              eq(this.schema.planRevisionInputs.inputSetId, revision.inputSetId),
            ),
          )
          .all()
          .map((row) => ({
            sourceId: row.sourceId,
            sourceLayer: row.sourceLayer,
            layerOrder: row.layerOrder,
            trackingKind: planInputTrackingKind(row.trackingKind),
            sourceRevisionId: row.sourceRevisionId,
            manifestDigest: row.manifestDigest,
            effectiveNamingDigest: row.effectiveNamingDigest ?? "",
          }));
      }
      baseParts = this.db
        .select()
        .from(this.schema.planRevisionParts)
        .where(
          and(
            eq(this.schema.planRevisionParts.tenantId, this.tenantId),
            eq(this.schema.planRevisionParts.revisionId, revision.id),
          ),
        )
        .all()
        .map((part) => ({
          id: part.id,
          partKey: part.partKey,
          relativePath: part.relativePath,
          filename: part.filename,
          sourceLayer: part.sourceLayer,
          status: part.status,
          roleInferred: part.roleInferred,
          roleOverride: part.roleOverride,
          filamentColorId: part.filamentColorId,
          filamentCustomHex: part.filamentCustomHex,
          spoolmanSpoolId: part.spoolmanSpoolId,
          quantityInferred: part.quantityInferred,
          quantityOverride: part.quantityOverride,
          quantityEffective: part.quantityEffective,
          included: part.included,
          notes: part.notes,
          githubBlobUrl: part.githubBlobUrl,
          geometrySame: part.geometrySame,
          requirement: part.requirement,
          optionGroupId: part.optionGroupId,
          manifestSource: part.manifestSource,
          artifactDigest: part.artifactDigest,
        }));
    }
    return diffPlanDraftSnapshot({
      draft,
      baseInputs,
      baseParts,
      baseIsCurrent: current?.revisionId === draft.baseRevisionId && current.planVersion === draft.basePlanVersion,
    });
  }

  createProfile(
    name: string,
    baseProjectId?: number,
  ): ProfileHeader & {
    layers: Array<{
      id: number;
      layer_order: number;
      layer_type: string;
      project_id: number | null;
      project_name: string | null;
    }>;
  } {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Profile name is required");
    const dup = this.db
      .select()
      .from(this.schema.buildProfiles)
      .where(and(eq(this.schema.buildProfiles.tenantId, this.tenantId), eq(this.schema.buildProfiles.name, trimmed)))
      .get();
    if (dup) throw new Error(`Profile already exists: ${trimmed}`);

    const profile = this.db
      .insert(this.schema.buildProfiles)
      .values({
        tenantId: this.tenantId,
        name: trimmed,
        configModifiedAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
      })
      .returning()
      .get();
    if (!profile) throw new Error("Failed to create profile");

    if (baseProjectId != null) {
      this.setBaseLayer(profile.id, baseProjectId);
    }

    return {
      ...this.getProfileHeader(profile.id)!,
      layers: this.getProfileLayers(profile.id),
    };
  }

  deleteProfile(id: number): void {
    const mutate = () => {
      if (this.syncSqlite) this.db.run(sql.raw("PRAGMA defer_foreign_keys = ON"));
      this.db
        .delete(this.schema.appSettings)
        .where(and(
          eq(this.schema.appSettings.tenantId, this.tenantId),
          inArray(this.schema.appSettings.key, [
            `production_setup:${id}`,
            roleFilamentSettingKey(id),
          ]),
        ))
        .run();
      this.db
        .delete(this.schema.buildProfiles)
        .where(and(eq(this.schema.buildProfiles.tenantId, this.tenantId), eq(this.schema.buildProfiles.id, id)))
        .run();
    };
    if (this.syncSqlite) this.transaction(mutate, "immediate");
    else mutate();
  }

  renameProfile(id: number, name: string): ProfileHeader {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Profile name is required");
    const dup = this.db
      .select()
      .from(this.schema.buildProfiles)
      .where(and(eq(this.schema.buildProfiles.tenantId, this.tenantId), eq(this.schema.buildProfiles.name, trimmed)))
      .get();
    if (dup && dup.id !== id) throw new Error(`Profile already exists: ${trimmed}`);
    this.db
      .update(this.schema.buildProfiles)
      .set({ name: trimmed })
      .where(and(eq(this.schema.buildProfiles.tenantId, this.tenantId), eq(this.schema.buildProfiles.id, id)))
      .run();
    const profile = this.getProfileHeader(id);
    if (!profile) throw new Error("Profile not found");
    return profile;
  }

  updateProfileSpecialRequest(id: number, specialRequest: string | null): ProfileHeader {
    if (!this.getOwnedProfileIdentity(id)) throw new Error("Profile not found");
    const trimmed = (specialRequest ?? "").trim();
    this.db
      .update(this.schema.buildProfiles)
      .set({ specialRequest: trimmed || null })
      .where(and(eq(this.schema.buildProfiles.tenantId, this.tenantId), eq(this.schema.buildProfiles.id, id)))
      .run();
    const profile = this.getProfileHeader(id);
    if (!profile) throw new Error("Profile not found");
    return profile;
  }

  /** Unarchive is intentionally unsupported — duplicate an archived template instead. */
  unarchiveProfile(_id: number): never {
    throw new Error("Cannot unarchive; duplicate the archived template instead");
  }

  touchProfileLastUsed(id: number): ProfileHeader {
    const existing = this.getOwnedProfileIdentity(id);
    if (!existing) throw new Error("Profile not found");
    const now = new Date().toISOString();
    this.db
      .update(this.schema.buildProfiles)
      .set({ lastUsedAt: now })
      .where(and(eq(this.schema.buildProfiles.tenantId, this.tenantId), eq(this.schema.buildProfiles.id, id)))
      .run();
    return this.getProfileHeader(id)!;
  }

  private reconcileDraftForPublish(
    draft: PlanDraftSnapshot,
    actorId: string,
    idempotencyKey: string,
  ): PlanDraftSnapshot | null {
    const first = this.savePlanDraftRequiredUnitReconciliation({
      profileId: draft.profileId,
      draftId: draft.id,
      expectedSnapshotDigest: draft.snapshotDigest,
      decisions: [],
      actorId,
      idempotencyKey: `${idempotencyKey}:reconcile`,
    });
    if (first.kind !== "saved" && first.kind !== "existing") return null;
    if (first.reconciliation.resultKind === "ready") return first.draft;
    const decisions: RequiredUnitReconciliationDecision[] = first.reconciliation.conflicts.map((conflict) => {
      switch (conflict.kind) {
        case "unsafe_predecessor":
          return {
            kind: "accept_prior_completion",
            targetDraftPartId: conflict.targetDraftPartId,
            predecessorRevisionPartId: conflict.predecessorRevisionPartId,
          };
        case "ambiguous_exact_match":
          return {
            kind: "select_exact_predecessor",
            targetDraftPartId: conflict.targetDraftPartId,
            predecessorRevisionPartId: conflict.candidateRevisionPartIds[0]!,
          };
        case "predecessor_claimed":
          return {
            kind: "replace",
            targetDraftPartId: conflict.targetDraftPartId,
          };
      }
    });
    const resolved = this.savePlanDraftRequiredUnitReconciliation({
      profileId: draft.profileId,
      draftId: draft.id,
      expectedSnapshotDigest: first.draft.snapshotDigest,
      decisions,
      actorId,
      idempotencyKey: `${idempotencyKey}:resolve`,
    });
    if ((resolved.kind !== "saved" && resolved.kind !== "existing") || resolved.reconciliation.resultKind !== "ready") {
      return null;
    }
    return resolved.draft;
  }

  private publishWorkingPlan(profileId: number, actorId: string, idempotencyKey: string): boolean {
    const created = this.recomputePlanDraft({
      profileId,
      actor: actorId,
      idempotencyKey: `${idempotencyKey}:draft`,
    });
    if (created.kind !== "created" && created.kind !== "existing") return false;
    const ready = this.reconcileDraftForPublish(created.draft, actorId, idempotencyKey);
    if (!ready) return false;
    const expectedBase =
      ready.baseRevisionId == null
        ? { kind: "empty" as const, planVersion: 0 as const }
        : {
            kind: "revision" as const,
            revisionId: ready.baseRevisionId,
            planVersion: ready.basePlanVersion,
          };
    const result = this.applyPlanChanges({
      profileId: ready.profileId,
      draftId: ready.id,
      expectedSnapshotDigest: ready.snapshotDigest,
      expectedLifecycleVersion: ready.lifecycleVersion,
      expectedBase,
      actorId,
      idempotencyKey: `${idempotencyKey}:apply`,
    });
    return result.kind === "applied" || result.kind === "existing" || result.kind === "already_applied";
  }

  private overlayAcceptedOperationalCopy(
    profileId: number,
    sourceParts: readonly {
      readonly partKey: string;
      readonly assignment: FilamentAssignment;
      readonly printedCount: number | null;
    }[],
  ): string | null {
    if (!this.syncSqlite) return "Accepted Plan update is unavailable";
    return this.transaction((): string | null => {
      const accepted = readAcceptedPlanOperationalSnapshotInternal({
        db: this.db,
        schema: this.schema,
        tenantId: this.tenantId,
        reposDir: this.reposDir,
        sqlite: true,
        profileId,
      });
      if (accepted.kind !== "ready") return `Accepted Plan state is ${accepted.kind}`;
      if (accepted.snapshot.profile.archivedAt) return "Accepted Plan is archived";

      const targetByPartKey = new Map(accepted.snapshot.parts.map((part) => [part.partKey, part] as const));
      const changes = sourceParts.flatMap((source) => {
        const target = targetByPartKey.get(source.partKey);
        return target ? [{ source, target }] : [];
      });
      for (const { source, target } of changes) {
        if (
          source.printedCount != null &&
          (!Number.isSafeInteger(source.printedCount) ||
            source.printedCount < 0 ||
            source.printedCount > target.units.length)
        ) {
          return `Printed count is invalid for ${target.filename}`;
        }
      }

      for (const { source, target } of changes) {
        const written = this.db
          .update(this.schema.parts)
          .set(filamentAssignmentColumns(source.assignment))
          .where(and(eq(this.schema.parts.tenantId, this.tenantId), eq(this.schema.parts.id, target.projectionPartId)))
          .run();
        if (written.changes !== 1) throw new Error("Accepted Part copy failed");
        if (source.printedCount == null) continue;
        for (const unit of target.units) {
          const completed = unit.unitIndex < source.printedCount;
          const progress = this.db
            .update(this.schema.printProgress)
            .set(completed ? { completed: true } : { completed: false, assembled: false })
            .where(
              and(
                eq(this.schema.printProgress.tenantId, this.tenantId),
                eq(this.schema.printProgress.partId, target.projectionPartId),
                eq(this.schema.printProgress.unitIndex, unit.unitIndex),
              ),
            )
            .run();
          if (progress.changes !== 1) throw new Error("Accepted checkoff copy failed");
        }
      }
      return null;
    }, "immediate");
  }

  duplicateProfile(
    id: number,
    newName: string,
    options?: { clearCheckoff?: boolean },
  ): ProfileHeader & { layers: ReturnType<AppRepository["getProfileLayers"]> } {
    return this.transaction(() => {
      const trimmed = newName.trim();
      if (!trimmed) throw new Error("Profile name is required");
      const dup = this.db
        .select()
        .from(this.schema.buildProfiles)
        .where(and(eq(this.schema.buildProfiles.tenantId, this.tenantId), eq(this.schema.buildProfiles.name, trimmed)))
        .get();
      if (dup) throw new Error(`Profile already exists: ${trimmed}`);
      const source = this.db
        .select()
        .from(this.schema.buildProfiles)
        .where(and(eq(this.schema.buildProfiles.tenantId, this.tenantId), eq(this.schema.buildProfiles.id, id)))
        .get();
      if (!source) throw new Error("Profile not found");

      const newProfile = this.db
        .insert(this.schema.buildProfiles)
        .values({
          tenantId: this.tenantId,
          name: trimmed,
          orderNumber: source.orderNumber,
          specialRequest: source.specialRequest,
          // Copies are always active spine plans (templates stay archived).
          archivedAt: null,
          lastUsedAt: new Date().toISOString(),
          configModifiedAt: new Date().toISOString(),
        })
        .returning()
        .get();
      if (!newProfile) throw new Error("Failed to duplicate profile");

      const layers = this.db
        .select()
        .from(this.schema.profileLayers)
        .where(eq(this.schema.profileLayers.profileId, id))
        .all();
      for (const layer of layers) {
        this.db
          .insert(this.schema.profileLayers)
          .values({
            tenantId: this.tenantId,
            profileId: newProfile.id,
            layerOrder: layer.layerOrder,
            layerType: layer.layerType,
            projectId: layer.projectId,
          })
          .run();
      }

      const sourceAccepted = this.readAcceptedPlanOperationalSnapshot(id);
      if (layers.length > 0) {
        const published = this.publishWorkingPlan(newProfile.id, "system:duplicate", `duplicate:${newProfile.id}`);
        if (!published) throw new Error("Failed to publish duplicated Plan");
      }
      if (sourceAccepted.kind === "ready") {
        const overlayFailure = this.overlayAcceptedOperationalCopy(
          newProfile.id,
          sourceAccepted.snapshot.parts.map((part) => ({
            partKey: part.partKey,
            assignment: liveAssignmentFrom(part),
            printedCount: options?.clearCheckoff === true ? null : completedPrefixLength(part.units),
          })),
        );
        if (overlayFailure) throw new Error(`Failed to copy accepted Plan state: ${overlayFailure}`);
      }

      const roleFilaments = this.getSetting(roleFilamentSettingKey(id));
      if (roleFilaments) {
        this.setSetting(roleFilamentSettingKey(newProfile.id), roleFilaments);
      }
      const productionSetupRaw = this.getSetting(`production_setup:${id}`);
      if (productionSetupRaw) {
        try {
          const parsed = JSON.parse(productionSetupRaw) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("Invalid production setup");
          }
          const productionSetup = parsed as Record<string, unknown>;
          this.setSetting(`production_setup:${newProfile.id}`, JSON.stringify({
            ...productionSetup,
            profile_id: newProfile.id,
            updated_at: new Date().toISOString(),
          }));
        } catch {
          // A malformed optional setup must not make an otherwise valid Build impossible to duplicate.
        }
      }
      saveKitManifest(this, newProfile.id, loadKitManifest(this, id));

      return {
        ...this.getProfileHeader(newProfile.id)!,
        layers: this.getProfileLayers(newProfile.id),
      };
    }, "immediate");
  }

  removeLayer(layerId: number): void {
    const layer = this.db
      .select()
      .from(this.schema.profileLayers)
      .where(and(eq(this.schema.profileLayers.tenantId, this.tenantId), eq(this.schema.profileLayers.id, layerId)))
      .get();
    if (!layer) throw new Error("Layer not found");
    this.db.delete(this.schema.profileLayers).where(eq(this.schema.profileLayers.id, layerId)).run();
    this.markProfileConfigModified(layer.profileId);
  }

  readWorkingPlanSources(profileId: number): WorkingSourceSelection | null {
    const profile = this.db
      .select({ id: this.schema.buildProfiles.id })
      .from(this.schema.buildProfiles)
      .where(and(eq(this.schema.buildProfiles.tenantId, this.tenantId), eq(this.schema.buildProfiles.id, profileId)))
      .get();
    if (!profile) return null;
    const layers = this.db
      .select()
      .from(this.schema.profileLayers)
      .where(eq(this.schema.profileLayers.profileId, profileId))
      .orderBy(asc(this.schema.profileLayers.layerOrder), asc(this.schema.profileLayers.id))
      .all();
    const sources = layers.map((layer): WorkingSource => {
      if (layer.tenantId !== this.tenantId || layer.projectId == null) {
        throw new Error("Working Source selection ownership is corrupt");
      }
      const source = this.db
        .select({ id: this.schema.projects.id })
        .from(this.schema.projects)
        .where(and(eq(this.schema.projects.tenantId, this.tenantId), eq(this.schema.projects.id, layer.projectId)))
        .get();
      if (!source) throw new Error("Working Source selection ownership is corrupt");
      if (layer.layerType !== "base" && layer.layerType !== "addon") {
        throw new Error("Working Source selection kind is corrupt");
      }
      return { kind: layer.layerType, sourceId: source.id };
    });
    return workingSourceSelection(sources);
  }

  replaceWorkingPlanSources(command: {
    readonly profileId: number;
    readonly expectedDigest: string;
    readonly sources: readonly WorkingSource[];
  }): ReplaceWorkingPlanSourcesResult {
    if (!this.syncSqlite) return { kind: "transaction_unavailable" };
    if (!/^[a-f0-9]{64}$/.test(command.expectedDigest)) {
      throw new Error("Expected Working Source digest is invalid");
    }
    const target = workingSourceSelection(canonicalWorkingSources(command.sources));
    return this.transaction((): ReplaceWorkingPlanSourcesResult => {
      const profile = this.db
        .select()
        .from(this.schema.buildProfiles)
        .where(
          and(
            eq(this.schema.buildProfiles.tenantId, this.tenantId),
            eq(this.schema.buildProfiles.id, command.profileId),
          ),
        )
        .get();
      if (!profile) return { kind: "not_found" };
      if (profile.archivedAt != null) return { kind: "build_archived" };
      if (target.sources.length > 0) {
        const sourceIds = target.sources.map((source) => source.sourceId);
        const ownedSources = this.db
          .select({ id: this.schema.projects.id })
          .from(this.schema.projects)
          .where(and(eq(this.schema.projects.tenantId, this.tenantId), inArray(this.schema.projects.id, sourceIds)))
          .all();
        if (ownedSources.length !== sourceIds.length) return { kind: "not_found" };
      }
      const current = this.readWorkingPlanSources(command.profileId);
      if (!current) return { kind: "not_found" };
      if (workingSourcesEqual(current.sources, target.sources)) {
        return { kind: "unchanged", selection: current };
      }
      if (current.digest !== command.expectedDigest) {
        return { kind: "conflict", selection: current };
      }
      this.db
        .delete(this.schema.profileLayers)
        .where(
          and(
            eq(this.schema.profileLayers.tenantId, this.tenantId),
            eq(this.schema.profileLayers.profileId, command.profileId),
          ),
        )
        .run();
      target.sources.forEach((source, layerOrder) => {
        this.db
          .insert(this.schema.profileLayers)
          .values({
            tenantId: this.tenantId,
            profileId: command.profileId,
            layerOrder,
            layerType: source.kind,
            projectId: source.sourceId,
          })
          .run();
      });
      this.markProfileConfigModified(command.profileId);
      const persisted = this.readWorkingPlanSources(command.profileId);
      if (!persisted || !workingSourcesEqual(persisted.sources, target.sources)) {
        throw new Error("Working Source selection verification failed");
      }
      return { kind: "updated", selection: persisted };
    }, "immediate");
  }

  replaceLayer(layerId: number, projectId: number): void {
    const layer = this.db
      .select()
      .from(this.schema.profileLayers)
      .where(and(eq(this.schema.profileLayers.tenantId, this.tenantId), eq(this.schema.profileLayers.id, layerId)))
      .get();
    if (!layer) throw new Error("Layer not found");
    const project = this.getProjectRow(projectId);
    if (!project) throw new Error("Project not found");
    this.assertSourceNotAttached(layer.profileId, projectId, layer.id, project.name);
    this.db.update(this.schema.profileLayers).set({ projectId }).where(eq(this.schema.profileLayers.id, layerId)).run();
    this.markProfileConfigModified(layer.profileId);
  }

  getProfileLayers(profileId: number) {
    this.requireProfile(profileId);
    const layers = this.db
      .select()
      .from(this.schema.profileLayers)
      .where(eq(this.schema.profileLayers.profileId, profileId))
      .orderBy(asc(this.schema.profileLayers.layerOrder))
      .all();

    return layers.map((layer) => {
      let projectName: string | null = null;
      if (layer.projectId) {
        const proj = this.getProjectRow(layer.projectId);
        projectName = proj?.name ?? null;
      }
      return {
        id: layer.id,
        layer_order: layer.layerOrder,
        layer_type: layer.layerType,
        project_id: layer.projectId,
        project_name: projectName,
      };
    });
  }

  setBaseLayer(profileId: number, projectId: number): void {
    this.requireProfile(profileId);
    const project = this.getProjectRow(projectId);
    if (!project) throw new Error("Project not found");
    const existing = this.db
      .select()
      .from(this.schema.profileLayers)
      .where(and(eq(this.schema.profileLayers.profileId, profileId), eq(this.schema.profileLayers.layerType, "base")))
      .get();
    this.assertSourceNotAttached(profileId, projectId, existing?.id, project.name);
    if (existing) {
      this.db
        .update(this.schema.profileLayers)
        .set({ projectId, layerOrder: 0 })
        .where(eq(this.schema.profileLayers.id, existing.id))
        .run();
    } else {
      this.db
        .insert(this.schema.profileLayers)
        .values({
          tenantId: this.tenantId,
          profileId,
          layerOrder: 0,
          layerType: "base",
          projectId,
        })
        .run();
    }
    this.markProfileConfigModified(profileId);
  }

  addAddonLayer(profileId: number, projectId: number): void {
    this.requireProfile(profileId);
    const project = this.getProjectRow(projectId);
    if (!project) throw new Error("Project not found");
    const duplicate = this.db
      .select({ id: this.schema.profileLayers.id })
      .from(this.schema.profileLayers)
      .where(
        and(eq(this.schema.profileLayers.profileId, profileId), eq(this.schema.profileLayers.projectId, projectId)),
      )
      .get();
    if (duplicate) {
      throw new Error(`Source "${project.name}" is already attached to this build`);
    }
    const maxOrder = this.db
      .select({
        m: sql<number>`coalesce(max(${this.schema.profileLayers.layerOrder}), -1)`,
      })
      .from(this.schema.profileLayers)
      .where(eq(this.schema.profileLayers.profileId, profileId))
      .get();
    this.db
      .insert(this.schema.profileLayers)
      .values({
        tenantId: this.tenantId,
        profileId,
        layerOrder: Number(maxOrder?.m ?? -1) + 1,
        layerType: "addon",
        projectId,
      })
      .run();
    this.markProfileConfigModified(profileId);
  }

  private assertSourceNotAttached(
    profileId: number,
    projectId: number,
    exceptLayerId: number | undefined,
    projectName: string,
  ): void {
    const conditions = [
      eq(this.schema.profileLayers.tenantId, this.tenantId),
      eq(this.schema.profileLayers.profileId, profileId),
      eq(this.schema.profileLayers.projectId, projectId),
    ];
    if (exceptLayerId != null) conditions.push(ne(this.schema.profileLayers.id, exceptLayerId));
    const duplicate = this.db
      .select({ id: this.schema.profileLayers.id })
      .from(this.schema.profileLayers)
      .where(and(...conditions))
      .get();
    if (duplicate) {
      throw new Error(`Source "${projectName}" is already attached to this build`);
    }
  }

  listParts(
    profileId: number,
    limit = 10000,
    offset = 0,
  ): {
    parts: PartRow[];
    total: number;
  } {
    this.requireProfile(profileId);
    const total = this.db
      .select({ c: count() })
      .from(this.schema.parts)
      .where(eq(this.schema.parts.profileId, profileId))
      .get();
    const rows = this.db
      .select()
      .from(this.schema.parts)
      .where(eq(this.schema.parts.profileId, profileId))
      .orderBy(asc(this.schema.parts.filename))
      .limit(limit)
      .offset(offset)
      .all();
    return { parts: rows.map(partRow), total: Number(total?.c ?? 0) };
  }

  markSourceSynced(id: number, commitSha: string | null): void {
    const row = this.getProjectRow(id);
    if (!row) return;
    const metadata = parseProjectMetadata(row.metadataJson) ?? {};
    if (commitSha) {
      metadata[REMOTE_UPDATE_STATUS_KEY] = "up_to_date";
      metadata[REMOTE_CHECKED_AT_KEY] = new Date().toISOString();
    }
    this.db
      .update(this.schema.projects)
      .set({
        lastSyncedAt: new Date().toISOString(),
        lastCommitSha: commitSha,
        metadataJson: JSON.stringify(metadata),
      })
      .where(eq(this.schema.projects.id, id))
      .run();
  }

  updateImportRules(id: number, rules: string[]): { rules: string[] } {
    const row = this.getProjectRow(id);
    if (!row) throw new Error("Source not found");
    const serialized = serializeImportRules(rules);
    this.db
      .update(this.schema.projects)
      .set({ importedPaths: serialized })
      .where(eq(this.schema.projects.id, id))
      .run();
    const normalized = importRulesForProject(serialized) ?? [];
    this.markProfilesUsingProjectStale(id);
    return { rules: normalized };
  }

  listProjectIds(ids?: number[]): number[] {
    if (ids?.length) return ids;
    return this.db
      .select({ id: this.schema.projects.id })
      .from(this.schema.projects)
      .where(eq(this.schema.projects.tenantId, this.tenantId))
      .all()
      .map((r) => r.id);
  }

  getPartsGrouped(profileId: number, query = "") {
    const { parts: allParts } = this.listParts(profileId, 10000, 0);
    const q = query.trim().toLowerCase();
    const filtered = q
      ? allParts.filter((p) => p.filename.toLowerCase().includes(q) || p.relative_path.toLowerCase().includes(q))
      : allParts;

    const groups = new Map<string, PartRow[]>();
    for (const part of filtered) {
      const folder = part.relative_path.includes("/") ? part.relative_path.split("/").slice(0, -1).join("/") : "";
      const list = groups.get(folder) ?? [];
      list.push(part);
      groups.set(folder, list);
    }

    return {
      groups: [...groups.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([folder, partsList]) => ({ folder, parts: partsList })),
      total: filtered.length,
    };
  }

  private listPartRows(profileId: number): PartDbRow[] {
    this.requireProfile(profileId);
    return this.db
      .select()
      .from(this.schema.parts)
      .where(eq(this.schema.parts.profileId, profileId))
      .orderBy(asc(this.schema.parts.filename))
      .all();
  }

  getRoleFilaments(profileId: number) {
    const partRows = this.listPartRows(profileId);
    const savedDefaults = loadRoleFilamentDefaults(this, profileId);
    const order = canonicalRoleOrder();
    const buckets = new Map<
      string,
      {
        role: string;
        part_count: number;
        filament_color_id: string | null;
        filament_custom_hex: string | null;
        spoolman_spool_id: string | null;
        filament_display: string;
        filament_hex: string | null;
        colorCounts: Map<string, number>;
        customHexCounts: Map<string, number>;
        spoolCounts: Map<string, number>;
      }
    >();

    const ensureBucket = (role: string) => {
      let row = buckets.get(role);
      if (!row) {
        const saved = savedDefaults[role];
        row = {
          role,
          part_count: 0,
          filament_color_id: saved?.filament_color_id ?? null,
          filament_custom_hex: saved?.filament_custom_hex ?? null,
          spoolman_spool_id: saved?.spoolman_spool_id ?? null,
          filament_display: "",
          filament_hex: null,
          colorCounts: new Map(),
          customHexCounts: new Map(),
          spoolCounts: new Map(),
        };
        buckets.set(role, row);
      }
      return row;
    };

    for (const role of order) ensureBucket(role);

    for (const part of partRows) {
      if (!part.included) continue;
      const row = ensureBucket(normalizePartRole(part.role));
      row.part_count += 1;
      if (part.filamentColorId) {
        row.colorCounts.set(part.filamentColorId, (row.colorCounts.get(part.filamentColorId) ?? 0) + 1);
      }
      if (part.filamentCustomHex) {
        row.customHexCounts.set(part.filamentCustomHex, (row.customHexCounts.get(part.filamentCustomHex) ?? 0) + 1);
      }
      if (part.spoolmanSpoolId) {
        row.spoolCounts.set(part.spoolmanSpoolId, (row.spoolCounts.get(part.spoolmanSpoolId) ?? 0) + 1);
      }
      const color = part.filamentColorId ? getColorById(part.filamentColorId) : null;
      if (color?.combo_label && !row.filament_display) row.filament_display = color.combo_label;
      const hex = resolvePartFilamentHex(part);
      if (hex && !row.filament_hex) row.filament_hex = hex;
    }

    const majority = (counts: Map<string, number>): string | null => {
      if (!counts.size) return null;
      return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    };

    const roleSort = (role: string) => {
      const idx = order.indexOf(role);
      return idx >= 0 ? idx : order.length;
    };

    return [...buckets.values()]
      .sort((a, b) => roleSort(a.role) - roleSort(b.role) || a.role.localeCompare(b.role))
      .map((row) => {
        const colorId = majority(row.colorCounts);
        const customHex = majority(row.customHexCounts);
        const spoolId = majority(row.spoolCounts);
        const saved = savedDefaults[row.role];
        const filament_color_id =
          colorId ?? (row.part_count === 0 ? (saved?.filament_color_id ?? null) : row.filament_color_id);
        const filament_custom_hex =
          colorId != null
            ? null
            : (customHex ?? (row.part_count === 0 ? (saved?.filament_custom_hex ?? null) : row.filament_custom_hex));
        const spoolman_spool_id =
          spoolId ?? (row.part_count === 0 ? (saved?.spoolman_spool_id ?? null) : row.spoolman_spool_id);
        return {
          role: row.role,
          part_count: row.part_count,
          filament_color_id,
          spoolman_spool_id,
          filament_custom_hex,
          filament_display: row.filament_display,
          filament_hex:
            filament_custom_hex ??
            row.filament_hex ??
            (filament_color_id ? (getColorById(filament_color_id)?.hex ?? null) : null),
        };
      });
  }

  readEditableKitRecipe(profileId: number): EditableKitRecipe {
    const profile = this.db
      .select({
        id: this.schema.buildProfiles.id,
        name: this.schema.buildProfiles.name,
        orderNumber: this.schema.buildProfiles.orderNumber,
      })
      .from(this.schema.buildProfiles)
      .where(and(eq(this.schema.buildProfiles.tenantId, this.tenantId), eq(this.schema.buildProfiles.id, profileId)))
      .get();
    if (!profile) throw new Error("Profile not found");
    const layers = this.getProfileLayers(profileId);
    const layersOut = layers.map((layer) => {
      const proj = layer.project_id ? this.getProjectRow(layer.project_id) : null;
      return {
        layer_order: layer.layer_order,
        layer_type: layer.layer_type,
        project: proj ? kitLayerProjectExportRecord(kitSourceRefFromProject(proj)) : null,
      };
    });

    const partRows = this.listPartRows(profileId);
    const workingParts = partRows.map((part) => ({
      matchKey: part.matchKey,
      relativePath: part.relativePath,
      filename: part.filename,
      sourceLayer: part.sourceLayer,
      status: part.status,
      role: part.role,
      filamentColorId: part.filamentColorId,
      filamentCustomHex: part.filamentCustomHex,
      quantityInferred: part.quantityAuto,
      quantityOverride: part.quantityOverride,
      quantityEffective: part.quantityEffective,
      included: part.included,
      notes: part.notes ?? "",
      geometrySame: part.geometrySame,
      requirement: part.requirement,
      optionGroupId: part.optionGroupId,
      manifestSource: part.manifestSource,
    }));

    const sourcesOut: Array<Record<string, unknown>> = [];
    const seen = new Set<number>();
    for (const layer of layers) {
      if (!layer.project_id || seen.has(layer.project_id)) continue;
      seen.add(layer.project_id);
      const proj = this.getProjectRow(layer.project_id);
      if (!proj) continue;
      sourcesOut.push(kitSourceRefToExportRecord(kitSourceRefFromProject(proj)));
    }

    const kitManifest = loadKitManifest(this, profileId);

    return {
      profile,
      layers: layersOut,
      sources: sourcesOut,
      kitManifest,
      workingParts,
    };
  }

  importKitBundle(
    data: Record<string, unknown>,
    newName?: string | null,
  ): {
    profile_id: number;
    profile_name: string;
    parts_imported: number;
    layers_imported: number;
    warnings: string[];
    unmatched_sources: KitBundleUnmatchedSource[];
  } {
    const profileData = (data.profile as Record<string, unknown>) ?? {};
    const desired = (newName || profileData.name || "Imported kit").toString().trim() || "Imported kit";
    let name = desired;
    for (let n = 0; n < 100; n++) {
      const candidate = n === 0 ? desired : `${desired} (${n + 1})`;
      const dup = this.db
        .select()
        .from(this.schema.buildProfiles)
        .where(
          and(eq(this.schema.buildProfiles.tenantId, this.tenantId), eq(this.schema.buildProfiles.name, candidate)),
        )
        .get();
      if (!dup) {
        name = candidate;
        break;
      }
    }

    const profile = this.db
      .insert(this.schema.buildProfiles)
      .values({
        tenantId: this.tenantId,
        name,
        orderNumber: (profileData.order_number as string) ?? null,
      })
      .returning()
      .get();
    if (!profile) throw new Error("Failed to create profile");

    const warnings: string[] = [];
    const unmatched_sources: KitBundleUnmatchedSource[] = [];
    let layersImported = 0;

    const allProjects = this.db
      .select()
      .from(this.schema.projects)
      .where(eq(this.schema.projects.tenantId, this.tenantId))
      .all();

    const resolveProjectId = (ref: Record<string, unknown> | null): number | null => {
      if (!ref) return null;
      const refName = String(ref.name ?? "").trim();
      const refUrl = String(ref.url ?? "").trim();
      for (const p of allProjects) {
        if (refName && p.name === refName) return p.id;
      }
      for (const p of allProjects) {
        if (refUrl && p.url === refUrl) return p.id;
      }
      return null;
    };

    for (const sourceRef of collectKitBundleSourceRefs(data)) {
      const projectId = resolveProjectId({
        name: sourceRef.name,
        url: sourceRef.url,
      });
      if (projectId != null) {
        if (sourceRef.import_rules.length > 0) {
          this.updateImportRules(projectId, sourceRef.import_rules);
        }
        const patch = kitMatchedSourcePatch(sourceRef);
        if (Object.keys(patch).length > 0) {
          this.updateSource(projectId, patch);
        }
        continue;
      }
      unmatched_sources.push(kitUnmatchedSourceFromRef(sourceRef));
    }

    const kitManifestRaw = data.kit_manifest;
    if (kitManifestRaw && typeof kitManifestRaw === "object") {
      saveKitManifest(this, profile.id, kitManifestRaw as Partial<KitManifestRecord>);
    }

    for (const layerData of (data.layers as Array<Record<string, unknown>>) ?? []) {
      const ref = (layerData.project as Record<string, unknown>) ?? null;
      const projectId = resolveProjectId(ref);
      if (ref && projectId == null) {
        warnings.push(`Layer ${layerData.layer_type}: no local repo "${ref.name ?? ref.url}".`);
        continue;
      }
      this.db
        .insert(this.schema.profileLayers)
        .values({
          tenantId: this.tenantId,
          profileId: profile.id,
          layerOrder: Number(layerData.layer_order ?? layersImported),
          layerType: String(layerData.layer_type ?? "addon"),
          projectId,
        })
        .run();
      layersImported += 1;
    }

    const published =
      layersImported > 0 ? this.publishWorkingPlan(profile.id, "system:kit-import", `kit-import:${profile.id}`) : false;
    if (layersImported > 0 && !published) {
      warnings.push("Accepted Plan publication failed; imported filament and checkoff state was not applied.");
    }
    const accepted = published ? this.readAcceptedPlanOperationalSnapshot(profile.id) : { kind: "empty" as const };
    let partsImported = 0;
    if (accepted.kind === "ready") {
      partsImported = accepted.snapshot.parts.length;
      const overlayFailure = this.overlayAcceptedOperationalCopy(
        profile.id,
        ((data.parts as Array<Record<string, unknown>>) ?? []).map((partData) => ({
          partKey: String(partData.match_key ?? ""),
          assignment: filamentAssignmentFromRecord(partData),
          printedCount: Array.isArray(partData.print_units)
            ? completedPrefixLength(
                partData.print_units.map((completed, unitIndex) => ({
                  unitIndex,
                  completed: Boolean(completed),
                })),
              )
            : null,
        })),
      );
      if (overlayFailure) {
        warnings.push(`Accepted Plan state was not applied: ${overlayFailure}.`);
      }
    }

    return {
      profile_id: profile.id,
      profile_name: name,
      parts_imported: partsImported,
      layers_imported: layersImported,
      warnings,
      unmatched_sources,
    };
  }

  private docCountByProjectId(projectIds?: number[]): Map<number, number> {
    const map = new Map<number, number>();
    if (!this.schema.sourceDocs) return map;
    const rows = this.db
      .select({
        projectId: this.schema.sourceDocs.projectId,
        c: count(),
      })
      .from(this.schema.sourceDocs)
      .where(eq(this.schema.sourceDocs.tenantId, this.tenantId))
      .groupBy(this.schema.sourceDocs.projectId)
      .all();
    for (const row of rows) {
      if (projectIds && !projectIds.includes(row.projectId)) continue;
      map.set(row.projectId, Number(row.c) || 0);
    }
    return map;
  }

  listSourceDocs(projectId: number): SourceDocSummary[] {
    if (!this.schema.sourceDocs) return [];
    const rows = this.db
      .select()
      .from(this.schema.sourceDocs)
      .where(and(eq(this.schema.sourceDocs.tenantId, this.tenantId), eq(this.schema.sourceDocs.projectId, projectId)))
      .orderBy(asc(this.schema.sourceDocs.path))
      .all();
    return rows.map((row) => ({
      id: row.id,
      path: row.path,
      kind: row.kind,
      title: docTitleFromPath(row.path),
      size_bytes: row.sizeBytes ?? 0,
      extract_status: row.extractStatus,
      page_count: row.pageCount ?? null,
    }));
  }

  replaceSourceDocs(
    projectId: number,
    docs: Array<{
      path: string;
      kind: string;
      sizeBytes: number;
      contentHash?: string | null;
      extractStatus?: string;
      pageCount?: number | null;
      extractError?: string | null;
    }>,
  ): void {
    if (!this.schema.sourceDocs) return;
    this.db
      .delete(this.schema.sourceDocs)
      .where(and(eq(this.schema.sourceDocs.tenantId, this.tenantId), eq(this.schema.sourceDocs.projectId, projectId)))
      .run();
    const now = new Date().toISOString();
    for (const doc of docs) {
      this.db
        .insert(this.schema.sourceDocs)
        .values({
          tenantId: this.tenantId,
          projectId,
          path: doc.path,
          kind: doc.kind,
          sizeBytes: doc.sizeBytes,
          contentHash: doc.contentHash ?? null,
          extractStatus: doc.extractStatus ?? (doc.kind === "pdf" ? "pending" : "na"),
          extractError: doc.extractError ?? null,
          pageCount: doc.pageCount ?? null,
          updatedAt: now,
        })
        .run();
    }
  }

  updateSourceDocExtract(
    projectId: number,
    path: string,
    patch: {
      extractStatus: string;
      contentHash?: string | null;
      pageCount?: number | null;
      extractError?: string | null;
    },
  ): void {
    if (!this.schema.sourceDocs) return;
    this.db
      .update(this.schema.sourceDocs)
      .set({
        extractStatus: patch.extractStatus,
        contentHash: patch.contentHash ?? undefined,
        pageCount: patch.pageCount ?? undefined,
        extractError: patch.extractError ?? null,
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(this.schema.sourceDocs.tenantId, this.tenantId),
          eq(this.schema.sourceDocs.projectId, projectId),
          eq(this.schema.sourceDocs.path, path),
        ),
      )
      .run();
  }

  listPendingPdfDocs(projectId: number): SourceDocSummary[] {
    return this.listSourceDocs(projectId).filter(
      (d) => d.kind === "pdf" && (d.extract_status === "pending" || d.extract_status === "error"),
    );
  }

  listSourceNotes(projectId: number, profileId?: number | null): SourceNoteSummary[] {
    if (!this.schema.sourceNotes) return [];
    if (profileId != null) this.requireProfile(profileId);
    const rows = this.db
      .select()
      .from(this.schema.sourceNotes)
      .where(and(eq(this.schema.sourceNotes.tenantId, this.tenantId), eq(this.schema.sourceNotes.projectId, projectId)))
      .orderBy(asc(this.schema.sourceNotes.updatedAt))
      .all();
    return rows
      .filter((row) => {
        if (profileId === undefined) return true;
        if (profileId === null) return row.profileId == null;
        return row.profileId === profileId || row.profileId == null;
      })
      .map((row) => ({
        id: row.id,
        project_id: row.projectId,
        profile_id: row.profileId ?? null,
        title: row.title,
        body_markdown: row.bodyMarkdown,
        author_user_id: row.authorUserId ?? null,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
      }));
  }

  getSourceNote(noteId: number): SourceNoteSummary | null {
    if (!this.schema.sourceNotes) return null;
    const row = this.db
      .select()
      .from(this.schema.sourceNotes)
      .where(and(eq(this.schema.sourceNotes.tenantId, this.tenantId), eq(this.schema.sourceNotes.id, noteId)))
      .get();
    if (!row) return null;
    return {
      id: row.id,
      project_id: row.projectId,
      profile_id: row.profileId ?? null,
      title: row.title,
      body_markdown: row.bodyMarkdown,
      author_user_id: row.authorUserId ?? null,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    };
  }

  createSourceNote(input: {
    projectId: number;
    profileId?: number | null;
    title?: string;
    bodyMarkdown: string;
    authorUserId?: string | null;
  }): SourceNoteSummary {
    if (!this.schema.sourceNotes) throw new Error("source_notes table unavailable");
    if (input.profileId != null) this.requireProfile(input.profileId);
    const now = new Date().toISOString();
    const inserted = this.db
      .insert(this.schema.sourceNotes)
      .values({
        tenantId: this.tenantId,
        projectId: input.projectId,
        profileId: input.profileId ?? null,
        title: (input.title ?? "").trim() || "Note",
        bodyMarkdown: input.bodyMarkdown,
        authorUserId: input.authorUserId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    if (!inserted) throw new Error("Failed to create note");
    return this.getSourceNote(inserted.id)!;
  }

  updateSourceNote(
    noteId: number,
    patch: Partial<{
      title: string;
      bodyMarkdown: string;
      profileId: number | null;
    }>,
  ): SourceNoteSummary {
    if (!this.schema.sourceNotes) throw new Error("source_notes table unavailable");
    const existing = this.getSourceNote(noteId);
    if (!existing) throw new Error("Note not found");
    if (patch.profileId != null) this.requireProfile(patch.profileId);
    const updates: Partial<typeof this.schema.sourceNotes.$inferInsert> = {
      updatedAt: new Date().toISOString(),
    };
    if (patch.title != null) updates.title = patch.title.trim() || "Note";
    if (patch.bodyMarkdown != null) updates.bodyMarkdown = patch.bodyMarkdown;
    if (patch.profileId !== undefined) updates.profileId = patch.profileId;
    this.db.update(this.schema.sourceNotes).set(updates).where(eq(this.schema.sourceNotes.id, noteId)).run();
    return this.getSourceNote(noteId)!;
  }

  deleteSourceNote(noteId: number): boolean {
    if (!this.schema.sourceNotes) return false;
    const existing = this.getSourceNote(noteId);
    if (!existing) return false;
    this.db
      .delete(this.schema.sourceNotes)
      .where(and(eq(this.schema.sourceNotes.tenantId, this.tenantId), eq(this.schema.sourceNotes.id, noteId)))
      .run();
    return true;
  }

  private parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  private mapPlanDecision(row: PlanDecisionRow): PlanDecision {
    return {
      id: row.id,
      plan_id: row.profileId,
      created_at: row.createdAt,
      actor: row.actor as PlanDecisionActor,
      kind: row.kind as PlanDecisionKind,
      action_type: row.actionType ?? null,
      params: this.parseJsonObject(row.paramsJson),
      label: row.label,
      summary: row.summary,
      rationale: row.rationale ?? null,
      result: row.resultJson ? this.parseJsonObject(row.resultJson) : null,
    };
  }

  listPlanDecisions(planId: number, limit = 200): PlanDecision[] {
    if (!this.schema.planDecisions) return [];
    const rows = this.db
      .select()
      .from(this.schema.planDecisions)
      .where(
        and(eq(this.schema.planDecisions.tenantId, this.tenantId), eq(this.schema.planDecisions.profileId, planId)),
      )
      .orderBy(asc(this.schema.planDecisions.createdAt))
      .all();
    return rows.slice(-Math.max(1, limit)).map((r) => this.mapPlanDecision(r));
  }

  /** Recent plan_decisions across the tenant, optionally excluding one plan (cross-plan memory). */
  listRecentTenantPlanDecisions(limit = 200, excludePlanId?: number | null): PlanDecision[] {
    if (!this.schema.planDecisions) return [];
    const conditions = [eq(this.schema.planDecisions.tenantId, this.tenantId)];
    if (excludePlanId != null && excludePlanId > 0) {
      conditions.push(ne(this.schema.planDecisions.profileId, excludePlanId));
    }
    const rows = this.db
      .select()
      .from(this.schema.planDecisions)
      .where(and(...conditions))
      .orderBy(asc(this.schema.planDecisions.createdAt))
      .all();
    return rows.slice(-Math.max(1, limit)).map((r) => this.mapPlanDecision(r));
  }

  createPlanDecision(input: {
    planId: number;
    actor: PlanDecisionActor;
    kind: PlanDecisionKind;
    actionType?: string | null;
    params?: Record<string, unknown>;
    label?: string;
    summary?: string;
    rationale?: string | null;
    result?: Record<string, unknown> | null;
  }): PlanDecision {
    if (!this.schema.planDecisions) throw new Error("plan_decisions table unavailable");
    this.requireProfile(input.planId);
    const now = new Date().toISOString();
    const inserted = this.db
      .insert(this.schema.planDecisions)
      .values({
        tenantId: this.tenantId,
        profileId: input.planId,
        createdAt: now,
        actor: input.actor,
        kind: input.kind,
        actionType: input.actionType ?? null,
        paramsJson: JSON.stringify(input.params ?? {}),
        label: input.label ?? "",
        summary: input.summary ?? "",
        rationale: input.rationale ?? null,
        resultJson: input.result != null ? JSON.stringify(input.result) : null,
      })
      .returning()
      .get();
    return this.mapPlanDecision(inserted);
  }

  /** Delete plan_decisions for one plan (tenant-scoped). Returns rows removed. */
  deletePlanDecisionsForPlan(planId: number): number {
    if (!this.schema.planDecisions) return 0;
    if (!planId || planId <= 0) return 0;
    this.requireProfile(planId);
    const before = this.listPlanDecisions(planId, 10_000).length;
    if (before === 0) return 0;
    this.db
      .delete(this.schema.planDecisions)
      .where(
        and(eq(this.schema.planDecisions.tenantId, this.tenantId), eq(this.schema.planDecisions.profileId, planId)),
      )
      .run();
    return before;
  }

  /** Delete all plan_decisions for this tenant. Returns rows removed. */
  deleteAllPlanDecisions(): number {
    if (!this.schema.planDecisions) return 0;
    const before = this.listRecentTenantPlanDecisions(10_000, null).length;
    if (before === 0) return 0;
    this.db.delete(this.schema.planDecisions).where(eq(this.schema.planDecisions.tenantId, this.tenantId)).run();
    return before;
  }

  private mapPlanSnapshotSummary(row: PlanSnapshotRow): PlanSnapshotSummary {
    return {
      id: row.id,
      plan_id: row.profileId,
      name: row.name,
      created_at: row.createdAt,
      source: row.source as PlanSnapshotSource,
    };
  }

  listPlanSnapshots(planId: number): PlanSnapshotSummary[] {
    if (!this.schema.planSnapshots) return [];
    const rows = this.db
      .select()
      .from(this.schema.planSnapshots)
      .where(
        and(eq(this.schema.planSnapshots.tenantId, this.tenantId), eq(this.schema.planSnapshots.profileId, planId)),
      )
      .orderBy(asc(this.schema.planSnapshots.createdAt))
      .all();
    return rows.map((r) => this.mapPlanSnapshotSummary(r));
  }

  getPlanSnapshot(snapshotId: number): PlanSnapshot | null {
    if (!this.schema.planSnapshots) return null;
    const row = this.db
      .select()
      .from(this.schema.planSnapshots)
      .where(and(eq(this.schema.planSnapshots.tenantId, this.tenantId), eq(this.schema.planSnapshots.id, snapshotId)))
      .get();
    if (!row) return null;
    return {
      ...this.mapPlanSnapshotSummary(row),
      payload: this.parseJsonObject(row.payloadJson),
    };
  }

  createPlanSnapshot(input: {
    planId: number;
    name: string;
    source: PlanSnapshotSource;
    payload: Record<string, unknown>;
  }): PlanSnapshot {
    if (!this.schema.planSnapshots) throw new Error("plan_snapshots table unavailable");
    this.requireProfile(input.planId);
    const now = new Date().toISOString();
    const inserted = this.db
      .insert(this.schema.planSnapshots)
      .values({
        tenantId: this.tenantId,
        profileId: input.planId,
        name: input.name,
        createdAt: now,
        source: input.source,
        payloadJson: JSON.stringify(input.payload ?? {}),
      })
      .returning()
      .get();
    return {
      ...this.mapPlanSnapshotSummary(inserted),
      payload: this.parseJsonObject(inserted.payloadJson),
    };
  }

  deletePlanSnapshot(snapshotId: number): boolean {
    if (!this.schema.planSnapshots) return false;
    const existing = this.getPlanSnapshot(snapshotId);
    if (!existing) return false;
    this.db
      .delete(this.schema.planSnapshots)
      .where(and(eq(this.schema.planSnapshots.tenantId, this.tenantId), eq(this.schema.planSnapshots.id, snapshotId)))
      .run();
    return true;
  }

  // ── Print jobs (SQL history, replaces blob store) ──────────────────────────

  insertPrintJob(job: {
    id: string;
    profileId: number;
    hostIntegrationId?: string;
    printerId?: string;
    material?: string;
    filename?: string;
    status?: string;
    filamentConsumedG?: number;
    at: string;
    completedAt?: string;
    linkId?: string;
  }): PrintJobRow {
    this.requireProfile(job.profileId);
    const inserted = this.db
      .insert(this.schema.printJobs)
      .values({
        id: job.id,
        tenantId: this.tenantId,
        profileId: job.profileId,
        hostIntegrationId: job.hostIntegrationId ?? null,
        printerId: job.printerId ?? "",
        material: job.material ?? "",
        filename: job.filename ?? null,
        status: job.status ?? "sent",
        filamentConsumedG: job.filamentConsumedG ?? null,
        at: job.at,
        completedAt: job.completedAt ?? null,
        linkId: job.linkId ?? null,
      })
      .returning()
      .get();
    if (!inserted) throw new Error("Failed to insert print job");
    return inserted;
  }

  /**
   * Print jobs at/after `sinceIso`, most recent first, capped at `limit`.
   * Used by get_print_stats (assistant MCP tool) and the Discord morning
   * digest. Goes through Drizzle's query builder (works on both the
   * better-sqlite3 sync driver and the Postgres async-wrapped driver) —
   * do NOT reach for `(repo as any).db.prepare(...)`, since `this.db` is a
   * Drizzle instance, not a raw better-sqlite3 handle, and has no `.prepare`.
   */
  recentPrintJobs(sinceIso: string, limit = 100): PrintJobRow[] {
    return this.db
      .select()
      .from(this.schema.printJobs)
      .where(and(eq(this.schema.printJobs.tenantId, this.tenantId), gte(this.schema.printJobs.at, sinceIso)))
      .orderBy(desc(this.schema.printJobs.at))
      .limit(limit)
      .all();
  }

  insertPrintJobParts(
    parts: Array<{
      id: string;
      jobId?: string;
      at: string;
      profileId: number;
      partId: number;
      unitIndex: number;
      result: string;
      reason?: string;
      note?: string;
      hostIntegrationId?: string;
      filename?: string;
      matchKey?: string;
      role?: string;
      filamentDisplay?: string;
      linkId?: string;
    }>,
  ): PrintJobPartRow[] {
    if (!parts.length) return [];
    for (const profileId of new Set(parts.map((part) => part.profileId))) {
      this.requireProfile(profileId);
    }
    const inserted = this.db
      .insert(this.schema.printJobParts)
      .values(
        parts.map((p) => ({
          id: p.id,
          tenantId: this.tenantId,
          jobId: p.jobId ?? null,
          at: p.at,
          profileId: p.profileId,
          partId: p.partId,
          unitIndex: p.unitIndex,
          result: p.result,
          reason: p.reason ?? null,
          note: p.note ?? null,
          hostIntegrationId: p.hostIntegrationId ?? null,
          filename: p.filename ?? null,
          matchKey: p.matchKey ?? null,
          role: p.role ?? null,
          filamentDisplay: p.filamentDisplay ?? null,
          linkId: p.linkId ?? null,
        })),
      )
      .returning()
      .all();
    return inserted;
  }

  /**
   * Returns aggregate print-job counters grouped by (printer_id, material, status)
   * for the current tenant. Used by the Prometheus /metrics endpoint.
   */
  printJobMetrics(): Array<{
    printer_id: string;
    material: string;
    status: string;
    cnt: number;
    filament_sum: number | null;
  }> {
    const tenantId = this.tenantId;
    return this.db
      .select({
        printer_id: this.schema.printJobs.printerId,
        material: this.schema.printJobs.material,
        status: this.schema.printJobs.status,
        cnt: sql<number>`COUNT(*)`,
        filament_sum: sql<number | null>`SUM(${this.schema.printJobs.filamentConsumedG})`,
      })
      .from(this.schema.printJobs)
      .where(eq(this.schema.printJobs.tenantId, tenantId))
      .groupBy(this.schema.printJobs.printerId, this.schema.printJobs.material, this.schema.printJobs.status)
      .all() as Array<{
      printer_id: string;
      material: string;
      status: string;
      cnt: number;
      filament_sum: number | null;
    }>;
  }

  listPrintJobParts(profileId: number): PrintJobPartRow[] {
    return this.db
      .select()
      .from(this.schema.printJobParts)
      .where(
        and(eq(this.schema.printJobParts.tenantId, this.tenantId), eq(this.schema.printJobParts.profileId, profileId)),
      )
      .orderBy(asc(this.schema.printJobParts.at))
      .all();
  }
}
