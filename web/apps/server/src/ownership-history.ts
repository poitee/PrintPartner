import type Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./db/schema.js";
import {
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
  const sources = db.select().from(schema.projects).all();
  const sourceRevisions = db.select().from(schema.sourceRevisions).all();
  const profiles = db.select().from(schema.buildProfiles).all();
  const revisions = db.select().from(schema.planRevisions).all();
  const parts = db.select().from(schema.planRevisionParts).all();
  const projections = db.select().from(schema.parts).all();
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
  for (const revision of revisions) {
    const revisionParts = parts.filter(part => part.revisionId === revision.id);
    validateAcceptedPlanRevisionRows({ tenantId: revision.tenantId, profileId: revision.profileId, revision,
      parent: revisions.find(parent => parent.id === revision.parentRevisionId) ?? null, revisionParts });
    if (revision.parentRevisionId != null && !revisions.some(parent => parent.id === revision.parentRevisionId && parent.revisionNumber < revision.revisionNumber)) fail("revision lineage");
    if (revision.provenanceKind === "tracked" && !sets.some(set => set.id === revision.inputSetId && set.profileId === revision.profileId && set.tenantId === revision.tenantId)) fail("revision input Plan");
    const requiredSet = unitSets.find(set => set.revisionId === revision.id);
    const revisionMappings = mappings.filter(mapping => mapping.revisionId === revision.id);
    const createdHere = units.filter(unit => unit.createdInRevisionId === revision.id);
    if (!requiredSet) {
      if (profiles.some(profile => profile.acceptedPlanRevisionId === revision.id) || revisionMappings.length || createdHere.length) fail("missing or partial Required-unit map");
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
      if (part.projectionPartId != null && !projections.some(projection => projection.id === part.projectionPartId && projection.profileId === revision.profileId && projection.tenantId === revision.tenantId)) fail("Part projection Plan");
    }
  }
  for (const profile of profiles) {
    const history = revisions.filter(revision => revision.profileId === profile.id);
    if (profile.acceptedPlanRevisionId == null) {
      if (profile.acceptedPlanVersion !== 0 || history.length) fail("missing accepted Plan pointer");
    } else {
      const accepted = history.find(revision => revision.id === profile.acceptedPlanRevisionId && revision.tenantId === profile.tenantId) ?? fail("accepted Plan pointer");
      if (profile.acceptedPlanVersion <= 0) fail("accepted Plan pointer");
      const acceptedInput = acceptedInputs.find(input => input.profileId === profile.id);
      if ((accepted.provenanceKind === "tracked" && acceptedInput?.inputSetId !== accepted.inputSetId)
        || (accepted.provenanceKind === "legacy" && acceptedInput)) fail("accepted Plan input pointer");
    }
  }
}
