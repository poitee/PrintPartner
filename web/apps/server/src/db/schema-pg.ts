import {
  type AnyPgColumn,
  boolean,
  check,
  integer,
  pgTable,
  primaryKey,
  serial,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const DEFAULT_TENANT_ID = "default";

export const projects = pgTable(
  "projects",
  {
    id: serial("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default(DEFAULT_TENANT_ID),
    name: text("name").notNull(),
    url: text("url").notNull(),
    sourceType: text("source_type").notNull().default("git"),
    branch: text("branch").notNull().default("main"),
    tag: text("tag"),
    localPath: text("local_path"),
    lastSyncedAt: text("last_synced_at"),
    lastCommitSha: text("last_commit_sha"),
    docsUrl: text("docs_url"),
    importedPaths: text("imported_paths"),
    manifestCommunitySlug: text("manifest_community_slug"),
    sourceKind: text("source_kind").notNull().default("github"),
    role: text("role").notNull().default("unassigned"),
    metadataJson: text("metadata_json"),
    currentSourceRevisionId: integer("current_source_revision_id").references(
      (): AnyPgColumn => sourceRevisions.id,
      { onDelete: "restrict" },
    ),
  },
  (t) => [uniqueIndex("uq_projects_tenant_name").on(t.tenantId, t.name)],
);

export const buildProfiles = pgTable(
  "build_profiles",
  {
    id: serial("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default(DEFAULT_TENANT_ID),
    name: text("name").notNull(),
    orderNumber: text("order_number"),
    /** Quiet operator note shown on Plan + Progress. */
    specialRequest: text("special_request"),
    configModifiedAt: text("config_modified_at"),
    lastRecomputedAt: text("last_recomputed_at"),
    /** ISO timestamp when plan was archived as a reusable template; null = active. */
    archivedAt: text("archived_at"),
    /** ISO timestamp of last spine selection (picker / activate). */
    lastUsedAt: text("last_used_at"),
    acceptedPlanRevisionId: integer("accepted_plan_revision_id").references(
      (): AnyPgColumn => planRevisions.id,
      { onDelete: "set null" },
    ),
    acceptedPlanVersion: integer("accepted_plan_version").notNull().default(0),
  },
  (t) => [uniqueIndex("uq_profiles_tenant_name").on(t.tenantId, t.name)],
);

export const profileLayers = pgTable("profile_layers", {
  id: serial("id").primaryKey(),
  tenantId: text("tenant_id").notNull().default(DEFAULT_TENANT_ID),
  profileId: integer("profile_id")
    .notNull()
    .references(() => buildProfiles.id, { onDelete: "cascade" }),
  layerOrder: integer("layer_order").notNull().default(0),
  layerType: text("layer_type").notNull(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "set null" }),
});

export const sourceRevisions = pgTable(
  "source_revisions",
  {
    id: serial("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default(DEFAULT_TENANT_ID),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    upstreamRevisionKey: text("upstream_revision_key").notNull(),
    manifestDigest: text("manifest_digest").notNull(),
    snapshotLocator: text("snapshot_locator").notNull(),
    syncedAt: text("synced_at").notNull(),
    completeness: text("completeness").notNull().default("complete"),
  },
  (t) => [
    uniqueIndex("uq_source_revisions_tenant_source_upstream").on(
      t.tenantId,
      t.projectId,
      t.upstreamRevisionKey,
    ),
  ],
);

export const planRevisionInputSets = pgTable(
  "plan_revision_input_sets",
  {
    id: serial("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default(DEFAULT_TENANT_ID),
    profileId: integer("profile_id")
      .notNull()
      .references(() => buildProfiles.id, { onDelete: "cascade" }),
    inputSetDigest: text("input_set_digest").notNull(),
    expectedInputCount: integer("expected_input_count").notNull(),
    formatVersion: integer("format_version").notNull().default(1),
    recordedAt: text("recorded_at").notNull(),
    publishedAt: text("published_at"),
  },
  (t) => [
    uniqueIndex("uq_plan_revision_input_sets_tenant_plan_digest").on(
      t.tenantId,
      t.profileId,
      t.inputSetDigest,
    ),
  ],
);

export const planRevisionInputs = pgTable(
  "plan_revision_inputs",
  {
    id: serial("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default(DEFAULT_TENANT_ID),
    inputSetId: integer("input_set_id")
      .notNull()
      .references(() => planRevisionInputSets.id, { onDelete: "cascade" }),
    sourceId: integer("source_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    sourceLayer: text("source_layer").notNull(),
    layerOrder: integer("layer_order").notNull().default(0),
    trackingKind: text("tracking_kind").notNull().default("revision"),
    sourceRevisionId: integer("source_revision_id").references(() => sourceRevisions.id, {
      onDelete: "restrict",
    }),
    manifestDigest: text("manifest_digest"),
    effectiveNamingDigest: text("effective_naming_digest"),
  },
  (t) => [
    uniqueIndex("uq_plan_revision_inputs_v2_set_source")
      .on(t.inputSetId, t.sourceId)
      .where(sql`${t.effectiveNamingDigest} IS NOT NULL`),
  ],
);

export const planAcceptedInputSets = pgTable("plan_accepted_input_sets", {
  tenantId: text("tenant_id").notNull().default(DEFAULT_TENANT_ID),
  profileId: integer("profile_id")
    .primaryKey()
    .references(() => buildProfiles.id, { onDelete: "cascade" }),
  inputSetId: integer("input_set_id")
    .notNull()
    .references(() => planRevisionInputSets.id, { onDelete: "restrict" }),
  acceptedAt: text("accepted_at").notNull(),
});

export const planRevisions = pgTable(
  "plan_revisions",
  {
    id: serial("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default(DEFAULT_TENANT_ID),
    profileId: integer("profile_id")
      .notNull()
      .references(() => buildProfiles.id, { onDelete: "cascade" }),
    revisionNumber: integer("revision_number").notNull(),
    parentRevisionId: integer("parent_revision_id").references(
      (): AnyPgColumn => planRevisions.id,
      { onDelete: "restrict" },
    ),
    inputSetId: integer("input_set_id").references(() => planRevisionInputSets.id, {
      onDelete: "restrict",
    }),
    provenanceKind: text("provenance_kind").$type<"tracked" | "legacy">().notNull(),
    digestFormat: text("digest_format").notNull(),
    snapshotDigest: text("snapshot_digest").notNull(),
    createdBy: text("created_by").notNull(),
    acceptedBy: text("accepted_by").notNull(),
    createdAt: text("created_at").notNull(),
    acceptedAt: text("accepted_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_plan_revisions_tenant_plan_number").on(
      t.tenantId,
      t.profileId,
      t.revisionNumber,
    ),
    check(
      "chk_plan_revisions_provenance",
      sql`(${t.provenanceKind} = 'tracked' AND ${t.inputSetId} IS NOT NULL)
          OR (${t.provenanceKind} = 'legacy' AND ${t.inputSetId} IS NULL)`,
    ),
  ],
);

export const planRevisionParts = pgTable("plan_revision_parts", {
  id: serial("id").primaryKey(),
  tenantId: text("tenant_id").notNull().default(DEFAULT_TENANT_ID),
  revisionId: integer("revision_id")
    .notNull()
    .references(() => planRevisions.id, { onDelete: "cascade" }),
  projectionPartId: integer("projection_part_id"),
  partKey: text("part_key").notNull(),
  relativePath: text("relative_path").notNull().default(""),
  filename: text("filename").notNull().default(""),
  sourceLayer: text("source_layer").notNull().default(""),
  status: text("status").notNull().default("base"),
  roleInferred: text("role_inferred").notNull().default("primary"),
  roleOverride: text("role_override"),
  filamentColorId: text("filament_color_id"),
  filamentCustomHex: text("filament_custom_hex"),
  spoolmanSpoolId: text("spoolman_spool_id"),
  quantityInferred: integer("quantity_inferred").notNull().default(1),
  quantityOverride: integer("quantity_override"),
  quantityEffective: integer("quantity_effective").notNull().default(1),
  included: boolean("included").notNull().default(true),
  notes: text("notes").notNull().default(""),
  githubBlobUrl: text("github_blob_url"),
  geometrySame: boolean("geometry_same"),
  requirement: text("requirement"),
  optionGroupId: text("option_group_id"),
  manifestSource: text("manifest_source"),
  artifactDigest: text("artifact_digest"),
});

export const requiredUnits = pgTable(
  "required_units",
  {
    token: text("token").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    profileId: integer("profile_id")
      .notNull()
      .references(() => buildProfiles.id, { onDelete: "cascade" }),
    createdInRevisionId: integer("created_in_revision_id")
      .notNull()
      .references(() => planRevisions.id, { onDelete: "cascade" }),
    objectName: text("object_name").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_required_units_object_name_ci").on(sql`lower(${t.objectName})`),
    check("chk_required_units_token", sql`${t.token} ~ '^ppu_[0-9a-f]{32}$'`),
    check(
      "chk_required_units_object_name",
      sql`length(${t.objectName}) BETWEEN 1 AND 200
          AND right(${t.objectName}, length(${t.token}) + 2) = '__' || ${t.token}`,
    ),
  ],
);

export const planRevisionRequiredUnitSets = pgTable(
  "plan_revision_required_unit_sets",
  {
    revisionId: integer("revision_id")
      .primaryKey()
      .references(() => planRevisions.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id").notNull(),
    profileId: integer("profile_id")
      .notNull()
      .references(() => buildProfiles.id, { onDelete: "cascade" }),
    format: text("format").notNull(),
    expectedUnitCount: integer("expected_unit_count").notNull(),
    mappingDigest: text("mapping_digest").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    check("chk_plan_revision_required_unit_sets_format", sql`${t.format} = 'required-unit-map-v1'`),
    check("chk_plan_revision_required_unit_sets_count", sql`${t.expectedUnitCount} >= 0`),
  ],
);

export const planRevisionRequiredUnits = pgTable(
  "plan_revision_required_units",
  {
    tenantId: text("tenant_id").notNull(),
    revisionId: integer("revision_id")
      .notNull()
      .references(() => planRevisions.id, { onDelete: "cascade" }),
    revisionPartId: integer("revision_part_id")
      .notNull()
      .references(() => planRevisionParts.id, { onDelete: "cascade" }),
    unitIndex: integer("unit_index").notNull(),
    requiredUnitToken: text("required_unit_token")
      .notNull()
      .references(() => requiredUnits.token, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({
      name: "pk_plan_revision_required_units",
      columns: [t.tenantId, t.revisionId, t.revisionPartId, t.unitIndex],
    }),
    uniqueIndex("uq_plan_revision_required_units_token").on(
      t.tenantId,
      t.revisionId,
      t.requiredUnitToken,
    ),
    check(
      "chk_plan_revision_required_units_index",
      sql`${t.unitIndex} BETWEEN 0 AND 9999`,
    ),
  ],
);

export const acceptedPlateRevisions = pgTable(
  "accepted_plate_revisions",
  {
    id: serial("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    profileId: integer("profile_id")
      .notNull()
      .references(() => buildProfiles.id, { onDelete: "cascade" }),
    planRevisionId: integer("plan_revision_id")
      .notNull()
      .references(() => planRevisions.id, { onDelete: "cascade" }),
    planVersion: integer("plan_version").notNull(),
    planRevisionDigest: text("plan_revision_digest").notNull(),
    requiredUnitMappingDigest: text("required_unit_mapping_digest").notNull(),
    layoutDigest: text("layout_digest").notNull(),
    expectedPlateCount: integer("expected_plate_count").notNull(),
    expectedUnitCount: integer("expected_unit_count").notNull(),
    revisionNumber: integer("revision_number").notNull(),
    undoFromRevisionId: integer("undo_from_revision_id").references(
      (): AnyPgColumn => acceptedPlateRevisions.id,
      { onDelete: "set null" },
    ),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_accepted_plate_revisions_tenant_profile_number").on(
      t.tenantId,
      t.profileId,
      t.revisionNumber,
    ),
    check("chk_accepted_plate_revisions_plan_version", sql`${t.planVersion} > 0`),
    check("chk_accepted_plate_revisions_number", sql`${t.revisionNumber} > 0`),
    check("chk_accepted_plate_revisions_plate_count", sql`${t.expectedPlateCount} > 0`),
    check("chk_accepted_plate_revisions_unit_count", sql`${t.expectedUnitCount} > 0`),
  ],
);

export const acceptedPlateHeads = pgTable("accepted_plate_heads", {
  tenantId: text("tenant_id").notNull(),
  profileId: integer("profile_id")
    .primaryKey()
    .references(() => buildProfiles.id, { onDelete: "cascade" }),
  currentRevisionId: integer("current_revision_id")
    .notNull()
    .references(() => acceptedPlateRevisions.id, { onDelete: "cascade" }),
});

export const acceptedPlates = pgTable(
  "accepted_plates",
  {
    tenantId: text("tenant_id").notNull(),
    revisionId: integer("revision_id")
      .notNull()
      .references(() => acceptedPlateRevisions.id, { onDelete: "cascade" }),
    plateId: text("plate_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    printerId: text("printer_id").notNull(),
    printerName: text("printer_name").notNull(),
    printerModel: text("printer_model").notNull(),
    bedWidthUm: integer("bed_width_um").notNull(),
    bedDepthUm: integer("bed_depth_um").notNull(),
    bedHeightUm: integer("bed_height_um").notNull(),
    marginUm: integer("margin_um").notNull(),
  },
  (t) => [
    primaryKey({ name: "pk_accepted_plates", columns: [t.tenantId, t.revisionId, t.plateId] }),
    uniqueIndex("uq_accepted_plates_tenant_revision_ordinal").on(
      t.tenantId,
      t.revisionId,
      t.ordinal,
    ),
    check("chk_accepted_plates_ordinal", sql`${t.ordinal} > 0`),
    check("chk_accepted_plates_bed_width", sql`${t.bedWidthUm} BETWEEN 1 AND 2147483647`),
    check("chk_accepted_plates_bed_depth", sql`${t.bedDepthUm} BETWEEN 1 AND 2147483647`),
    check("chk_accepted_plates_bed_height", sql`${t.bedHeightUm} BETWEEN 1 AND 2147483647`),
    check("chk_accepted_plates_margin", sql`${t.marginUm} BETWEEN 0 AND 2147483647`),
  ],
);

export const acceptedPlateUnits = pgTable(
  "accepted_plate_units",
  {
    tenantId: text("tenant_id").notNull(),
    revisionId: integer("revision_id")
      .notNull()
      .references(() => acceptedPlateRevisions.id, { onDelete: "cascade" }),
    plateId: text("plate_id").notNull(),
    requiredUnitToken: text("required_unit_token")
      .notNull()
      .references(() => requiredUnits.token, { onDelete: "cascade" }),
    xUm: integer("x_um").notNull(),
    yUm: integer("y_um").notNull(),
    widthUm: integer("width_um").notNull(),
    depthUm: integer("depth_um").notNull(),
    heightUm: integer("height_um").notNull(),
    placement: text("placement").$type<"auto" | "manual" | "unplaced">().notNull().default("auto"),
    pinned: boolean("pinned").notNull().default(false),
  },
  (t) => [
    primaryKey({
      name: "pk_accepted_plate_units",
      columns: [t.tenantId, t.revisionId, t.requiredUnitToken],
    }),
    check("chk_accepted_plate_units_x", sql`${t.xUm} BETWEEN 0 AND 2147483647`),
    check("chk_accepted_plate_units_y", sql`${t.yUm} BETWEEN 0 AND 2147483647`),
    check("chk_accepted_plate_units_width", sql`${t.widthUm} BETWEEN 1 AND 2147483647`),
    check("chk_accepted_plate_units_depth", sql`${t.depthUm} BETWEEN 1 AND 2147483647`),
    check("chk_accepted_plate_units_height", sql`${t.heightUm} BETWEEN 1 AND 2147483647`),
    check("chk_accepted_plate_units_placement", sql`${t.placement} IN ('auto', 'manual', 'unplaced')`),
  ],
);

export const planDrafts = pgTable(
  "plan_drafts",
  {
    id: serial("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default(DEFAULT_TENANT_ID),
    profileId: integer("profile_id")
      .notNull()
      .references(() => buildProfiles.id, { onDelete: "cascade" }),
    baseRevisionId: integer("base_revision_id").references(() => planRevisions.id, {
      onDelete: "restrict",
    }),
    basePlanVersion: integer("base_plan_version").notNull(),
    state: text("state").$type<"open" | "abandoned" | "consumed">().notNull(),
    lifecycleVersion: integer("lifecycle_version").notNull().default(0),
    rebasedFromDraftId: integer("rebased_from_draft_id").references(
      (): AnyPgColumn => planDrafts.id,
      { onDelete: "cascade" },
    ),
    rebasedFromLifecycleVersion: integer("rebased_from_lifecycle_version"),
    rebasedFromSnapshotDigest: text("rebased_from_snapshot_digest"),
    currentRequiredUnitReconciliationId: integer(
      "current_required_unit_reconciliation_id",
    ).references(
      (): AnyPgColumn => planDraftRequiredUnitReconciliations.id,
      { onDelete: "set null" },
    ),
    consumedRevisionId: integer("consumed_revision_id").references(() => planRevisions.id, {
      onDelete: "cascade",
    }),
    consumedAt: text("consumed_at"),
    digestFormat: text("digest_format").notNull(),
    snapshotDigest: text("snapshot_digest").notNull(),
    createdBy: text("created_by").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_plan_drafts_tenant_actor_profile_key").on(
      t.tenantId,
      t.createdBy,
      t.profileId,
      t.idempotencyKey,
    ),
    check("chk_plan_drafts_state", sql`${t.state} IN ('open', 'abandoned', 'consumed')`),
    check(
      "chk_plan_drafts_base",
      sql`(${t.baseRevisionId} IS NULL AND ${t.basePlanVersion} = 0)
          OR (${t.baseRevisionId} IS NOT NULL AND ${t.basePlanVersion} > 0)`,
    ),
    check(
      "chk_plan_drafts_lifecycle_version",
      sql`${t.lifecycleVersion} >= 0 AND ${t.lifecycleVersion} <= 2147483647`,
    ),
    check(
      "chk_plan_drafts_rebase_origin",
      sql`(${t.rebasedFromDraftId} IS NULL
            AND ${t.rebasedFromLifecycleVersion} IS NULL
            AND ${t.rebasedFromSnapshotDigest} IS NULL)
          OR (${t.rebasedFromDraftId} IS NOT NULL
            AND ${t.rebasedFromLifecycleVersion} IS NOT NULL
            AND ${t.rebasedFromSnapshotDigest} IS NOT NULL
            AND ${t.rebasedFromLifecycleVersion} >= 0
            AND ${t.rebasedFromLifecycleVersion} <= 2147483647)`,
    ),
    check(
      "chk_plan_drafts_consumption",
      sql`(${t.consumedRevisionId} IS NULL AND ${t.consumedAt} IS NULL)
          OR (${t.state} = 'consumed'
            AND ${t.consumedRevisionId} IS NOT NULL
            AND ${t.consumedAt} IS NOT NULL)`,
    ),
  ],
);

export const planDraftInputs = pgTable(
  "plan_draft_inputs",
  {
    id: serial("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default(DEFAULT_TENANT_ID),
    draftId: integer("draft_id")
      .notNull()
      .references(() => planDrafts.id, { onDelete: "cascade" }),
    sourceId: integer("source_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    sourceLayer: text("source_layer").notNull(),
    layerOrder: integer("layer_order").notNull(),
    trackingKind: text("tracking_kind").$type<"revision" | "untracked">().notNull(),
    sourceRevisionId: integer("source_revision_id").references(() => sourceRevisions.id, {
      onDelete: "restrict",
    }),
    manifestDigest: text("manifest_digest"),
    effectiveNamingDigest: text("effective_naming_digest").notNull(),
  },
  (t) => [
    uniqueIndex("uq_plan_draft_inputs_tenant_draft_source").on(
      t.tenantId,
      t.draftId,
      t.sourceId,
    ),
    check(
      "chk_plan_draft_inputs_identity",
      sql`(${t.trackingKind} = 'revision' AND ${t.sourceRevisionId} IS NOT NULL AND ${t.manifestDigest} IS NOT NULL)
          OR (${t.trackingKind} = 'untracked' AND ${t.sourceRevisionId} IS NULL AND ${t.manifestDigest} IS NULL)`,
    ),
  ],
);

export const planDraftParts = pgTable("plan_draft_parts", {
  id: serial("id").primaryKey(),
  tenantId: text("tenant_id").notNull().default(DEFAULT_TENANT_ID),
  draftId: integer("draft_id")
    .notNull()
    .references(() => planDrafts.id, { onDelete: "cascade" }),
  baseRevisionPartId: integer("base_revision_part_id").references(
    () => planRevisionParts.id,
    { onDelete: "restrict" },
  ),
  partKey: text("part_key").notNull(),
  relativePath: text("relative_path").notNull().default(""),
  filename: text("filename").notNull().default(""),
  sourceLayer: text("source_layer").notNull().default(""),
  status: text("status").notNull().default("base"),
  roleInferred: text("role_inferred").notNull().default("primary"),
  roleOverride: text("role_override"),
  filamentColorId: text("filament_color_id"),
  filamentCustomHex: text("filament_custom_hex"),
  spoolmanSpoolId: text("spoolman_spool_id"),
  quantityInferred: integer("quantity_inferred").notNull().default(1),
  quantityOverride: integer("quantity_override"),
  quantityEffective: integer("quantity_effective").notNull().default(1),
  included: boolean("included").notNull().default(true),
  notes: text("notes").notNull().default(""),
  githubBlobUrl: text("github_blob_url"),
  geometrySame: boolean("geometry_same"),
  requirement: text("requirement"),
  optionGroupId: text("option_group_id"),
  manifestSource: text("manifest_source"),
  artifactDigest: text("artifact_digest"),
}, (t) => [
  uniqueIndex("uq_plan_draft_parts_tenant_draft_predecessor").on(
    t.tenantId,
    t.draftId,
    t.baseRevisionPartId,
  ),
]);

export const planDraftRequiredUnitReconciliations = pgTable(
  "plan_draft_required_unit_reconciliations",
  {
    id: serial("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    profileId: integer("profile_id")
      .notNull()
      .references(() => buildProfiles.id, { onDelete: "cascade" }),
    draftId: integer("draft_id")
      .notNull()
      .references(() => planDrafts.id, { onDelete: "cascade" }),
    format: text("format").notNull(),
    planningDigest: text("planning_digest").notNull(),
    baseRevisionId: integer("base_revision_id").references(() => planRevisions.id, {
      onDelete: "restrict",
    }),
    baseMappingDigest: text("base_mapping_digest"),
    selectionBasisDigest: text("selection_basis_digest").notNull(),
    selectionBasisJson: text("selection_basis_json").notNull(),
    decisionDigest: text("decision_digest").notNull(),
    resultKind: text("result_kind").$type<"unresolved" | "ready">().notNull(),
    resultDigest: text("result_digest").notNull(),
    resultJson: text("result_json").notNull(),
    reconciliationDigest: text("reconciliation_digest").notNull(),
    expectedAssignmentCount: integer("expected_assignment_count").notNull(),
    actorId: text("actor_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    payloadDigest: text("payload_digest").notNull(),
    createdAt: text("created_at").notNull(),
    finalizedAt: text("finalized_at"),
  },
  (t) => [
    uniqueIndex("uq_plan_draft_required_unit_reconciliations_key").on(
      t.tenantId,
      t.actorId,
      t.draftId,
      t.idempotencyKey,
    ),
    check(
      "chk_plan_draft_required_unit_reconciliations_format",
      sql`${t.format} = 'required-unit-reconciliation-v1'`,
    ),
    check(
      "chk_plan_draft_required_unit_reconciliations_result",
      sql`${t.resultKind} IN ('unresolved', 'ready')`,
    ),
    check(
      "chk_plan_draft_required_unit_reconciliations_count",
      sql`${t.expectedAssignmentCount} >= 0`,
    ),
  ],
);

export const planDraftRequiredUnitDecisions = pgTable(
  "plan_draft_required_unit_decisions",
  {
    id: serial("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    reconciliationId: integer("reconciliation_id")
      .notNull()
      .references(() => planDraftRequiredUnitReconciliations.id, { onDelete: "cascade" }),
    targetDraftPartId: integer("target_draft_part_id")
      .notNull()
      .references(() => planDraftParts.id, { onDelete: "cascade" }),
    kind: text("kind")
      .$type<"select_exact_predecessor" | "accept_prior_completion" | "replace">()
      .notNull(),
    predecessorRevisionPartId: integer("predecessor_revision_part_id").references(
      () => planRevisionParts.id,
      { onDelete: "restrict" },
    ),
  },
  (t) => [
    uniqueIndex("uq_plan_draft_required_unit_decisions_target").on(
      t.tenantId,
      t.reconciliationId,
      t.targetDraftPartId,
    ),
    uniqueIndex("uq_plan_draft_required_unit_decisions_predecessor")
      .on(t.tenantId, t.reconciliationId, t.predecessorRevisionPartId)
      .where(sql`${t.predecessorRevisionPartId} IS NOT NULL`),
    check(
      "chk_plan_draft_required_unit_decisions_kind",
      sql`(${t.kind} = 'replace' AND ${t.predecessorRevisionPartId} IS NULL)
          OR (${t.kind} IN ('select_exact_predecessor', 'accept_prior_completion')
            AND ${t.predecessorRevisionPartId} IS NOT NULL)`,
    ),
  ],
);

export const planDraftRequiredUnitAssignments = pgTable(
  "plan_draft_required_unit_assignments",
  {
    tenantId: text("tenant_id").notNull(),
    reconciliationId: integer("reconciliation_id")
      .notNull()
      .references(() => planDraftRequiredUnitReconciliations.id, { onDelete: "cascade" }),
    targetDraftPartId: integer("target_draft_part_id")
      .notNull()
      .references(() => planDraftParts.id, { onDelete: "cascade" }),
    unitIndex: integer("unit_index").notNull(),
    kind: text("kind").$type<"reuse" | "create">().notNull(),
    requiredUnitToken: text("required_unit_token").references(() => requiredUnits.token, {
      onDelete: "restrict",
    }),
  },
  (t) => [
    primaryKey({
      name: "pk_plan_draft_required_unit_assignments",
      columns: [t.tenantId, t.reconciliationId, t.targetDraftPartId, t.unitIndex],
    }),
    uniqueIndex("uq_plan_draft_required_unit_assignments_token")
      .on(t.tenantId, t.reconciliationId, t.requiredUnitToken)
      .where(sql`${t.requiredUnitToken} IS NOT NULL`),
    check(
      "chk_plan_draft_required_unit_assignments_index",
      sql`${t.unitIndex} BETWEEN 0 AND 9999`,
    ),
    check(
      "chk_plan_draft_required_unit_assignments_kind",
      sql`(${t.kind} = 'reuse' AND ${t.requiredUnitToken} IS NOT NULL)
          OR (${t.kind} = 'create' AND ${t.requiredUnitToken} IS NULL)`,
    ),
  ],
);

export const planApplyRequests = pgTable(
  "plan_apply_requests",
  {
    id: serial("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    profileId: integer("profile_id")
      .notNull()
      .references(() => buildProfiles.id, { onDelete: "cascade" }),
    draftId: integer("draft_id")
      .notNull()
      .references(() => planDrafts.id, { onDelete: "cascade" }),
    actorId: text("actor_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestFormat: text("request_format").notNull(),
    requestDigest: text("request_digest").notNull(),
    expectedSnapshotDigest: text("expected_snapshot_digest").notNull(),
    expectedLifecycleVersion: integer("expected_lifecycle_version").notNull(),
    expectedBaseRevisionId: integer("expected_base_revision_id").references(
      () => planRevisions.id,
      { onDelete: "cascade" },
    ),
    expectedBasePlanVersion: integer("expected_base_plan_version").notNull(),
    reconciliationId: integer("reconciliation_id")
      .notNull()
      .references(() => planDraftRequiredUnitReconciliations.id, { onDelete: "cascade" }),
    reconciliationDigest: text("reconciliation_digest").notNull(),
    revisionId: integer("revision_id")
      .notNull()
      .references(() => planRevisions.id, { onDelete: "cascade" }),
    planVersion: integer("plan_version").notNull(),
    revisionDigest: text("revision_digest").notNull(),
    requiredUnitMappingDigest: text("required_unit_mapping_digest").notNull(),
    draftLifecycleVersion: integer("draft_lifecycle_version").notNull(),
    appliedAt: text("applied_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_plan_apply_requests_tenant_actor_profile_key").on(
      t.tenantId,
      t.actorId,
      t.profileId,
      t.idempotencyKey,
    ),
    uniqueIndex("uq_plan_apply_requests_tenant_profile_draft").on(
      t.tenantId,
      t.profileId,
      t.draftId,
    ),
    check("chk_plan_apply_requests_format", sql`${t.requestFormat} = 'plan-apply-request-v1'`),
    check(
      "chk_plan_apply_requests_base",
      sql`(${t.expectedBaseRevisionId} IS NULL AND ${t.expectedBasePlanVersion} = 0)
          OR (${t.expectedBaseRevisionId} IS NOT NULL AND ${t.expectedBasePlanVersion} > 0)`,
    ),
    check(
      "chk_plan_apply_requests_versions",
      sql`${t.expectedLifecycleVersion} BETWEEN 0 AND 2147483646
          AND ${t.draftLifecycleVersion} = ${t.expectedLifecycleVersion} + 1
          AND ${t.planVersion} = ${t.expectedBasePlanVersion} + 1`,
    ),
  ],
);

export const parts = pgTable("parts", {
  id: serial("id").primaryKey(),
  tenantId: text("tenant_id").notNull().default(DEFAULT_TENANT_ID),
  profileId: integer("profile_id")
    .notNull()
    .references(() => buildProfiles.id, { onDelete: "cascade" }),
  matchKey: text("match_key").notNull(),
  relativePath: text("relative_path").notNull().default(""),
  filename: text("filename").notNull().default(""),
  sourceLayer: text("source_layer").notNull().default(""),
  status: text("status").notNull().default("base"),
  role: text("role").notNull().default("primary"),
  filamentColorId: text("filament_color_id"),
  filamentCustomHex: text("filament_custom_hex"),
  spoolmanSpoolId: text("spoolman_spool_id"),
  quantityAuto: integer("quantity_auto").notNull().default(1),
  quantityOverride: integer("quantity_override"),
  quantityEffective: integer("quantity_effective").notNull().default(1),
  included: boolean("included").notNull().default(true),
  notes: text("notes").notNull().default(""),
  githubBlobUrl: text("github_blob_url"),
  geometrySame: boolean("geometry_same"),
  requirement: text("requirement"),
  optionGroupId: text("option_group_id"),
  manifestSource: text("manifest_source"),
});

export const printProgress = pgTable(
  "print_progress",
  {
    id: serial("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default(DEFAULT_TENANT_ID),
    partId: integer("part_id")
      .notNull()
      .references(() => parts.id, { onDelete: "cascade" }),
    unitIndex: integer("unit_index").notNull().default(0),
    completed: boolean("completed").notNull().default(false),
    assembled: boolean("assembled").notNull().default(false),
  },
  (t) => [uniqueIndex("uq_print_progress_part_unit").on(t.partId, t.unitIndex)],
);

export const appSettings = pgTable(
  "app_settings",
  {
    tenantId: text("tenant_id").notNull().default(DEFAULT_TENANT_ID),
    key: text("key").notNull(),
    value: text("value").notNull().default(""),
  },
  (t) => [uniqueIndex("uq_app_settings_tenant_key").on(t.tenantId, t.key)],
);

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").unique(),
  displayName: text("display_name").notNull(),
  passwordHash: text("password_hash"),
  isAdmin: boolean("is_admin").notNull().default(false),
  createdAt: text("created_at").notNull(),
});

export const authIdentities = pgTable(
  "auth_identities",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerUserId: text("provider_user_id").notNull(),
  },
  (t) => [uniqueIndex("uq_auth_identity_provider").on(t.provider, t.providerUserId)],
);

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: text("expires_at").notNull(),
});

export const planShares = pgTable("plan_shares", {
  id: text("id").primaryKey(),
  token: text("token").notNull().unique(),
  fromUserId: text("from_user_id")
    .notNull()
    .references(() => users.id),
  planId: integer("plan_id").notNull(),
  planName: text("plan_name").notNull(),
  recipientEmail: text("recipient_email"),
  bundleJson: text("bundle_json").notNull(),
  status: text("status").notNull().default("pending"),
  createdAt: text("created_at").notNull(),
});

export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
});

/** Synced markdown/PDF docs under a source repo tree. */
export const sourceDocs = pgTable(
  "source_docs",
  {
    id: serial("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default(DEFAULT_TENANT_ID),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    kind: text("kind").notNull(),
    sizeBytes: integer("size_bytes").notNull().default(0),
    contentHash: text("content_hash"),
    extractStatus: text("extract_status").notNull().default("pending"),
    extractError: text("extract_error"),
    pageCount: integer("page_count"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("uq_source_docs_project_path").on(t.projectId, t.path)],
);

/** User-contributed markdown notes for a source (optionally plan-scoped). */
export const sourceNotes = pgTable("source_notes", {
  id: serial("id").primaryKey(),
  tenantId: text("tenant_id").notNull().default(DEFAULT_TENANT_ID),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  profileId: integer("profile_id").references(() => buildProfiles.id, {
    onDelete: "set null",
  }),
  title: text("title").notNull().default(""),
  bodyMarkdown: text("body_markdown").notNull().default(""),
  authorUserId: text("author_user_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** Durable per-plan assistant/user decision trail (Apply / Dismiss / notes). */
export const planDecisions = pgTable("plan_decisions", {
  id: serial("id").primaryKey(),
  tenantId: text("tenant_id").notNull().default(DEFAULT_TENANT_ID),
  profileId: integer("profile_id")
    .notNull()
    .references(() => buildProfiles.id, { onDelete: "cascade" }),
  createdAt: text("created_at").notNull(),
  actor: text("actor").notNull().default("assistant"),
  kind: text("kind").notNull(),
  actionType: text("action_type"),
  paramsJson: text("params_json").notNull().default("{}"),
  label: text("label").notNull().default(""),
  summary: text("summary").notNull().default(""),
  rationale: text("rationale"),
  resultJson: text("result_json"),
});

/** Point-in-time plan configuration snapshots (layers + kit + refs). */
export const planSnapshots = pgTable("plan_snapshots", {
  id: serial("id").primaryKey(),
  tenantId: text("tenant_id").notNull().default(DEFAULT_TENANT_ID),
  profileId: integer("profile_id")
    .notNull()
    .references(() => buildProfiles.id, { onDelete: "cascade" }),
  name: text("name").notNull().default(""),
  createdAt: text("created_at").notNull(),
  source: text("source").notNull().default("user"),
  payloadJson: text("payload_json").notNull().default("{}"),
});

/** Slicer printer profiles imported from Bambu / OrcaSlicer / PrusaSlicer. */
export const printerProfiles = pgTable(
  "printer_profiles",
  {
    id: serial("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default(DEFAULT_TENANT_ID),
    name: text("name").notNull(),
    slicerFormat: text("slicer_format").notNull(),
    slicerVersionAtImport: text("slicer_version_at_import"),
    /** Polygon as JSON array of [x,y] pairs. */
    printableArea: text("printable_area"),
    printableHeightMm: text("printable_height_mm"),
    /** JSON array of exclusion polygons. */
    bedExcludeArea: text("bed_exclude_area"),
    nozzleDiameterMm: text("nozzle_diameter_mm"),
    extruderCount: integer("extruder_count").notNull().default(1),
    /** Verbatim source JSON (Bambu/Orca). */
    rawJson: text("raw_json"),
    /** Verbatim source INI (Prusa). */
    rawIni: text("raw_ini"),
    /** Merged, inheritance-resolved flat config as JSON. */
    resolvedFlatConfig: text("resolved_flat_config"),
    importedAt: text("imported_at").notNull(),
    /** Absolute path inside the container of the slicer-written source file (profile-sync watcher only). */
    sourcePath: text("source_path"),
    /** Slicer version string read from the slicer's own config at sync time, e.g. "2.3.2.60". */
    syncedFromSlicerVersion: text("synced_from_slicer_version"),
    /** ISO timestamp of the most recent profile-sync watcher upsert for this row. */
    lastSyncedAt: text("last_synced_at"),
  },
  (t) => [uniqueIndex("uq_printer_profiles_tenant_name").on(t.tenantId, t.name)],
);

/** Slicer process/print-settings profiles imported from slicers. */
export const processProfiles = pgTable(
  "process_profiles",
  {
    id: serial("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default(DEFAULT_TENANT_ID),
    name: text("name").notNull(),
    slicerFormat: text("slicer_format").notNull(),
    /** JSON array of printer profile names this process is compatible with. */
    compatiblePrinters: text("compatible_printers"),
    /** Merged, inheritance-resolved flat config as JSON. */
    resolvedFlatConfig: text("resolved_flat_config"),
    importedAt: text("imported_at").notNull(),
    sourcePath: text("source_path"),
    syncedFromSlicerVersion: text("synced_from_slicer_version"),
    lastSyncedAt: text("last_synced_at"),
  },
  (t) => [uniqueIndex("uq_process_profiles_tenant_name").on(t.tenantId, t.name)],
);

/** Slicer filament profiles imported from slicers. */
export const filamentProfiles = pgTable(
  "filament_profiles",
  {
    id: serial("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default(DEFAULT_TENANT_ID),
    name: text("name").notNull(),
    materialType: text("material_type").notNull(),
    /** 1=generic 2=brand 3=certified 4=optimal — aligns with PP material_tier scale. */
    materialTier: integer("material_tier").notNull().default(1),
    nozzleTempC: integer("nozzle_temp_c"),
    bedTempC: integer("bed_temp_c"),
    fanPct: integer("fan_pct"),
    extrusionMultiplier: text("extrusion_multiplier"),
    pressureAdvance: text("pressure_advance"),
    retraction: text("retraction"),
    /** Verbatim source JSON. */
    rawJson: text("raw_json"),
    /** Verbatim source INI. */
    rawIni: text("raw_ini"),
    /** Merged, inheritance-resolved flat config as JSON. */
    resolvedFlatConfig: text("resolved_flat_config"),
    importedAt: text("imported_at").notNull(),
    sourcePath: text("source_path"),
    syncedFromSlicerVersion: text("synced_from_slicer_version"),
    lastSyncedAt: text("last_synced_at"),
  },
  (t) => [uniqueIndex("uq_filament_profiles_tenant_name").on(t.tenantId, t.name)],
);

/** Global persistent mapping from slicer printer name to PP fleet printer id. */
export const printerNameMap = pgTable(
  "printer_name_map",
  {
    id: serial("id").primaryKey(),
    /** Exact printer name string as it appears in the slicer profile. */
    slicerName: text("slicer_name").notNull(),
    /** PP fleet printer id. */
    ppFleetId: text("pp_fleet_id").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("uq_printer_name_map_slicer_name").on(t.slicerName)],
);

export const printerProfileAssignments = pgTable("printer_profile_assignments", {
  printerId: text("printer_id").primaryKey(),
  tenantId: text("tenant_id").notNull().default(DEFAULT_TENANT_ID),
  machineProfileId: integer("machine_profile_id"),
  profileSource: text("profile_source").notNull().default("auto_match"),
  updatedAt: text("updated_at").notNull(),
});

export const printerFilamentSlotAssignments = pgTable(
  "printer_filament_slot_assignments",
  {
    id: serial("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default(DEFAULT_TENANT_ID),
    printerId: text("printer_id").notNull(),
    slotIndex: integer("slot_index").notNull(),
    filamentProfileId: integer("filament_profile_id"),
  },
  (t) => [
    uniqueIndex("uq_printer_filament_slot").on(t.tenantId, t.printerId, t.slotIndex),
  ],
);

/** Registered slicer GUI / sync targets (Slicer Hub). Docker fields reserved for Plan 3. */
export const slicerInstances = pgTable("slicer_instances", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().default(DEFAULT_TENANT_ID),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  dialect: text("dialect").notNull(),
  guiUrl: text("gui_url").notNull().default(""),
  watchPath: text("watch_path").notNull().default(""),
  dockerTarget: text("docker_target").notNull().default("local"),
  dockerHost: text("docker_host"),
  composeService: text("compose_service"),
  image: text("image"),
  containerName: text("container_name"),
  portsJson: text("ports_json").notNull().default("[]"),
  volumesJson: text("volumes_json").notNull().default("[]"),
  envJson: text("env_json").notNull().default("{}"),
  statusCache: text("status_cache").notNull().default("unknown"),
  statusMessage: text("status_message"),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** One print job container (keyed by checkoff link when available). */
export const printJobs = pgTable("print_jobs", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().default(DEFAULT_TENANT_ID),
  profileId: integer("profile_id")
    .notNull()
    .references(() => buildProfiles.id, { onDelete: "cascade" }),
  hostIntegrationId: text("host_integration_id"),
  /** PP fleet printer id (from checkoff link or send queue). */
  printerId: text("printer_id").notNull().default(""),
  /** Filament colour/material label (filament_color_id or filament_display). */
  material: text("material").notNull().default(""),
  filename: text("filename"),
  /** sent | completed | failed */
  status: text("status").notNull().default("sent"),
  /** Estimated filament consumed in grams (from telemetry or slicer metadata). */
  filamentConsumedG: integer("filament_consumed_g"),
  at: text("at").notNull(),
  completedAt: text("completed_at"),
  linkId: text("link_id"),
});

/** One outcome row per part/unit within a print job (replaces printer.print_outcomes blob). */
export const printJobParts = pgTable("print_job_parts", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().default(DEFAULT_TENANT_ID),
  jobId: text("job_id").references(() => printJobs.id, { onDelete: "set null" }),
  at: text("at").notNull(),
  profileId: integer("profile_id").notNull(),
  partId: integer("part_id").notNull(),
  unitIndex: integer("unit_index").notNull().default(0),
  result: text("result").notNull(),
  reason: text("reason"),
  note: text("note"),
  hostIntegrationId: text("host_integration_id"),
  filename: text("filename"),
  matchKey: text("match_key"),
  role: text("role"),
  filamentDisplay: text("filament_display"),
  linkId: text("link_id"),
});

/** Printer health / telemetry events (for Prometheus metrics and the stats page). */
export const printerTelemetry = pgTable("printer_telemetry", {
  id: serial("id").primaryKey(),
  tenantId: text("tenant_id").notNull().default(DEFAULT_TENANT_ID),
  at: text("at").notNull(),
  printerId: text("printer_id"),
  hostIntegrationId: text("host_integration_id"),
  eventType: text("event_type").notNull(),
  payloadJson: text("payload_json"),
});

/** General application event log (Discord daily digest, analytics). */
export const appEvents = pgTable("app_events", {
  id: serial("id").primaryKey(),
  tenantId: text("tenant_id").notNull().default(DEFAULT_TENANT_ID),
  at: text("at").notNull(),
  kind: text("kind").notNull(),
  actorType: text("actor_type"),
  actorId: text("actor_id"),
  payloadJson: text("payload_json"),
});

export const schemaVersionKey = "schema_version";
export const currentSchemaVersion = 30;
