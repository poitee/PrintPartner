import { and, asc, eq, lt } from "drizzle-orm";
import type { DrizzleDb } from "./client.js";
import {
  AcceptedPlanOperationalIntegrityError,
  readAcceptedPlanOperationalSnapshotInternal,
  type AcceptedPlanOperationalSchema,
  type AcceptedPlanOperationalSnapshot,
} from "./accepted-plan-operational.js";
import type { RequiredUnitToken } from "../services/required-units.js";
import type { PrintRejectReason } from "@print-partner/contracts";

export type AcceptedPlanBasis = Readonly<{
  profileId: number;
  planVersion: number;
  revisionId: number;
  revisionDigest: string;
  requiredUnitMappingDigest: string;
}>;

export type AcceptedProgressSummary = Readonly<{
  totalUnits: number;
  remainingUnits: number;
}>;

export type AcceptedProgressFailure =
  | { readonly kind: "unit_not_found" }
  | { readonly kind: "plan_archived" }
  | {
      readonly kind: "accepted_state_unavailable";
      readonly reason: "compatibility_dirty" | "uninitialized";
    }
  | { readonly kind: "stale_accepted_plan" }
  | { readonly kind: "transaction_unavailable" };

export type CompletionBody = Readonly<{
  part_id: number;
  printed_count: number;
  print_units: readonly boolean[];
  assembled_units: readonly boolean[];
  missing: boolean;
}>;

export type AssemblyBody = Readonly<{
  part_id: number;
  assembled_count: number;
  assembled_units: readonly boolean[];
}>;

export type SetAcceptedUnitCompletion = Readonly<{
  expected: AcceptedPlanBasis;
  token: RequiredUnitToken;
  completed: boolean;
}>;

export type SetAcceptedUnitAssembly = Readonly<{
  expected: AcceptedPlanBasis;
  token: RequiredUnitToken;
  assembled: boolean;
}>;

export type SetAcceptedUnitCompletionResult =
  | { readonly kind: "updated"; readonly body: CompletionBody }
  | AcceptedProgressFailure;

export type SetAcceptedUnitAssemblyResult =
  | { readonly kind: "updated"; readonly body: AssemblyBody }
  | AcceptedProgressFailure;

export type AcceptedUnitDecision =
  | { readonly token: RequiredUnitToken; readonly result: "confirmed"; readonly note?: string }
  | {
      readonly token: RequiredUnitToken;
      readonly result: "rejected";
      readonly reason: PrintRejectReason;
      readonly note?: string;
    };

export type ResolvedAcceptedUnitDecision = AcceptedUnitDecision &
  Readonly<{
    partId: number;
    unitIndex: number;
    matchKey: string;
    role: string;
  }>;

export type ApplyAcceptedUnitDecisionsResult =
  | {
      readonly kind: "applied";
      readonly unitsConfirmed: number;
      readonly decisions: readonly ResolvedAcceptedUnitDecision[];
    }
  | AcceptedProgressFailure
  | { readonly kind: "invalid_decisions" };

export type ArchiveAcceptedPlanResult =
  | { readonly kind: "archived" | "already_archived"; readonly archivedAt: string }
  | { readonly kind: "remaining"; readonly totalUnits: number; readonly remainingUnits: number }
  | { readonly kind: "empty" | "stale_accepted_plan" | "transaction_unavailable" }
  | {
      readonly kind: "accepted_state_unavailable";
      readonly reason: "compatibility_dirty" | "uninitialized";
    };

export type AcceptedPlanProgressSchema = AcceptedPlanOperationalSchema;

export type AcceptedPlanProgressDependencies = Readonly<{
  db: DrizzleDb;
  schema: AcceptedPlanProgressSchema;
  tenantId: string;
  reposDir: string;
  sqlite: boolean;
}>;

export function acceptedPlanBasis(snapshot: AcceptedPlanOperationalSnapshot): AcceptedPlanBasis {
  return {
    profileId: snapshot.profile.id,
    planVersion: snapshot.planVersion,
    revisionId: snapshot.revisionId,
    revisionDigest: snapshot.revisionDigest,
    requiredUnitMappingDigest: snapshot.requiredUnitMappingDigest,
  };
}

