import { and, eq } from "drizzle-orm";
import {
  readAcceptedPlanOperationalSnapshotInternal,
  type AcceptedOperationalPart,
  type AcceptedPlanOperationalSnapshot,
} from "./accepted-plan-operational.js";
import {
  acceptedPlanBasis,
  type AcceptedPlanBasis,
  type AcceptedPlanProgressDependencies,
} from "./accepted-plan-progress.js";
import { normalizePartRole } from "../services/role-filament.js";

export type FilamentColor =
  | { readonly kind: "catalog"; readonly colorId: string }
  | { readonly kind: "custom"; readonly hex: string }
  | { readonly kind: "unset" };

export type FilamentAssignment = Readonly<{
  color: FilamentColor;
  spoolmanSpoolId: string | null;
}>;

export type FilamentPatch = Readonly<{
  colorId?: string | null;
  customHex?: string | null;
  spoolmanSpoolId?: string | null;
}>;

export type AssignAcceptedFilamentTarget =
  | { readonly kind: "part"; readonly projectionPartId: number }
  | { readonly kind: "role"; readonly role: string };

export type AssignAcceptedFilament = Readonly<{
  expected: AcceptedPlanBasis;
  target: AssignAcceptedFilamentTarget;
  assignment: FilamentAssignment;
}>;

export type AssignedAcceptedPart = Readonly<{
  projectionPartId: number;
  before: FilamentAssignment;
  after: FilamentAssignment;
}>;

export type AssignAcceptedFilamentResult =
  | {
      readonly kind: "updated";
      readonly unchanged: boolean;
      readonly part: AcceptedOperationalPart | null;
      readonly assigned: readonly AssignedAcceptedPart[];
    }
  | { readonly kind: "accepted_state_unavailable"; readonly reason: "compatibility_dirty" | "uninitialized" }
  | { readonly kind: "stale_accepted_plan" }
  | { readonly kind: "part_not_found" }
  | { readonly kind: "plan_archived" }
  | { readonly kind: "transaction_unavailable" };

export function liveAssignmentFrom(
  part: Pick<AcceptedOperationalPart, "filamentColorId" | "filamentCustomHex" | "spoolmanSpoolId">,
): FilamentAssignment {
  const color: FilamentColor =
    part.filamentColorId != null
      ? { kind: "catalog", colorId: part.filamentColorId }
      : part.filamentCustomHex != null
        ? { kind: "custom", hex: part.filamentCustomHex }
        : { kind: "unset" };
  return { color, spoolmanSpoolId: part.spoolmanSpoolId };
}

export function filamentAssignmentColumns(assignment: FilamentAssignment): {
  filamentColorId: string | null;
  filamentCustomHex: string | null;
  spoolmanSpoolId: string | null;
} {
  return {
    filamentColorId: assignment.color.kind === "catalog" ? assignment.color.colorId : null,
    filamentCustomHex: assignment.color.kind === "custom" ? assignment.color.hex : null,
    spoolmanSpoolId: assignment.spoolmanSpoolId,
  };
}

function colorIdentity(color: FilamentColor): string {
  if (color.kind === "catalog") return `catalog:${color.colorId}`;
  if (color.kind === "custom") return `custom:${color.hex}`;
  return "unset";
}

export function sameFilamentAssignment(
  left: FilamentAssignment,
  right: FilamentAssignment,
): boolean {
  return (
    colorIdentity(left.color) === colorIdentity(right.color) &&
    left.spoolmanSpoolId === right.spoolmanSpoolId
  );
}

export function resolveFilamentAssignment(
  current: FilamentAssignment,
  patch: FilamentPatch,
): FilamentAssignment {
  let color = current.color;
  if (patch.colorId !== undefined && patch.colorId != null) {
    color = { kind: "catalog", colorId: patch.colorId };
  } else if (patch.customHex !== undefined && patch.customHex != null) {
    color = { kind: "custom", hex: patch.customHex };
  } else if (patch.colorId === null && (patch.customHex === undefined || patch.customHex === null)) {
    color = { kind: "unset" };
  } else if (patch.customHex === null && patch.colorId === undefined && current.color.kind === "custom") {
    color = { kind: "unset" };
  }

  const spoolmanSpoolId =
    patch.spoolmanSpoolId !== undefined
      ? patch.spoolmanSpoolId
      : colorIdentity(color) === colorIdentity(current.color)
        ? current.spoolmanSpoolId
        : null;
  return { color, spoolmanSpoolId };
}

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

