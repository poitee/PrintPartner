import type Database from "better-sqlite3";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { z } from "zod";
import * as schema from "./db/schema.js";
import { acceptedPlanStoredTextBytes, validateAcceptedPlanStoredTextBytes } from "./db/accepted-plan-operational.js";
import { isCanonicalTimestamp, SHA256_PATTERN } from "./db/accepted-plan-operational-model.js";
import { readAcceptedPlateRevisionLayoutInternal } from "./db/accepted-plates.js";
import { schemaMigrations } from "./db/migrations-sqlite.js";

export const ownershipPlateTables = ["accepted_plate_revisions", "accepted_plate_heads", "accepted_plates", "accepted_plate_units"] as const;

const MAX_OWNERSHIP_PLATE_COMPARISONS = 1_000_000;
type ComparisonUnit = Pick<typeof schema.acceptedPlateUnits.$inferSelect, "revisionId" | "plateId" | "placement">;
const comparisonUnitSchema: z.ZodType<ComparisonUnit> = z.object({
  revisionId: z.number(), plateId: z.string(), placement: z.enum(["auto", "manual", "unplaced"]),
});

export class OwnershipPlateComparisonBudgetError extends Error {
  constructor(readonly limit: number, readonly charged: number) {
    super("Unsafe accepted Plate history: comparison budget");
    this.name = "OwnershipPlateComparisonBudgetError";
  }
}

export function chargeOwnershipPlateComparisons(units: Iterable<ComparisonUnit>, limit = MAX_OWNERSHIP_PLATE_COMPARISONS): number {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_OWNERSHIP_PLATE_COMPARISONS) {
    throw new RangeError("Invalid accepted Plate comparison limit");
  }
  const revisions = new Map<number, Map<string, number>>();
  let charged = 0;
  for (const unit of units) {
    if (unit.placement === "unplaced") continue;
    let plates = revisions.get(unit.revisionId);
    if (!plates) {
      plates = new Map();
      revisions.set(unit.revisionId, plates);
    }
    const placed = plates.get(unit.plateId) ?? 0;
    charged += 2 * placed;
    if (charged > limit) throw new OwnershipPlateComparisonBudgetError(limit, charged);
    plates.set(unit.plateId, placed + 1);
  }
  return charged;
}

export function validateOwnershipPlateComparisonBudget(database: Database.Database): void {
  function* units() {
    for (const row of database.prepare("SELECT revision_id AS revisionId,plate_id AS plateId,placement FROM accepted_plate_units").iterate()) {
      yield comparisonUnitSchema.parse(row);
    }
  }
  chargeOwnershipPlateComparisons(units());
}

export function validateOwnershipPlateTextBytes(database: Database.Database): void {
  const db = drizzle(database);
  for (const table of [schema.acceptedPlateRevisions, schema.acceptedPlateHeads, schema.acceptedPlates, schema.acceptedPlateUnits]) {
    const columns = Object.values(getTableColumns(table)).filter(column => column.dataType === "string");
    for (const row of db.select({ bytes: acceptedPlanStoredTextBytes(true, columns) }).from(table).all()) {
      validateAcceptedPlanStoredTextBytes(row.bytes, "revision", "Accepted Plate history row text is corrupt");
    }
  }
}

