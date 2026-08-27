import { and, asc, eq, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import type { DrizzleDb } from "./client.js";
import * as defaultSchema from "./schema.js";
import {
  readAcceptedPlanOperationalSnapshotInternal,
  type AcceptedOperationalArtifact,
  type AcceptedPlanOperationalSnapshot,
} from "./accepted-plan-operational.js";
import { acceptedPlanBasis, type AcceptedPlanBasis } from "./accepted-plan-progress.js";
import { parseRequiredUnitToken, type RequiredUnitToken } from "../services/required-units.js";
import { resolvePartFilamentHex } from "../services/filament-catalog.js";
import {
  layoutDigest,
  LEGACY_ACCEPTED_PLATE_LAYOUT_FORMAT,
  unitDimensionsFitPrintableArea,
  unitPinned,
  unitPlacement,
  storedInteger,
  validatePlates,
  type ValidatedPlate,
} from "./accepted-plate-layout-model.js";

export { ACCEPTED_PLATE_LAYOUT_FORMAT, MAX_ACCEPTED_PLATE_UM } from "./accepted-plate-layout-model.js";

export class AcceptedPlateIntegrityError extends Error {
  readonly name = "AcceptedPlateIntegrityError";

  constructor(readonly code: "head" | "revision" | "counts" | "layout_digest" | "layout") {
    super(`Accepted Plate integrity check failed: ${code}`);
  }
}

export type AcceptedPlateUnitInput = Readonly<{
  token: string;
  xUm: number;
  yUm: number;
  widthUm: number;
  depthUm: number;
  heightUm: number;
  placement?: "auto" | "manual" | "unplaced";
  pinned?: boolean;
}>;

export type AcceptedPlateInput = Readonly<{
  plateId: string;
  printerId: string;
  printerName: string;
  printerModel: string;
  bedWidthUm: number;
  bedDepthUm: number;
  bedHeightUm: number;
  marginUm: number;
  units: readonly AcceptedPlateUnitInput[];
}>;

export type AcceptedPlate = Omit<AcceptedPlateInput, "units"> &
  Readonly<{
    ordinal: number;
    units: readonly (AcceptedPlateUnitInput & Readonly<{ objectName: string }>)[];
  }>;

export type PublishAcceptedPlatesCommand = Readonly<{
  profileId: number;
  expected: AcceptedPlanBasis;
  expectedPlateRevisionId: number | null;
  plates: readonly AcceptedPlateInput[];
  undoFromRevisionId?: number | null;
}>;

export type MoveAcceptedPlateUnitCommand = Readonly<{
  profileId: number;
  expected: AcceptedPlanBasis;
  expectedPlateRevisionId: number;
  plateId: string;
  token: string;
  xUm: number;
  yUm: number;
}>;

type AcceptedPlateUnitCommand = Readonly<{
  profileId: number;
  expected: AcceptedPlanBasis;
  expectedPlateRevisionId: number;
  plateId: string;
  token: string;
}>;

export type PinAcceptedPlateUnitCommand = AcceptedPlateUnitCommand & Readonly<{ pinned: boolean }>;
export type UnplaceAcceptedPlateUnitCommand = AcceptedPlateUnitCommand;
export type TransferAcceptedPlateUnitCommand = AcceptedPlateUnitCommand & (
  | Readonly<{ targetPlateId: string }>
  | Readonly<{ targetPrinter: Omit<AcceptedPlateInput, "plateId" | "units"> }>
);
export type RestoreAcceptedPlatesCommand = Readonly<{
  profileId: number;
  expected: AcceptedPlanBasis;
  expectedPlateRevisionId: number;
  restorePlateRevisionId: number;
}>;

type AcceptedPlateFailure =
  | { readonly kind: "accepted_state_unavailable"; readonly reason: "compatibility_dirty" | "uninitialized" }
  | { readonly kind: "stale_accepted_plan" }
  | { readonly kind: "plan_archived" }
  | { readonly kind: "invalid_units" }
  | {
      readonly kind: "invalid_geometry";
      readonly reason: "outside_build_area" | "overlapping_units";
    }
  | { readonly kind: "transaction_unavailable" };

export type PublishAcceptedPlatesResult =
  | {
      readonly kind: "published";
      readonly plateRevisionId: number;
      readonly plateRevisionNumber: number;
    }
  | {
      readonly kind: "unchanged";
      readonly plateRevisionId: number;
      readonly plateRevisionNumber: number;
    }
  | { readonly kind: "plate_revision_changed" }
  | AcceptedPlateFailure;

export type MoveAcceptedPlateUnitResult =
  | {
      readonly kind: "moved";
      readonly plateRevisionId: number;
      readonly plateRevisionNumber: number;
    }
  | {
      readonly kind: "unchanged";
      readonly plateRevisionId: number;
      readonly plateRevisionNumber: number;
    }
  | { readonly kind: "plate_revision_changed" | "unit_not_found" }
  | AcceptedPlateFailure;

export type PinAcceptedPlateUnitResult = MoveAcceptedPlateUnitResult;
export type UnplaceAcceptedPlateUnitResult = MoveAcceptedPlateUnitResult;
export type TransferAcceptedPlateUnitResult = MoveAcceptedPlateUnitResult;
export type RestoreAcceptedPlatesResult =
  | { readonly kind: "restored"; readonly plateRevisionId: number; readonly plateRevisionNumber: number }
  | { readonly kind: "unchanged"; readonly plateRevisionId: number; readonly plateRevisionNumber: number }
  | { readonly kind: "plate_revision_changed" | "unit_not_found" }
  | AcceptedPlateFailure;

export type ReadAcceptedPlatesResult =
  | {
      readonly kind: "empty";
      readonly basis: AcceptedPlanBasis;
      readonly plates: readonly [];
    }
  | {
      readonly kind: "ready";
      readonly basis: AcceptedPlanBasis;
      readonly plateRevisionId: number;
      readonly plateRevisionNumber: number;
      readonly plates: readonly AcceptedPlate[];
    }
  | { readonly kind: "empty_plan" }
  | { readonly kind: "stale_accepted_plan" }
  | { readonly kind: "accepted_state_unavailable"; readonly reason: "compatibility_dirty" | "uninitialized" }
  | { readonly kind: "transaction_unavailable" };

export type AcceptedPlateExportUnit = Readonly<{
  token: RequiredUnitToken;
  objectName: string;
  xUm: number;
  yUm: number;
  widthUm: number;
  depthUm: number;
  heightUm: number;
  artifact: AcceptedOperationalArtifact;
}>;

export type AcceptedPlateExportInput = Readonly<{
  basis: AcceptedPlanBasis;
  plateRevisionId: number;
  plateRevisionNumber: number;
  layoutDigest: string;
  plates: readonly Readonly<{
    plateId: string;
    ordinal: number;
    printerId: string;
    printerName: string;
    printerModel: string;
    bedWidthUm: number;
    bedDepthUm: number;
    bedHeightUm: number;
    marginUm: number;
    units: readonly AcceptedPlateExportUnit[];
  }>[];
}>;

export type ReadAcceptedPlateExportInputResult =
  | { readonly kind: "ready"; readonly input: AcceptedPlateExportInput }
  | { readonly kind: "empty_plan" | "plates_not_published" | "stale_accepted_plan" | "unplaced_units" }
  | { readonly kind: "accepted_state_unavailable"; readonly reason: "compatibility_dirty" | "uninitialized" }
  | { readonly kind: "transaction_unavailable" };

export type AcceptedPlateSetupUnit = Readonly<{
  token: RequiredUnitToken;
  partId: number | null;
  objectName: string;
  filename: string;
  relativePath: string;
  sourceDirectory: string;
  sourceLayer: string;
  role: string;
  filamentColorId: string | null;
  filamentCustomHex?: string | null;
  filamentHex?: string | null;
  completed?: boolean;
  artifact: AcceptedOperationalArtifact;
}>;

export type ReadAcceptedPlateWorkspaceInputResult =
  | {
      readonly kind: "setup";
      readonly basis: AcceptedPlanBasis;
      readonly expectedPlateRevisionId: number | null;
      readonly units: readonly AcceptedPlateSetupUnit[];
    }
  | {
      readonly kind: "ready";
      readonly basis: AcceptedPlanBasis;
      readonly expectedPlateRevisionId: number;
      readonly plateRevisionId: number;
      readonly plateRevisionNumber: number;
      readonly plates: readonly AcceptedPlate[];
      readonly units: readonly AcceptedPlateSetupUnit[];
      readonly undoFromRevisionId: number | null;
    }
  | { readonly kind: "profile_not_found" }
  | { readonly kind: "empty_plan" }
  | { readonly kind: "accepted_state_unavailable"; readonly reason: "compatibility_dirty" | "uninitialized" }
  | { readonly kind: "transaction_unavailable" };

export type AcceptedPlateSchema = Pick<
  typeof defaultSchema,
  | "acceptedPlateHeads"
  | "acceptedPlateRevisions"
  | "acceptedPlates"
  | "acceptedPlateUnits"
  | "buildProfiles"
  | "parts"
  | "planAcceptedInputSets"
  | "planRevisions"
  | "planRevisionParts"
  | "requiredUnits"
  | "planRevisionRequiredUnitSets"
  | "planRevisionRequiredUnits"
  | "planRevisionInputSets"
  | "planRevisionInputs"
  | "projects"
  | "sourceRevisions"
  | "printProgress"
>;

export type AcceptedPlateDependencies = Readonly<{
  db: DrizzleDb;
  schema: AcceptedPlateSchema;
  tenantId: string;
  reposDir: string;
  sqlite: boolean;
  transaction: <T>(operation: () => T) => T;
  readTransaction: <T>(operation: () => T) => T;
  clock?: () => Date;
}>;

function sameBasis(snapshot: AcceptedPlanOperationalSnapshot, expected: AcceptedPlanBasis): boolean {
  const actual = acceptedPlanBasis(snapshot);
  return (
    actual.profileId === expected.profileId &&
    actual.planVersion === expected.planVersion &&
    actual.revisionId === expected.revisionId &&
    actual.revisionDigest === expected.revisionDigest &&
    actual.requiredUnitMappingDigest === expected.requiredUnitMappingDigest
  );
}

function visibleProfile(dependencies: AcceptedPlateDependencies, profileId: number): boolean {
  return (
    dependencies.db
      .select({ id: dependencies.schema.buildProfiles.id })
      .from(dependencies.schema.buildProfiles)
      .where(
        and(
          eq(dependencies.schema.buildProfiles.tenantId, dependencies.tenantId),
          eq(dependencies.schema.buildProfiles.id, profileId),
        ),
      )
      .get() != null
  );
}

function currentAccepted(
  dependencies: AcceptedPlateDependencies,
  expected: AcceptedPlanBasis,
):
  | { readonly kind: "ready"; readonly snapshot: AcceptedPlanOperationalSnapshot }
  | AcceptedPlateFailure {
  if (!visibleProfile(dependencies, expected.profileId)) return { kind: "stale_accepted_plan" };
  const accepted = readAcceptedPlanOperationalSnapshotInternal({
    db: dependencies.db,
    schema: dependencies.schema,
    tenantId: dependencies.tenantId,
    profileId: expected.profileId,
    reposDir: dependencies.reposDir,
    sqlite: dependencies.sqlite,
  });
  if (accepted.kind === "empty") return { kind: "stale_accepted_plan" };
  if (accepted.kind !== "ready") {
    return { kind: "accepted_state_unavailable", reason: accepted.kind };
  }
  if (!sameBasis(accepted.snapshot, expected)) return { kind: "stale_accepted_plan" };
  if (accepted.snapshot.profile.archivedAt != null) return { kind: "plan_archived" };
  return accepted;
}

function requiredObjectNames(snapshot: AcceptedPlanOperationalSnapshot): Map<string, string> {
  return new Map(
    snapshot.parts
      .filter((part) => part.included)
      .flatMap((part) => part.units)
      .filter((unit) => unit.required)
      .map((unit) => [unit.token, unit.objectName]),
  );
}

function newAcceptedPlateId(): string {
  return `plate_${randomBytes(16).toString("hex")}`;
}

function insertRevision(
  dependencies: AcceptedPlateDependencies,
  snapshot: AcceptedPlanOperationalSnapshot,
  revisionNumber: number,
  plates: readonly ValidatedPlate[],
  undoFromRevisionId: number | null = null,
): number {
  const unitCount = plates.reduce((count, plate) => count + plate.units.length, 0);
  const created = dependencies.db
    .insert(dependencies.schema.acceptedPlateRevisions)
    .values({
      tenantId: dependencies.tenantId,
      profileId: snapshot.profile.id,
      planRevisionId: snapshot.revisionId,
      planVersion: snapshot.planVersion,
      planRevisionDigest: snapshot.revisionDigest,
      requiredUnitMappingDigest: snapshot.requiredUnitMappingDigest,
      layoutDigest: layoutDigest(plates),
      expectedPlateCount: plates.length,
      expectedUnitCount: unitCount,
      revisionNumber,
      undoFromRevisionId,
      createdAt: (dependencies.clock?.() ?? new Date()).toISOString(),
    })
    .returning({ id: dependencies.schema.acceptedPlateRevisions.id })
    .get();
  if (!created) throw new Error("Accepted Plate revision could not be created");
  for (const plate of plates) {
    dependencies.db
      .insert(dependencies.schema.acceptedPlates)
      .values({
        tenantId: dependencies.tenantId,
        revisionId: created.id,
        plateId: plate.plateId,
        ordinal: plate.ordinal,
        printerId: plate.printerId,
        printerName: plate.printerName,
        printerModel: plate.printerModel,
        bedWidthUm: plate.bedWidthUm,
        bedDepthUm: plate.bedDepthUm,
        bedHeightUm: plate.bedHeightUm,
        marginUm: plate.marginUm,
      })
      .run();
    for (const unit of plate.units) {
      dependencies.db
        .insert(dependencies.schema.acceptedPlateUnits)
        .values({
          tenantId: dependencies.tenantId,
          revisionId: created.id,
          plateId: plate.plateId,
          requiredUnitToken: unit.token,
          xUm: unit.xUm,
          yUm: unit.yUm,
          widthUm: unit.widthUm,
          depthUm: unit.depthUm,
          heightUm: unit.heightUm,
          placement: unitPlacement(unit),
          pinned: unitPinned(unit),
        })
        .run();
    }
  }
  return created.id;
}

function readStoredPlates(
  dependencies: AcceptedPlateDependencies,
  revisionId: number,
  expectedPlateCount: number,
  expectedUnitCount: number,
  expectedTokens: ReadonlySet<string>,
  expectedDigest: string,
): readonly ValidatedPlate[] {
  const units = dependencies.db
    .select()
    .from(dependencies.schema.acceptedPlateUnits)
    .where(eq(dependencies.schema.acceptedPlateUnits.revisionId, revisionId))
    .orderBy(asc(dependencies.schema.acceptedPlateUnits.requiredUnitToken))
    .all();
  const plateRows = dependencies.db
    .select()
    .from(dependencies.schema.acceptedPlates)
    .where(eq(dependencies.schema.acceptedPlates.revisionId, revisionId))
    .orderBy(asc(dependencies.schema.acceptedPlates.ordinal))
    .all();
  if (plateRows.length !== expectedPlateCount || units.length !== expectedUnitCount) {
    throw new AcceptedPlateIntegrityError("counts");
  }
  if (
    plateRows.some((plate) => plate.tenantId !== dependencies.tenantId) ||
    units.some((unit) => unit.tenantId !== dependencies.tenantId)
  ) {
    throw new AcceptedPlateIntegrityError("layout");
  }
  const plateIds = new Set(plateRows.map((plate) => plate.plateId));
  if (units.some((unit) => !plateIds.has(unit.plateId))) {
    throw new AcceptedPlateIntegrityError("layout");
  }
  if (plateRows.some((plate, index) => plate.ordinal !== index + 1)) {
    throw new AcceptedPlateIntegrityError("layout");
  }
  const stored: AcceptedPlateInput[] = plateRows.map((plate) => ({
    plateId: plate.plateId,
    printerId: plate.printerId,
    printerName: plate.printerName,
    printerModel: plate.printerModel,
    bedWidthUm: plate.bedWidthUm,
    bedDepthUm: plate.bedDepthUm,
    bedHeightUm: plate.bedHeightUm,
    marginUm: plate.marginUm,
    units: units
      .filter((unit) => unit.plateId === plate.plateId)
      .map((unit) => ({
        token: unit.requiredUnitToken,
        xUm: unit.xUm,
        yUm: unit.yUm,
        widthUm: unit.widthUm,
        depthUm: unit.depthUm,
        heightUm: unit.heightUm,
        placement: unit.placement === "manual" || unit.placement === "unplaced" ? unit.placement : "auto",
        pinned: unit.pinned === true,
      })),
  }));
  const legacy = validatePlates(stored, expectedTokens, false, "overlap_only");
  if (legacy.kind !== "ready") throw new AcceptedPlateIntegrityError("layout");
  if (layoutDigest(legacy.plates, LEGACY_ACCEPTED_PLATE_LAYOUT_FORMAT) === expectedDigest) {
    return legacy.plates;
  }
  const current = validatePlates(stored, expectedTokens, false);
  if (current.kind !== "ready") throw new AcceptedPlateIntegrityError("layout");
  if (layoutDigest(current.plates) !== expectedDigest) {
    throw new AcceptedPlateIntegrityError("layout_digest");
  }
  return current.plates;
}

type AcceptedPlateStateResult =
  | {
      readonly kind: "ready";
      readonly basis: AcceptedPlanBasis;
      readonly snapshot: AcceptedPlanOperationalSnapshot;
      readonly plateRevisionId: number;
      readonly plateRevisionNumber: number;
      readonly layoutDigest: string;
      readonly undoFromRevisionId: number | null;
      readonly plates: readonly AcceptedPlate[];
    }
  | {
      readonly kind: "empty";
      readonly basis: AcceptedPlanBasis;
      readonly snapshot: AcceptedPlanOperationalSnapshot;
    }
  | {
      readonly kind: "stale_accepted_plan";
      readonly basis: AcceptedPlanBasis;
      readonly snapshot: AcceptedPlanOperationalSnapshot;
      readonly expectedPlateRevisionId: number;
    }
  | { readonly kind: "profile_not_found" }
  | { readonly kind: "empty_plan" }
  | { readonly kind: "accepted_state_unavailable"; readonly reason: "compatibility_dirty" | "uninitialized" };

function readAcceptedPlateState(
  dependencies: AcceptedPlateDependencies,
  profileId: number,
): AcceptedPlateStateResult {
    if (!visibleProfile(dependencies, profileId)) return { kind: "profile_not_found" };
    const accepted = readAcceptedPlanOperationalSnapshotInternal({
      db: dependencies.db,
      schema: dependencies.schema,
      tenantId: dependencies.tenantId,
      profileId,
      reposDir: dependencies.reposDir,
      sqlite: dependencies.sqlite,
    });
    if (accepted.kind === "empty") return { kind: "empty_plan" };
    if (accepted.kind !== "ready") {
      return { kind: "accepted_state_unavailable", reason: accepted.kind };
    }
    const basis = acceptedPlanBasis(accepted.snapshot);
    const head = dependencies.db
      .select()
      .from(dependencies.schema.acceptedPlateHeads)
      .where(
        and(
          eq(dependencies.schema.acceptedPlateHeads.tenantId, dependencies.tenantId),
          eq(dependencies.schema.acceptedPlateHeads.profileId, profileId),
        ),
      )
      .get();
    if (!head) return { kind: "empty", basis, snapshot: accepted.snapshot };
    const revision = dependencies.db
      .select()
      .from(dependencies.schema.acceptedPlateRevisions)
      .where(
        and(
          eq(dependencies.schema.acceptedPlateRevisions.tenantId, dependencies.tenantId),
          eq(dependencies.schema.acceptedPlateRevisions.profileId, profileId),
          eq(dependencies.schema.acceptedPlateRevisions.id, head.currentRevisionId),
        ),
      )
      .get();
    if (!revision) throw new AcceptedPlateIntegrityError("head");
    if (
      revision.planRevisionId !== basis.revisionId ||
      revision.planVersion !== basis.planVersion ||
      revision.planRevisionDigest !== basis.revisionDigest ||
      revision.requiredUnitMappingDigest !== basis.requiredUnitMappingDigest
    ) {
      return {
        kind: "stale_accepted_plan",
        basis,
        snapshot: accepted.snapshot,
        expectedPlateRevisionId: head.currentRevisionId,
      };
    }
    if (
      !storedInteger(revision.expectedPlateCount) ||
      revision.expectedPlateCount === 0 ||
      !storedInteger(revision.expectedUnitCount) ||
      revision.expectedUnitCount === 0 ||
      !/^[a-f0-9]{64}$/.test(revision.layoutDigest)
    ) {
      throw new AcceptedPlateIntegrityError("revision");
    }
    const objectNames = requiredObjectNames(accepted.snapshot);
    const stored = readStoredPlates(
      dependencies,
      revision.id,
      revision.expectedPlateCount,
      revision.expectedUnitCount,
      new Set(objectNames.keys()),
      revision.layoutDigest,
    );
    return {
      kind: "ready",
      basis,
      snapshot: accepted.snapshot,
      plateRevisionId: revision.id,
      plateRevisionNumber: revision.revisionNumber,
      layoutDigest: revision.layoutDigest,
      undoFromRevisionId: revision.undoFromRevisionId ?? null,
      plates: stored.map((plate) => ({
        ...plate,
        units: plate.units.map((unit) => {
          const objectName = objectNames.get(unit.token);
          if (!objectName) throw new AcceptedPlateIntegrityError("layout");
          return { ...unit, objectName };
        }),
      })),
    };
}

export function readAcceptedPlatesInternal(
  dependencies: AcceptedPlateDependencies,
  profileId: number,
): ReadAcceptedPlatesResult {
  if (!dependencies.sqlite) return { kind: "transaction_unavailable" };
  return dependencies.readTransaction(() => {
    const state = readAcceptedPlateState(dependencies, profileId);
    if (state.kind === "profile_not_found") return { kind: "empty_plan" };
    if (state.kind === "stale_accepted_plan") return { kind: "stale_accepted_plan" };
    if (state.kind === "empty") return { kind: "empty", basis: state.basis, plates: [] };
    if (state.kind !== "ready") return state;
    const { snapshot: _snapshot, layoutDigest: _layoutDigest, undoFromRevisionId: _undo, ...result } = state;
    return result;
  });
}

export function readAcceptedPlateExportInputInternal(
  dependencies: AcceptedPlateDependencies,
  profileId: number,
): ReadAcceptedPlateExportInputResult {
  if (!dependencies.sqlite) return { kind: "transaction_unavailable" };
  return dependencies.readTransaction(() => {
    const state = readAcceptedPlateState(dependencies, profileId);
    if (state.kind === "empty") return { kind: "plates_not_published" };
    if (state.kind === "profile_not_found") return { kind: "empty_plan" };
    if (state.kind === "stale_accepted_plan") return { kind: "stale_accepted_plan" };
    if (state.kind !== "ready") return state;
    if (state.plates.some((plate) => plate.units.some((unit) => unitPlacement(unit) === "unplaced"))) {
      return { kind: "unplaced_units" };
    }
    const artifactByToken = new Map<string, AcceptedOperationalArtifact>();
    for (const part of state.snapshot.parts) {
      if (!part.included) continue;
      for (const unit of part.units) {
        if (unit.required) artifactByToken.set(unit.token, part.artifact);
      }
    }
    return {
      kind: "ready",
      input: {
        basis: state.basis,
        plateRevisionId: state.plateRevisionId,
        plateRevisionNumber: state.plateRevisionNumber,
        layoutDigest: state.layoutDigest,
        plates: state.plates.map((plate) => ({
          plateId: plate.plateId,
          ordinal: plate.ordinal,
          printerId: plate.printerId,
          printerName: plate.printerName,
          printerModel: plate.printerModel,
          bedWidthUm: plate.bedWidthUm,
          bedDepthUm: plate.bedDepthUm,
          bedHeightUm: plate.bedHeightUm,
          marginUm: plate.marginUm,
          units: plate.units.map((unit) => {
            const artifact = artifactByToken.get(unit.token);
            if (!artifact) throw new AcceptedPlateIntegrityError("layout");
            return {
              token: parseRequiredUnitToken(unit.token),
              objectName: unit.objectName,
              xUm: unit.xUm,
              yUm: unit.yUm,
              widthUm: unit.widthUm,
              depthUm: unit.depthUm,
              heightUm: unit.heightUm,
              artifact,
            };
          }),
        })),
      },
    };
  });
}

function acceptedPlateSetupUnits(snapshot: AcceptedPlanOperationalSnapshot): AcceptedPlateSetupUnit[] {
  return snapshot.parts
    .filter((part) => part.included)
    .flatMap((part) => part.units
      .filter((unit) => unit.required)
      .map((unit) => ({
        token: parseRequiredUnitToken(unit.token),
        partId: part.projectionPartId,
        objectName: unit.objectName,
        filename: part.filename,
        relativePath: part.relativePath,
        sourceDirectory: part.relativePath.includes("/")
          ? part.relativePath.slice(0, part.relativePath.lastIndexOf("/"))
          : "",
        sourceLayer: part.sourceLayer,
        role: part.effectiveRole,
        filamentColorId: part.filamentColorId,
        filamentCustomHex: part.filamentCustomHex,
        filamentHex: resolvePartFilamentHex(part),
        completed: unit.completed,
        artifact: part.artifact,
      })));
}

export function readAcceptedPlateWorkspaceInputInternal(
  dependencies: AcceptedPlateDependencies,
  profileId: number,
): ReadAcceptedPlateWorkspaceInputResult {
  if (!dependencies.sqlite) return { kind: "transaction_unavailable" };
  return dependencies.readTransaction(() => {
    const state = readAcceptedPlateState(dependencies, profileId);
    if (state.kind === "profile_not_found" || state.kind === "empty_plan" || state.kind === "accepted_state_unavailable") {
      return state;
    }
    if (state.kind === "empty") {
      return {
        kind: "setup",
        basis: state.basis,
        expectedPlateRevisionId: null,
        units: acceptedPlateSetupUnits(state.snapshot),
      };
    }
    if (state.kind === "stale_accepted_plan") {
      return {
        kind: "setup",
        basis: state.basis,
        expectedPlateRevisionId: state.expectedPlateRevisionId,
        units: acceptedPlateSetupUnits(state.snapshot),
      };
    }
    return {
      kind: "ready",
      basis: state.basis,
      expectedPlateRevisionId: state.plateRevisionId,
      plateRevisionId: state.plateRevisionId,
      plateRevisionNumber: state.plateRevisionNumber,
      undoFromRevisionId: state.undoFromRevisionId,
      plates: state.plates,
      units: acceptedPlateSetupUnits(state.snapshot),
    };
  });
}

export function publishAcceptedPlatesInternal(
  dependencies: AcceptedPlateDependencies,
  command: PublishAcceptedPlatesCommand,
): PublishAcceptedPlatesResult {
  if (!dependencies.sqlite) return { kind: "transaction_unavailable" };
  if (command.profileId !== command.expected.profileId) return { kind: "stale_accepted_plan" };
  return dependencies.transaction(() => {
    const accepted = currentAccepted(dependencies, command.expected);
    if (accepted.kind !== "ready") return accepted;
    const objectNames = requiredObjectNames(accepted.snapshot);
    const validated = validatePlates(command.plates, new Set(objectNames.keys()), false);
    if (validated.kind !== "ready") return validated;
    const digest = layoutDigest(validated.plates);
    const expectedPlateRevisionId = command.expectedPlateRevisionId;
    const head = dependencies.db
      .select()
      .from(dependencies.schema.acceptedPlateHeads)
      .where(
        and(
          eq(dependencies.schema.acceptedPlateHeads.tenantId, dependencies.tenantId),
          eq(dependencies.schema.acceptedPlateHeads.profileId, command.profileId),
        ),
      )
      .get();
    if (head) {
      const currentRevision = dependencies.db
        .select()
        .from(dependencies.schema.acceptedPlateRevisions)
        .where(
          and(
            eq(dependencies.schema.acceptedPlateRevisions.tenantId, dependencies.tenantId),
            eq(dependencies.schema.acceptedPlateRevisions.profileId, command.profileId),
            eq(dependencies.schema.acceptedPlateRevisions.id, head.currentRevisionId),
          ),
        )
        .get();
      if (!currentRevision) throw new AcceptedPlateIntegrityError("head");
      const sameAcceptedBasis =
        currentRevision.planRevisionId === accepted.snapshot.revisionId &&
        currentRevision.planVersion === accepted.snapshot.planVersion &&
        currentRevision.planRevisionDigest === accepted.snapshot.revisionDigest &&
        currentRevision.requiredUnitMappingDigest === accepted.snapshot.requiredUnitMappingDigest;
      if (sameAcceptedBasis) {
        readStoredPlates(
          dependencies,
          currentRevision.id,
          currentRevision.expectedPlateCount,
          currentRevision.expectedUnitCount,
          new Set(objectNames.keys()),
          currentRevision.layoutDigest,
        );
        if (currentRevision.layoutDigest === digest) {
          return {
            kind: "unchanged",
            plateRevisionId: currentRevision.id,
            plateRevisionNumber: currentRevision.revisionNumber,
          };
        }
      }
      if (head.currentRevisionId !== expectedPlateRevisionId) {
        return { kind: "plate_revision_changed" };
      }
    } else if (expectedPlateRevisionId !== null) {
      return { kind: "plate_revision_changed" };
    }
    const revisionNumber =
      dependencies.db
        .select({
          value: sql<number>`COALESCE(MAX(${dependencies.schema.acceptedPlateRevisions.revisionNumber}), 0) + 1`,
        })
        .from(dependencies.schema.acceptedPlateRevisions)
        .where(
          and(
            eq(dependencies.schema.acceptedPlateRevisions.tenantId, dependencies.tenantId),
            eq(dependencies.schema.acceptedPlateRevisions.profileId, command.profileId),
          ),
        )
        .get()?.value ?? 1;
    const revisionId = insertRevision(
      dependencies,
      accepted.snapshot,
      revisionNumber,
      validated.plates,
      command.undoFromRevisionId ?? null,
    );
    if (head) {
      if (expectedPlateRevisionId === null) throw new Error("Accepted Plate CAS is unavailable");
      const updated = dependencies.db
        .update(dependencies.schema.acceptedPlateHeads)
        .set({ currentRevisionId: revisionId })
        .where(
          and(
            eq(dependencies.schema.acceptedPlateHeads.tenantId, dependencies.tenantId),
            eq(dependencies.schema.acceptedPlateHeads.profileId, command.profileId),
            eq(
              dependencies.schema.acceptedPlateHeads.currentRevisionId,
              expectedPlateRevisionId,
            ),
          ),
        )
        .run();
      if (updated.changes !== 1) throw new Error("Accepted Plate head update failed");
    } else {
      dependencies.db
        .insert(dependencies.schema.acceptedPlateHeads)
        .values({
          tenantId: dependencies.tenantId,
          profileId: command.profileId,
          currentRevisionId: revisionId,
        })
        .run();
    }
    return { kind: "published", plateRevisionId: revisionId, plateRevisionNumber: revisionNumber };
  });
}

type AcceptedPlateEditCommand = Readonly<{
  profileId: number;
  expected: AcceptedPlanBasis;
  expectedPlateRevisionId: number;
}>;

type AcceptedPlateEditDecision =
  | { readonly kind: "changed"; readonly plates: readonly AcceptedPlateInput[]; readonly undoFromRevisionId?: number | null }
  | { readonly kind: "unchanged" }
  | { readonly kind: "unit_not_found" }
  | AcceptedPlateFailure;

type AcceptedPlateEditResult =
  | { readonly kind: "changed"; readonly plateRevisionId: number; readonly plateRevisionNumber: number }
  | { readonly kind: "unchanged"; readonly plateRevisionId: number; readonly plateRevisionNumber: number }
  | { readonly kind: "plate_revision_changed" | "unit_not_found" }
  | AcceptedPlateFailure;

function editAcceptedPlatesInternal(
  dependencies: AcceptedPlateDependencies,
  command: AcceptedPlateEditCommand,
  edit: (input: Readonly<{
    plates: readonly ValidatedPlate[];
    undoFromRevisionId: number | null;
    expectedTokens: ReadonlySet<string>;
    snapshot: AcceptedPlanOperationalSnapshot;
  }>) => AcceptedPlateEditDecision,
): AcceptedPlateEditResult {
  if (!dependencies.sqlite) return { kind: "transaction_unavailable" };
  if (command.profileId !== command.expected.profileId) return { kind: "stale_accepted_plan" };
  return dependencies.transaction(() => {
    const accepted = currentAccepted(dependencies, command.expected);
    if (accepted.kind !== "ready") return accepted;
    const head = dependencies.db
      .select()
      .from(dependencies.schema.acceptedPlateHeads)
      .where(and(
        eq(dependencies.schema.acceptedPlateHeads.tenantId, dependencies.tenantId),
        eq(dependencies.schema.acceptedPlateHeads.profileId, command.profileId),
      ))
      .get();
    if (!head || head.currentRevisionId !== command.expectedPlateRevisionId) {
      return { kind: "plate_revision_changed" };
    }
    const currentRevision = dependencies.db
      .select()
      .from(dependencies.schema.acceptedPlateRevisions)
      .where(and(
        eq(dependencies.schema.acceptedPlateRevisions.tenantId, dependencies.tenantId),
        eq(dependencies.schema.acceptedPlateRevisions.profileId, command.profileId),
        eq(dependencies.schema.acceptedPlateRevisions.id, head.currentRevisionId),
      ))
      .get();
    if (!currentRevision) throw new AcceptedPlateIntegrityError("head");
    if (
      currentRevision.planRevisionId !== accepted.snapshot.revisionId ||
      currentRevision.planVersion !== accepted.snapshot.planVersion ||
      currentRevision.planRevisionDigest !== accepted.snapshot.revisionDigest ||
      currentRevision.requiredUnitMappingDigest !== accepted.snapshot.requiredUnitMappingDigest
    ) {
      throw new AcceptedPlateIntegrityError("revision");
    }
    const expectedTokens = new Set(requiredObjectNames(accepted.snapshot).keys());
    const plates = readStoredPlates(
      dependencies,
      currentRevision.id,
      currentRevision.expectedPlateCount,
      currentRevision.expectedUnitCount,
      expectedTokens,
      currentRevision.layoutDigest,
    );
    const decision = edit({
      plates,
      undoFromRevisionId: currentRevision.undoFromRevisionId ?? null,
      expectedTokens,
      snapshot: accepted.snapshot,
    });
    if (decision.kind === "unit_not_found") return decision;
    if (decision.kind !== "changed" && decision.kind !== "unchanged") return decision;
    if (decision.kind === "unchanged") {
      return {
        kind: "unchanged",
        plateRevisionId: currentRevision.id,
        plateRevisionNumber: currentRevision.revisionNumber,
      };
    }
    const validated = validatePlates(decision.plates, expectedTokens, false);
    if (validated.kind !== "ready") return validated;
    if (layoutDigest(validated.plates) === layoutDigest(plates)) {
      return {
        kind: "unchanged",
        plateRevisionId: currentRevision.id,
        plateRevisionNumber: currentRevision.revisionNumber,
      };
    }
    const revisionNumber = dependencies.db
      .select({ value: sql<number>`COALESCE(MAX(${dependencies.schema.acceptedPlateRevisions.revisionNumber}), 0) + 1` })
      .from(dependencies.schema.acceptedPlateRevisions)
      .where(and(
        eq(dependencies.schema.acceptedPlateRevisions.tenantId, dependencies.tenantId),
        eq(dependencies.schema.acceptedPlateRevisions.profileId, command.profileId),
      ))
      .get()?.value ?? 1;
    const revisionId = insertRevision(
      dependencies,
      accepted.snapshot,
      revisionNumber,
      validated.plates,
      decision.undoFromRevisionId ?? null,
    );
    const updated = dependencies.db
      .update(dependencies.schema.acceptedPlateHeads)
      .set({ currentRevisionId: revisionId })
      .where(and(
        eq(dependencies.schema.acceptedPlateHeads.tenantId, dependencies.tenantId),
        eq(dependencies.schema.acceptedPlateHeads.profileId, command.profileId),
        eq(dependencies.schema.acceptedPlateHeads.currentRevisionId, command.expectedPlateRevisionId),
      ))
      .run();
    if (updated.changes !== 1) throw new Error("Accepted Plate head update failed");
    return { kind: "changed", plateRevisionId: revisionId, plateRevisionNumber: revisionNumber };
  });
}

function moveResult(result: AcceptedPlateEditResult): MoveAcceptedPlateUnitResult {
  return result.kind === "changed" ? { ...result, kind: "moved" } : result;
}

export function moveAcceptedPlateUnitInternal(
  dependencies: AcceptedPlateDependencies,
  command: MoveAcceptedPlateUnitCommand,
): MoveAcceptedPlateUnitResult {
  return moveResult(editAcceptedPlatesInternal(dependencies, command, ({ plates }) => {
    let found = false;
    let changed = false;
    const next = plates.map((plate): AcceptedPlateInput => ({
      ...plate,
      units: plate.units.map((unit): AcceptedPlateUnitInput => {
        if (plate.plateId !== command.plateId || unit.token !== command.token) return unit;
        found = true;
        changed = unit.xUm !== command.xUm || unit.yUm !== command.yUm;
        return { ...unit, xUm: command.xUm, yUm: command.yUm, placement: "manual" };
      }),
    }));
    if (!found) return { kind: "unit_not_found" };
    return changed ? { kind: "changed", plates: next } : { kind: "unchanged" };
  }));
}

export function pinAcceptedPlateUnitInternal(
  dependencies: AcceptedPlateDependencies,
  command: PinAcceptedPlateUnitCommand,
): PinAcceptedPlateUnitResult {
  return moveResult(editAcceptedPlatesInternal(dependencies, command, ({ plates }) => {
    let found = false;
    let changed = false;
    const next = plates.map((plate): AcceptedPlateInput => ({
      ...plate,
      units: plate.units.map((unit): AcceptedPlateUnitInput => {
        if (plate.plateId !== command.plateId || unit.token !== command.token) return unit;
        found = true;
        changed = unitPinned(unit) !== command.pinned;
        return { ...unit, pinned: command.pinned };
      }),
    }));
    if (!found) return { kind: "unit_not_found" };
    return changed ? { kind: "changed", plates: next } : { kind: "unchanged" };
  }));
}

export function unplaceAcceptedPlateUnitInternal(
  dependencies: AcceptedPlateDependencies,
  command: UnplaceAcceptedPlateUnitCommand,
): UnplaceAcceptedPlateUnitResult {
  return moveResult(editAcceptedPlatesInternal(dependencies, command, ({ plates }) => {
    let found = false;
    let changed = false;
    const next = plates.map((plate): AcceptedPlateInput => ({
      ...plate,
      units: plate.units.map((unit): AcceptedPlateUnitInput => {
        if (plate.plateId !== command.plateId || unit.token !== command.token) return unit;
        found = true;
        changed = unitPlacement(unit) !== "unplaced" || unitPinned(unit);
        return { ...unit, placement: "unplaced", pinned: false };
      }),
    }));
    if (!found) return { kind: "unit_not_found" };
    return changed ? { kind: "changed", plates: next } : { kind: "unchanged" };
  }));
}

export function transferAcceptedPlateUnitInternal(
  dependencies: AcceptedPlateDependencies,
  command: TransferAcceptedPlateUnitCommand,
): TransferAcceptedPlateUnitResult {
  return moveResult(editAcceptedPlatesInternal(dependencies, command, ({ plates }) => {
    const source = plates.find((plate) => plate.plateId === command.plateId);
    const unit = source?.units.find((candidate) => candidate.token === command.token);
    if (!source || !unit) return { kind: "unit_not_found" };
    const target = "targetPlateId" in command
      ? plates.find((plate) => plate.plateId === command.targetPlateId)
      : { plateId: newAcceptedPlateId(), ...command.targetPrinter, units: [] };
    if (!target) return { kind: "unit_not_found" };
    if (target.plateId === source.plateId) return { kind: "unchanged" };
    if (!unitDimensionsFitPrintableArea(target, unit)) {
      return { kind: "invalid_geometry", reason: "outside_build_area" };
    }
    const withTarget = "targetPrinter" in command ? [...plates, target] : plates;
    const next = withTarget.flatMap((plate): AcceptedPlateInput[] => {
      if (plate.plateId === source.plateId) {
        const remaining = plate.units.filter((candidate) => candidate.token !== command.token);
        return remaining.length === 0 ? [] : [{ ...plate, units: remaining }];
      }
      if (plate.plateId === target.plateId) {
        return [{ ...plate, units: [...plate.units, { ...unit, placement: "unplaced", pinned: false }] }];
      }
      return [plate];
    });
    return { kind: "changed", plates: next };
  }));
}

export function restoreAcceptedPlatesInternal(
  dependencies: AcceptedPlateDependencies,
  command: RestoreAcceptedPlatesCommand,
): RestoreAcceptedPlatesResult {
  const result = editAcceptedPlatesInternal(dependencies, command, ({ undoFromRevisionId, expectedTokens, snapshot }) => {
    if (undoFromRevisionId !== command.restorePlateRevisionId) return { kind: "unit_not_found" };
    const revision = dependencies.db
      .select()
      .from(dependencies.schema.acceptedPlateRevisions)
      .where(and(
        eq(dependencies.schema.acceptedPlateRevisions.tenantId, dependencies.tenantId),
        eq(dependencies.schema.acceptedPlateRevisions.profileId, command.profileId),
        eq(dependencies.schema.acceptedPlateRevisions.id, command.restorePlateRevisionId),
      ))
      .get();
    if (!revision) return { kind: "unit_not_found" };
    if (
      revision.planRevisionId !== snapshot.revisionId ||
      revision.planVersion !== snapshot.planVersion ||
      revision.planRevisionDigest !== snapshot.revisionDigest ||
      revision.requiredUnitMappingDigest !== snapshot.requiredUnitMappingDigest
    ) {
      return { kind: "stale_accepted_plan" };
    }
    const plates = readStoredPlates(
      dependencies,
      revision.id,
      revision.expectedPlateCount,
      revision.expectedUnitCount,
      expectedTokens,
      revision.layoutDigest,
    );
    return { kind: "changed", plates };
  });
  return result.kind === "changed" ? { ...result, kind: "restored" } : result;
}