function readExpectedSnapshot(
  dependencies: AcceptedPlanProgressDependencies,
  expected: AcceptedPlanBasis,
):
  | { readonly kind: "ready"; readonly snapshot: AcceptedPlanOperationalSnapshot }
  | AssignAcceptedFilamentResult {
  const owned = dependencies.db
    .select({ id: dependencies.schema.buildProfiles.id })
    .from(dependencies.schema.buildProfiles)
    .where(
      and(
        eq(dependencies.schema.buildProfiles.tenantId, dependencies.tenantId),
        eq(dependencies.schema.buildProfiles.id, expected.profileId),
      ),
    )
    .get();
  if (!owned) return { kind: "part_not_found" };
  const accepted = readAcceptedPlanOperationalSnapshotInternal({
    ...dependencies,
    profileId: expected.profileId,
  });
  if (accepted.kind !== "ready") {
    if (accepted.kind === "empty") return { kind: "stale_accepted_plan" };
    return { kind: "accepted_state_unavailable", reason: accepted.kind };
  }
  if (!sameBasis(accepted.snapshot, expected)) {
    return { kind: "stale_accepted_plan" };
  }
  return accepted;
}

function targetParts(
  snapshot: AcceptedPlanOperationalSnapshot,
  target: AssignAcceptedFilamentTarget,
): AcceptedOperationalPart[] | { readonly kind: "part_not_found" } {
  if (target.kind === "part") {
    const part = snapshot.parts.find((candidate) => candidate.projectionPartId === target.projectionPartId);
    return part ? [part] : { kind: "part_not_found" };
  }
  const role = normalizePartRole(target.role);
  return snapshot.parts.filter(
    (part) => part.included && normalizePartRole(part.effectiveRole) === role,
  );
}

export function assignAcceptedFilamentInternal(
  dependencies: AcceptedPlanProgressDependencies,
  command: AssignAcceptedFilament,
): AssignAcceptedFilamentResult {
  if (!dependencies.sqlite) return { kind: "transaction_unavailable" };
  const accepted = readExpectedSnapshot(dependencies, command.expected);
  if (accepted.kind !== "ready") return accepted;
  if (accepted.snapshot.profile.archivedAt) return { kind: "plan_archived" };
  const targets = targetParts(accepted.snapshot, command.target);
  if ("kind" in targets) return targets;

  const columns = filamentAssignmentColumns(command.assignment);
  const assigned: AssignedAcceptedPart[] = [];
  let changed = false;
  for (const part of targets) {
    const before = liveAssignmentFrom(part);
    if (!sameFilamentAssignment(before, command.assignment)) {
      const written = dependencies.db
        .update(dependencies.schema.parts)
        .set(columns)
        .where(
          and(
            eq(dependencies.schema.parts.tenantId, dependencies.tenantId),
            eq(dependencies.schema.parts.id, part.projectionPartId),
          ),
        )
        .run();
      if (written.changes !== 1) return { kind: "part_not_found" };
      changed = true;
    }
    assigned.push({
      projectionPartId: part.projectionPartId,
      before,
      after: command.assignment,
    });
  }

  const reread = readAcceptedPlanOperationalSnapshotInternal({
    ...dependencies,
    profileId: command.expected.profileId,
  });
  if (reread.kind !== "ready") {
    if (reread.kind === "empty") return { kind: "stale_accepted_plan" };
    return { kind: "accepted_state_unavailable", reason: reread.kind };
  }
  const firstId = assigned[0]?.projectionPartId;
  const part = firstId == null
    ? null
    : (reread.snapshot.parts.find((candidate) => candidate.projectionPartId === firstId) ?? null);
  if (firstId != null && !part) return { kind: "part_not_found" };
  return { kind: "updated", unchanged: !changed, part, assigned };
}
