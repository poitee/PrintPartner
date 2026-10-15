import type Database from "better-sqlite3";
import { z } from "zod";
import { getTableColumns, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./db/schema.js";
import {
  acceptedPlanStoredTextBytes,
  validateAcceptedPlanStoredTextBytes,
  validateAcceptedPlanInputHeaderRows,
  validateAcceptedPlanProgressRows,
  validateAcceptedPlanRevisionPartRows,
  validateAcceptedPlanRevisionRows,
  validateAcceptedPlanRequiredUnitRows,
} from "./db/accepted-plan-operational.js";
import { digestFormat1Inputs, isCanonicalTimestamp, isSafeRelativePath, SHA256_PATTERN } from "./db/accepted-plan-operational-model.js";
import { digestPlanInputs } from "./services/plan-freshness.js";

export const ownershipHistoryTables = [
  "source_revisions", "plan_revision_input_sets", "plan_revision_inputs", "plan_accepted_input_sets",
  "plan_revisions", "plan_revision_parts", "required_units", "plan_revision_required_units", "plan_revision_required_unit_sets",
] as const;

export function validateOwnershipHistory(database: Database.Database): void {
  const db = drizzle(database);
  for (const row of db.select({ bytes: acceptedPlanStoredTextBytes(true, [schema.buildProfiles.tenantId,
    schema.buildProfiles.name, schema.buildProfiles.orderNumber, schema.buildProfiles.specialRequest,
    schema.buildProfiles.archivedAt]) }).from(schema.buildProfiles)
    .where(inArray(schema.buildProfiles.id, db.select({ profileId: schema.planRevisions.profileId }).from(schema.planRevisions))).all()) {
    validateAcceptedPlanStoredTextBytes(row.bytes, "pointer", "Accepted Plan Build text is corrupt");
  }
  for (const table of [schema.sourceRevisions, schema.planRevisionInputSets, schema.planRevisionInputs,
    schema.planAcceptedInputSets, schema.planRevisions, schema.planRevisionParts, schema.requiredUnits,
    schema.planRevisionRequiredUnits, schema.planRevisionRequiredUnitSets]) {
    const columns = Object.values(getTableColumns(table)).filter(column => column.dataType === "string");
    for (const row of db.select({ bytes: acceptedPlanStoredTextBytes(true, columns) }).from(table).all()) {
      validateAcceptedPlanStoredTextBytes(row.bytes, "revision", "Accepted ownership history row text is corrupt");
    }
  }
  const sources = db.select().from(schema.projects).all();
  const sourceRevisions = db.select().from(schema.sourceRevisions).all();
  const profiles = db.select().from(schema.buildProfiles).all();
  const revisions = db.select().from(schema.planRevisions).all();
  const parts = db.select().from(schema.planRevisionParts).all();
  const projections = db.select().from(schema.parts).all();
  const progress = z.array(z.object({ id: z.number(), tenantId: z.string(), partId: z.number(), unitIndex: z.number(), completed: z.unknown(), assembled: z.unknown() }))
    .parse(database.prepare("SELECT id,tenant_id AS tenantId,part_id AS partId,unit_index AS unitIndex,completed,assembled FROM print_progress").all());
  const partBooleans = new Map(z.array(z.object({ id: z.number(), included: z.unknown(), geometrySame: z.unknown() }))
    .parse(database.prepare("SELECT id,included,geometry_same AS geometrySame FROM plan_revision_parts").all()).map(row => [row.id, row]));
  const sets = db.select().from(schema.planRevisionInputSets).all();
  const inputs = db.select().from(schema.planRevisionInputs).all();
  const acceptedInputs = db.select().from(schema.planAcceptedInputSets).all();
  const units = db.select().from(schema.requiredUnits).all();
  const mappings = db.select().from(schema.planRevisionRequiredUnits).all();
  const unitSets = db.select().from(schema.planRevisionRequiredUnitSets).all();
  const fail = (message: string): never => { throw new Error(`Unsafe accepted history: ${message}`); };
  for (const revision of sourceRevisions) {
    if (!sources.some(source => source.id === revision.projectId && source.tenantId === revision.tenantId)
      || revision.completeness !== "complete" || !SHA256_PATTERN.test(revision.manifestDigest)
      || !revision.upstreamRevisionKey || !isCanonicalTimestamp(revision.syncedAt)
      || !isSafeRelativePath(revision.snapshotLocator)
      || !revision.snapshotLocator.startsWith(`${revision.projectId}/revisions/`)) fail("Source snapshot identity");
  }
  for (const source of sources) {
    if (source.currentSourceRevisionId != null && !sourceRevisions.some(revision =>
      revision.id === source.currentSourceRevisionId && revision.projectId === source.id && revision.tenantId === source.tenantId)) fail("active Source pointer");
  }
  for (const set of sets) {
    const selected = inputs.filter(input => input.inputSetId === set.id);
    if (!set.publishedAt || !isCanonicalTimestamp(set.publishedAt) || !isCanonicalTimestamp(set.recordedAt)
      || selected.length !== set.expectedInputCount || ![1, 2].includes(set.formatVersion)
      || new Set(selected.map(input => input.sourceId)).size !== selected.length) fail("unpublished or incomplete Plan inputs");
    if (set.formatVersion === 2 && (
      new Set(selected.map(input => input.sourceLayer)).size !== selected.length
      || new Set(selected.map(input => input.layerOrder)).size !== selected.length
    )) fail("duplicate Plan input layer or order");
    for (const input of selected) {
      const source = sources.find(source => source.id === input.sourceId);
      if (!source || source.tenantId !== set.tenantId || input.tenantId !== set.tenantId
        || !Number.isSafeInteger(input.layerOrder) || input.layerOrder < 0 || !input.sourceLayer) fail("Plan input owner or layer");
      if (input.trackingKind === "revision") {
        const revision = sourceRevisions.find(revision => revision.id === input.sourceRevisionId);
        if (!revision || revision.projectId !== input.sourceId || revision.tenantId !== input.tenantId
          || revision.manifestDigest !== input.manifestDigest) fail("Plan input Source revision");
      } else if (input.trackingKind !== "untracked" || input.sourceRevisionId != null || input.manifestDigest != null) fail("Plan input tracking");
      if (set.formatVersion === 1 && (input.trackingKind !== "revision" || input.effectiveNamingDigest != null
        || input.sourceLayer !== `legacy:${input.sourceId}` || input.layerOrder !== 0)) fail("format-1 inputs");
      if (set.formatVersion === 2 && (input.effectiveNamingDigest == null || !SHA256_PATTERN.test(input.effectiveNamingDigest))) fail("naming digest");
    }
    const digest = set.formatVersion === 1
      ? digestFormat1Inputs(selected.map(input => ({ sourceRevisionId: input.sourceRevisionId ?? fail("missing revision"), manifestDigest: input.manifestDigest ?? fail("missing digest") })))
      : digestPlanInputs(selected.map(input => ({ source_id: input.sourceId, source_layer: input.sourceLayer, layer_order: input.layerOrder,
        tracking_kind: input.trackingKind === "revision" ? "revision" : "untracked", source_revision_id: input.sourceRevisionId,
        manifest_digest: input.manifestDigest, effective_naming_digest: input.effectiveNamingDigest ?? fail("missing naming digest") })));
    if (digest !== set.inputSetDigest) fail("Plan input digest");
  }
  for (const accepted of acceptedInputs) {
    if (!sets.some(set => set.id === accepted.inputSetId && set.profileId === accepted.profileId && set.tenantId === accepted.tenantId)) fail("accepted input pointer");
  }
  const acceptedPlans = new Map<number, { kind: "compatibility_dirty" | "ready"; revision: (typeof revisions)[number] }>();
  for (const profile of profiles) {
    const history = revisions.filter(revision => revision.profileId === profile.id);
    if (!Number.isSafeInteger(profile.acceptedPlanVersion) || profile.acceptedPlanVersion < 0) fail("accepted Plan version");
    if (profile.acceptedPlanRevisionId == null) {
      if ((profile.acceptedPlanVersion === 0) !== (history.length === 0)) fail("missing accepted Plan pointer");
      if (profile.acceptedPlanVersion === 0) continue;
    } else if (profile.acceptedPlanVersion === 0) fail("accepted Plan pointer");
    const accepted = (profile.acceptedPlanRevisionId == null
      ? history.sort((left, right) => right.revisionNumber - left.revisionNumber)[0]
      : history.find(revision => revision.id === profile.acceptedPlanRevisionId && revision.tenantId === profile.tenantId))
      ?? fail("accepted Plan pointer");
    if (profile.acceptedPlanRevisionId == null) {
      if (profile.acceptedPlanVersion !== accepted.revisionNumber) fail("accepted Plan version disagrees with history");
      if (history.length !== profile.acceptedPlanVersion || history.some((revision, index) => revision.revisionNumber !== profile.acceptedPlanVersion - index)) fail("incomplete accepted Plan history");
      if (history.some((revision, index) => revision.parentRevisionId !== (history[index + 1]?.id ?? null))) fail("revision lineage");
    }
    acceptedPlans.set(profile.id, { kind: profile.acceptedPlanRevisionId == null ? "compatibility_dirty" : "ready", revision: accepted });
    validateAcceptedPlanInputHeaderRows({ tenantId: profile.tenantId, profileId: profile.id, revision: accepted,
      acceptedInput: acceptedInputs.find(input => input.profileId === profile.id),
      inputSet: sets.find(set => set.id === accepted.inputSetId) });
  }
  for (const revision of revisions) {
    const revisionParts = parts.filter(part => part.revisionId === revision.id);
    if (acceptedPlans.get(revision.profileId)?.revision.id === revision.id) {
      validateAcceptedPlanRevisionPartRows({ revisionParts, revisionBooleans: partBooleans });
      validateAcceptedPlanProgressRows({ tenantId: revision.tenantId,
        parts: revisionParts.map(part => ({ projectionPartId: part.projectionPartId ?? fail("Part projection Plan"), quantityEffective: part.quantityEffective })),
        rows: progress });
    }
    validateAcceptedPlanRevisionRows({ tenantId: revision.tenantId, profileId: revision.profileId, revision,
      parent: revisions.find(parent => parent.id === revision.parentRevisionId) ?? null, revisionParts });
    if (revision.parentRevisionId != null && !revisions.some(parent => parent.id === revision.parentRevisionId && parent.revisionNumber < revision.revisionNumber)) fail("revision lineage");
    if (revision.provenanceKind === "tracked" && !sets.some(set => set.id === revision.inputSetId && set.profileId === revision.profileId && set.tenantId === revision.tenantId)) fail("revision input Plan");
    const requiredSet = unitSets.find(set => set.revisionId === revision.id);
    const revisionMappings = mappings.filter(mapping => mapping.revisionId === revision.id);
    const createdHere = units.filter(unit => unit.createdInRevisionId === revision.id);
    if (!requiredSet) {
      if (acceptedPlans.get(revision.profileId)?.revision.id === revision.id || revisionMappings.length || createdHere.length) fail("missing or partial Required-unit map");
    } else {
      validateAcceptedPlanRequiredUnitRows({ tenantId: revision.tenantId, profileId: revision.profileId, revisionId: revision.id,
        requiredSet,
        parts: revisionParts.map(part => ({ revisionPartId: part.id, included: part.included, quantityEffective: part.quantityEffective })),
        mappings: revisionMappings,
        units: units.filter(unit => unit.profileId === revision.profileId), creationRevisions: revisions,
        createdHere });
    }
    for (const part of revisionParts) {
      if (part.relativePath && !isSafeRelativePath(part.relativePath)) fail("Part path");
      if (part.filename && (!isSafeRelativePath(part.filename) || part.filename.includes("/"))) fail("Part filename");
      if (part.projectionPartId != null) {
        if (!Number.isSafeInteger(part.projectionPartId) || part.projectionPartId <= 0) fail("Part projection Plan");
        const projection = projections.find(projection => projection.id === part.projectionPartId);
        if (projection ? projection.profileId !== revision.profileId || projection.tenantId !== revision.tenantId
          : acceptedPlans.get(revision.profileId)?.kind !== "compatibility_dirty") fail("Part projection Plan");
      }
    }
  }
}
