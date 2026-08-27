import { createHash } from "node:crypto";

export const PLAN_APPLY_REQUEST_FORMAT = "plan-apply-request-v1";

export type UnmappableCheckoffLink = {
  readonly linkId: string;
  readonly filename: string;
  readonly reason: string;
};

export type CheckoffRemapPlan = {
  readonly checkoffLinksRaw: string | null;
  readonly sendQueueRaw: string | null;
  readonly remapByDraftPart: ReadonlyMap<string, number>;
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