export function acceptedProgressSummary(
  snapshot: AcceptedPlanOperationalSnapshot,
): AcceptedProgressSummary {
  const units = snapshot.parts.filter((part) => part.included).flatMap((part) => part.units);
  return {
    totalUnits: units.length,
    remainingUnits: units.filter((unit) => !unit.completed).length,
  };
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
  | AcceptedProgressFailure {
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
  if (!owned) return { kind: "unit_not_found" };
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

function assertCompleteProgress(
  dependencies: AcceptedPlanProgressDependencies,
  snapshot: AcceptedPlanOperationalSnapshot,
): void {
  for (const part of snapshot.parts) {
    const rows = dependencies.db
      .select({
        tenantId: dependencies.schema.printProgress.tenantId,
        unitIndex: dependencies.schema.printProgress.unitIndex,
      })
      .from(dependencies.schema.printProgress)
      .where(
        and(
          eq(dependencies.schema.printProgress.partId, part.projectionPartId),
          lt(dependencies.schema.printProgress.unitIndex, part.units.length),
        ),
      )
      .orderBy(asc(dependencies.schema.printProgress.unitIndex))
      .all();
    if (
      rows.length !== part.units.length ||
      rows.some(
        (row, index) => row.tenantId !== dependencies.tenantId || row.unitIndex !== index,
      )
    ) {
      throw new AcceptedPlanOperationalIntegrityError(
        "progress",
        "Accepted Plan progress rows are incomplete",
      );
    }
  }
}

function locateUnit(snapshot: AcceptedPlanOperationalSnapshot, token: RequiredUnitToken) {
  const matches = snapshot.parts.flatMap((part) =>
    part.units
      .filter((unit) => unit.token === token)
      .map((unit) => ({ part, unit })),
  );
  if (matches.length > 1) {
    throw new AcceptedPlanOperationalIntegrityError(
      "required_unit_map",
      "Accepted Plan Required-unit token is duplicated",
    );
  }
  return matches[0] ?? null;
}

export function applyAcceptedUnitDecisionsInternal(
  dependencies: AcceptedPlanProgressDependencies,
  expected: AcceptedPlanBasis,
  decisions: readonly AcceptedUnitDecision[],
  validate?: (decisions: readonly ResolvedAcceptedUnitDecision[]) => boolean,
): ApplyAcceptedUnitDecisionsResult {
  const accepted = readExpectedSnapshot(dependencies, expected);
  if (accepted.kind !== "ready") return accepted;
  if (accepted.snapshot.profile.archivedAt) return { kind: "plan_archived" };
  assertCompleteProgress(dependencies, accepted.snapshot);
  const resolved: ResolvedAcceptedUnitDecision[] = [];
  const seen = new Set<string>();
  for (const decision of decisions) {
    const located = locateUnit(accepted.snapshot, decision.token);
    if (!located || seen.has(decision.token)) return { kind: "invalid_decisions" };
    seen.add(decision.token);
    resolved.push({
      ...decision,
      partId: located.part.projectionPartId,
      unitIndex: located.unit.unitIndex,
      matchKey: located.part.partKey,
      role: located.part.effectiveRole,
    });
  }
  if (validate && !validate(resolved)) return { kind: "invalid_decisions" };

  const confirmedByPart = new Map<number, Set<number>>();
  for (const decision of resolved) {
    if (decision.result !== "confirmed") continue;
    const indices = confirmedByPart.get(decision.partId) ?? new Set<number>();
    indices.add(decision.unitIndex);
    confirmedByPart.set(decision.partId, indices);
  }
  let unitsConfirmed = 0;
  for (const [partId, indices] of confirmedByPart) {
    const part = accepted.snapshot.parts.find((candidate) => candidate.projectionPartId === partId);
    if (!part) return { kind: "invalid_decisions" };
    const maxIndex = Math.max(...indices);
    for (const unit of part.units) {
      if (unit.unitIndex <= maxIndex && !unit.completed && !indices.has(unit.unitIndex)) {
        return { kind: "invalid_decisions" };
      }
    }
    for (const index of indices) {
      const unit = part.units[index];
      if (!unit) return { kind: "invalid_decisions" };
      if (!unit.completed) unitsConfirmed += 1;
      dependencies.db
        .update(dependencies.schema.printProgress)
        .set({ completed: true })
        .where(
          and(
            eq(dependencies.schema.printProgress.tenantId, dependencies.tenantId),
            eq(dependencies.schema.printProgress.partId, partId),
            eq(dependencies.schema.printProgress.unitIndex, index),
          ),
        )
        .run();
    }
  }
  return { kind: "applied", unitsConfirmed, decisions: resolved };
}

function completionBody(part: AcceptedPlanOperationalSnapshot["parts"][number]): CompletionBody {
  const printUnits = part.units.map((unit) => unit.completed);
  const assembledUnits = part.units.map((unit) => unit.assembled);
  const printedCount = printUnits.filter(Boolean).length;
  return {
    part_id: part.projectionPartId,
    printed_count: printedCount,
    print_units: printUnits,
    assembled_units: assembledUnits,
    missing: printedCount < part.units.length,
  };
}

function assemblyBody(part: AcceptedPlanOperationalSnapshot["parts"][number]): AssemblyBody {
  const assembledUnits = part.units.map((unit) => unit.assembled);
  return {
    part_id: part.projectionPartId,
    assembled_count: assembledUnits.filter(Boolean).length,
    assembled_units: assembledUnits,
  };
}

export function setAcceptedUnitCompletionInternal(
  dependencies: AcceptedPlanProgressDependencies,
  command: SetAcceptedUnitCompletion,
): SetAcceptedUnitCompletionResult {
  const accepted = readExpectedSnapshot(dependencies, command.expected);
  if (accepted.kind !== "ready") return accepted;
  if (accepted.snapshot.profile.archivedAt) return { kind: "plan_archived" };
  assertCompleteProgress(dependencies, accepted.snapshot);
  const located = locateUnit(accepted.snapshot, command.token);
  if (!located) return { kind: "unit_not_found" };

  for (const unit of located.part.units) {
    const shouldChange = command.completed
      ? unit.unitIndex <= located.unit.unitIndex
      : unit.unitIndex >= located.unit.unitIndex;
    if (!shouldChange) continue;
    dependencies.db
      .update(dependencies.schema.printProgress)
      .set(
        command.completed
          ? { completed: true }
          : { completed: false, assembled: false },
      )
      .where(
        and(
          eq(dependencies.schema.printProgress.tenantId, dependencies.tenantId),
          eq(dependencies.schema.printProgress.partId, located.part.projectionPartId),
          eq(dependencies.schema.printProgress.unitIndex, unit.unitIndex),
        ),
      )
      .run();
  }
  const part = {
    ...located.part,
    units: located.part.units.map((unit) => {
      const shouldChange = command.completed
        ? unit.unitIndex <= located.unit.unitIndex
        : unit.unitIndex >= located.unit.unitIndex;
      if (!shouldChange) return unit;
      return command.completed
        ? { ...unit, completed: true }
        : { ...unit, completed: false, assembled: false };
    }),
  };
  return { kind: "updated", body: completionBody(part) };
}

export function setAcceptedUnitAssemblyInternal(
  dependencies: AcceptedPlanProgressDependencies,
  command: SetAcceptedUnitAssembly,
): SetAcceptedUnitAssemblyResult {
  const accepted = readExpectedSnapshot(dependencies, command.expected);
  if (accepted.kind !== "ready") return accepted;
  if (accepted.snapshot.profile.archivedAt) return { kind: "plan_archived" };
  assertCompleteProgress(dependencies, accepted.snapshot);
  const located = locateUnit(accepted.snapshot, command.token);
  if (!located) return { kind: "unit_not_found" };
  if (!command.assembled || located.unit.completed) {
    dependencies.db
      .update(dependencies.schema.printProgress)
      .set({ assembled: command.assembled })
      .where(
        and(
          eq(dependencies.schema.printProgress.tenantId, dependencies.tenantId),
          eq(dependencies.schema.printProgress.partId, located.part.projectionPartId),
          eq(dependencies.schema.printProgress.unitIndex, located.unit.unitIndex),
        ),
      )
      .run();
  }
  const part = {
    ...located.part,
    units: located.part.units.map((unit) =>
      unit.unitIndex === located.unit.unitIndex && (!command.assembled || unit.completed)
        ? { ...unit, assembled: command.assembled }
        : unit,
    ),
  };
  return { kind: "updated", body: assemblyBody(part) };
}

export function archiveAcceptedPlanInternal(
  dependencies: AcceptedPlanProgressDependencies,
  expected: AcceptedPlanBasis,
): ArchiveAcceptedPlanResult {
  const profile = dependencies.db
    .select({ archivedAt: dependencies.schema.buildProfiles.archivedAt })
    .from(dependencies.schema.buildProfiles)
    .where(
      and(
        eq(dependencies.schema.buildProfiles.tenantId, dependencies.tenantId),
        eq(dependencies.schema.buildProfiles.id, expected.profileId),
      ),
    )
    .get();
  if (!profile) return { kind: "empty" };
  if (profile?.archivedAt) {
    return { kind: "already_archived", archivedAt: profile.archivedAt };
  }
  const accepted = readAcceptedPlanOperationalSnapshotInternal({
    ...dependencies,
    profileId: expected.profileId,
  });
  if (accepted.kind !== "ready") {
    if (accepted.kind === "empty") return { kind: "empty" };
    return { kind: "accepted_state_unavailable", reason: accepted.kind };
  }
  if (!sameBasis(accepted.snapshot, expected)) return { kind: "stale_accepted_plan" };
  assertCompleteProgress(dependencies, accepted.snapshot);
  const summary = acceptedProgressSummary(accepted.snapshot);
  if (summary.totalUnits === 0) return { kind: "empty" };
  if (summary.remainingUnits > 0) return { kind: "remaining", ...summary };
  if (accepted.snapshot.profile.archivedAt) {
    return { kind: "already_archived", archivedAt: accepted.snapshot.profile.archivedAt };
  }
  const archivedAt = new Date().toISOString();
  dependencies.db
    .update(dependencies.schema.buildProfiles)
    .set({ archivedAt })
    .where(
      and(
        eq(dependencies.schema.buildProfiles.tenantId, dependencies.tenantId),
        eq(dependencies.schema.buildProfiles.id, expected.profileId),
      ),
    )
    .run();
  return { kind: "archived", archivedAt };
}