export function validateOwnershipPlateProtection(database: Database.Database): void {
  const triggers = z.array(z.object({ name: z.string(), sql: z.string() })).parse(database.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger'").all());
  const normalize = (sql: string) => sql.replace("CREATE TRIGGER IF NOT EXISTS", "CREATE TRIGGER").replace(/;\s*$/, "").trim();
  for (const expected of schemaMigrations.filter(sql => /^CREATE TRIGGER IF NOT EXISTS trg_accepted_plate/.test(sql))) {
    const name = expected.split(/\s+/)[5];
    const actual = triggers.find(trigger => trigger.name === name);
    if (!actual || normalize(actual.sql) !== normalize(expected)) throw new Error("Missing or unexpected accepted Plate trigger protection");
  }
}

export function validateOwnershipPlateHistory(database: Database.Database): void {
  const db = drizzle(database, { schema });
  const revisions = db.select().from(schema.acceptedPlateRevisions).all();
  const plans = db.select().from(schema.planRevisions).all();
  const unitSets = db.select().from(schema.planRevisionRequiredUnitSets).all();
  const mappings = db.select().from(schema.planRevisionRequiredUnits).all();
  const parts = db.select().from(schema.planRevisionParts).all();
  const profiles = db.select().from(schema.buildProfiles).all();
  const fail = (message: string): never => { throw new Error(`Unsafe accepted Plate history: ${message}`); };
  const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
  const canonical = (value: string) => value.length > 0 && value.trim() === value;
  const revisionsById = new Map(revisions.map(revision => [revision.id, revision]));
  const revisionGroups = new Map<string, Map<number, typeof schema.acceptedPlateRevisions.$inferSelect>>();
  for (const revision of revisions) {
    const key = JSON.stringify([revision.tenantId, revision.profileId]);
    let group = revisionGroups.get(key);
    if (!group) {
      group = new Map();
      revisionGroups.set(key, group);
    }
    if (group.has(revision.revisionNumber)) fail("revision sequence");
    group.set(revision.revisionNumber, revision);
  }
  for (const group of revisionGroups.values()) {
    for (let number = 1; number <= group.size; number++) {
      if (!group.has(number)) fail("revision sequence");
    }
  }
  const rawUnits = z.array(z.object({ placement: z.string(), pinned: z.unknown() })).parse(database.prepare("SELECT placement,pinned FROM accepted_plate_units").all());
  for (const unit of rawUnits) {
    if (!["auto", "manual", "unplaced"].includes(unit.placement) || (unit.pinned !== 0 && unit.pinned !== 1)
      || (unit.placement === "unplaced" && unit.pinned !== 0)) fail("raw placement or pinned value");
  }
  const included = new Map(z.array(z.object({ id: z.number(), included: z.unknown() }))
    .parse(database.prepare("SELECT id,included FROM plan_revision_parts").all()).map(part => [part.id, part.included]));
  const plates = db.select().from(schema.acceptedPlates).all();
  const units = db.select().from(schema.acceptedPlateUnits).all();
  const plateAssociations = new Set(plates.map(plate => JSON.stringify([plate.tenantId, plate.revisionId, plate.plateId])));
  for (const plate of plates) {
    if (![plate.plateId, plate.printerId, plate.printerName, plate.printerModel].every(canonical)) fail("noncanonical Plate text");
    if (revisionsById.get(plate.revisionId)?.tenantId !== plate.tenantId) fail("orphan Plate");
  }
  for (const unit of units) {
    if (!canonical(unit.requiredUnitToken) || !canonical(unit.plateId)
      || !plateAssociations.has(JSON.stringify([unit.tenantId, unit.revisionId, unit.plateId]))) fail("orphan unit or noncanonical token");
  }
  for (const revision of revisions) {
    if (![revision.id, revision.profileId, revision.planRevisionId, revision.planVersion, revision.revisionNumber,
      revision.expectedPlateCount, revision.expectedUnitCount].every(positive)
      || !canonical(revision.tenantId) || !isCanonicalTimestamp(revision.createdAt)
      || ![revision.planRevisionDigest, revision.requiredUnitMappingDigest, revision.layoutDigest].every(digest => SHA256_PATTERN.test(digest))) fail("revision header");
    const plan = plans.find(plan => plan.id === revision.planRevisionId && plan.tenantId === revision.tenantId && plan.profileId === revision.profileId);
    const set = unitSets.find(set => set.revisionId === revision.planRevisionId && set.tenantId === revision.tenantId && set.profileId === revision.profileId);
    if (!plan || !set || plan.revisionNumber !== revision.planVersion || plan.snapshotDigest !== revision.planRevisionDigest
      || set.mappingDigest !== revision.requiredUnitMappingDigest
      || !profiles.some(profile => profile.id === revision.profileId && profile.tenantId === revision.tenantId)) fail("historical Plan basis");
    const revisionParts = parts.filter(part => part.revisionId === revision.planRevisionId);
    if (revisionParts.some(part => included.get(part.id) !== 0 && included.get(part.id) !== 1)) fail("historical Part inclusion");
    const tokens = new Set(mappings.filter(mapping => mapping.revisionId === revision.planRevisionId && mapping.tenantId === revision.tenantId
      && revisionParts.some(part => part.id === mapping.revisionPartId && part.tenantId === revision.tenantId && included.get(part.id) === 1))
      .map(mapping => mapping.requiredUnitToken));
    readAcceptedPlateRevisionLayoutInternal({ db, schema, tenantId: revision.tenantId }, revision.id,
      revision.expectedPlateCount, revision.expectedUnitCount, tokens, revision.layoutDigest);
    if (revision.undoFromRevisionId != null) {
      const undo = revisionsById.get(revision.undoFromRevisionId);
      if (!positive(revision.undoFromRevisionId) || !undo || undo.tenantId !== revision.tenantId || undo.profileId !== revision.profileId
        || undo.revisionNumber !== revision.revisionNumber - 1 || undo.planRevisionId !== revision.planRevisionId
        || undo.planVersion !== revision.planVersion || undo.planRevisionDigest !== revision.planRevisionDigest
        || undo.requiredUnitMappingDigest !== revision.requiredUnitMappingDigest) fail("undo provenance");
    }
  }
  for (const head of db.select().from(schema.acceptedPlateHeads).all()) {
    const group = revisionGroups.get(JSON.stringify([head.tenantId, head.profileId]));
    if (!positive(head.profileId) || !positive(head.currentRevisionId)
      || !group || group.get(group.size)?.id !== head.currentRevisionId) fail("head");
  }
}
