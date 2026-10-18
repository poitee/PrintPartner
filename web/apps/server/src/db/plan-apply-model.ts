import { createHash } from "node:crypto";

export const PLAN_APPLY_REQUEST_FORMAT = "plan-apply-request-v1";

export type UnmappableCheckoffLink = {
  readonly linkId: string;
  readonly filename: string;
  readonly reason: string;
};

export type CheckoffRemapTarget = { readonly draftPartId: number; readonly unitIndex: number };

export type CheckoffRemapPlan = {
  readonly checkoffLinksRaw: string | null;
  readonly sendQueueRaw: string | null;
  readonly remapByCoordinate: ReadonlyMap<string, CheckoffRemapTarget>;
};

export function positiveSafeId(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} is invalid`);
  return value;
}

export function planApplyRequestDigest(input: {
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

export function applyJsonRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value == null || Array.isArray(value)) {
    throw new Error(`${label} is corrupt`);
  }
  return value as Record<string, unknown>;
}

export function applySettingArray(value: string | null, label: string): unknown[] {
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

export function assessCheckoffRemap(input: {
  readonly profileId: number;
  readonly checkoffLinksRaw: string | null;
  readonly sendQueueRaw: string | null;
  readonly oldPartMatchKeyById: ReadonlyMap<number, string>;
  readonly partProfileIdById: ReadonlyMap<number, number>;
  readonly newPartByMatchKey: ReadonlyMap<string, { readonly draftPartId: number; readonly quantityEffective: number }>;
  /** Required-unit token at each accepted `part_id:unit_index`. */
  readonly oldTokenByCoordinate: ReadonlyMap<string, string>;
  /** New coordinate of each token the reconciliation reuses in an included Part. */
  readonly newCoordinateByToken: ReadonlyMap<string, CheckoffRemapTarget>;
}):
  | ({ readonly kind: "safe" } & CheckoffRemapPlan)
  | { readonly kind: "unsafe"; readonly unmappable: UnmappableCheckoffLink[] } {
  const remapByCoordinate = new Map<string, CheckoffRemapTarget>();
  const gateUnmappable: UnmappableCheckoffLink[] = [];
  const tokenUnmappable: UnmappableCheckoffLink[] = [];
  const gateSeen = new Set<string>();
  const tokenSeen = new Set<string>();

  function gate(linkId: string, filename: string, unit: { part_id: number; unit_index: number }): void {
    const key = `${unit.part_id}:${unit.unit_index}`;
    if (gateSeen.has(key)) return;
    gateSeen.add(key);
    const matchKey = input.oldPartMatchKeyById.get(unit.part_id);
    if (!matchKey) {
      gateUnmappable.push({
        linkId,
        filename,
        reason: `Checked-off part id ${unit.part_id} no longer exists in this Plan's parts`,
      });
      return;
    }
    const target = input.newPartByMatchKey.get(matchKey);
    if (!target) {
      gateUnmappable.push({
        linkId,
        filename,
        reason: `STL for "${filename}" (match_key ${matchKey}) is no longer part of the reconciled Plan`,
      });
      return;
    }
    if (unit.unit_index >= target.quantityEffective) {
      gateUnmappable.push({
        linkId,
        filename,
        reason: `Checked-off unit index ${unit.unit_index} exceeds the new quantity (${target.quantityEffective}) for "${filename}"`,
      });
    }
  }

  // Follow the Required unit, not the index: a kept unit can move to another index.
  function follow(linkId: string, filename: string, unit: { part_id: number; unit_index: number }): void {
    const key = `${unit.part_id}:${unit.unit_index}`;
    if (tokenSeen.has(key)) return;
    tokenSeen.add(key);
    const token = input.oldTokenByCoordinate.get(key);
    const target = token == null ? undefined : input.newCoordinateByToken.get(token);
    if (!target) {
      tokenUnmappable.push({
        linkId,
        filename,
        reason: `Required unit at Part ${unit.part_id} index ${unit.unit_index} is absent or excluded in the selected Plan`,
      });
      return;
    }
    remapByCoordinate.set(key, target);
  }

  function resolve(
    linkId: string,
    filename: string,
    units: unknown,
    label: string,
    checkGate: boolean,
  ): void {
    if (!Array.isArray(units)) return;
    for (const unitValue of units) {
      const unit = applyJsonRecord(unitValue, label);
      const coordinate = { part_id: unit.part_id as number, unit_index: unit.unit_index as number };
      if (checkGate) gate(linkId, filename, coordinate);
      follow(linkId, filename, coordinate);
    }
  }

  for (const value of applySettingArray(input.checkoffLinksRaw, "Printer Checkoff links")) {
    const row = applyJsonRecord(value, "Printer Checkoff link");
    if (row.profile_id !== input.profileId) continue;
    const linkId = typeof row.id === "string" ? row.id : "unknown";
    const filename = typeof row.filename === "string" ? row.filename : "unknown file";
    resolve(linkId, filename, row.units, "Printer Checkoff coordinate", true);
    resolve(linkId, filename, row.resolved_units, "Printer Checkoff coordinate", false);
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
    resolve(linkId, filename, units, "Printer queue coordinate", true);
  }

  if (gateUnmappable.length > 0) return { kind: "unsafe", unmappable: gateUnmappable };
  if (tokenUnmappable.length > 0) return { kind: "unsafe", unmappable: tokenUnmappable };
  return {
    kind: "safe",
    checkoffLinksRaw: input.checkoffLinksRaw,
    sendQueueRaw: input.sendQueueRaw,
    remapByCoordinate,
  };
}
