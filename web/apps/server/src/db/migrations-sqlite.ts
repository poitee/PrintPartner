export const SQLITE_PARTS_INVALIDATE_ACCEPTED_REVISION_UPDATE = `CREATE TRIGGER IF NOT EXISTS trg_parts_invalidate_accepted_revision_update
    AFTER UPDATE ON parts
    WHEN OLD.id IS NOT NEW.id
      OR OLD.tenant_id IS NOT NEW.tenant_id
      OR OLD.profile_id IS NOT NEW.profile_id
      OR OLD.match_key IS NOT NEW.match_key
      OR OLD.relative_path IS NOT NEW.relative_path
      OR OLD.filename IS NOT NEW.filename
      OR OLD.source_layer IS NOT NEW.source_layer
      OR OLD.status IS NOT NEW.status
      OR OLD.role IS NOT NEW.role
      OR OLD.quantity_auto IS NOT NEW.quantity_auto
      OR OLD.quantity_override IS NOT NEW.quantity_override
      OR OLD.quantity_effective IS NOT NEW.quantity_effective
      OR OLD.included IS NOT NEW.included
      OR OLD.notes IS NOT NEW.notes
      OR OLD.github_blob_url IS NOT NEW.github_blob_url
      OR OLD.geometry_same IS NOT NEW.geometry_same
      OR OLD.requirement IS NOT NEW.requirement
      OR OLD.option_group_id IS NOT NEW.option_group_id
      OR OLD.manifest_source IS NOT NEW.manifest_source
    BEGIN
      UPDATE build_profiles
         SET accepted_plan_revision_id = NULL
       WHERE (id = OLD.profile_id AND tenant_id = OLD.tenant_id)
          OR (id = NEW.profile_id AND tenant_id = NEW.tenant_id);
    END`;

export const schemaMigrations: string[] = [
  `CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    source_type TEXT NOT NULL DEFAULT 'git',
    branch TEXT NOT NULL DEFAULT 'main',
    tag TEXT,
    local_path TEXT,
    last_synced_at TEXT,
    last_commit_sha TEXT,
    docs_url TEXT,
    imported_paths TEXT,
    manifest_community_slug TEXT,
    source_kind TEXT NOT NULL DEFAULT 'github',
    role TEXT NOT NULL DEFAULT 'unassigned',
    metadata_json TEXT,
    legacy_manifest_cutover INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_tenant_name ON projects (tenant_id, name)`,
  `CREATE TABLE IF NOT EXISTS build_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    name TEXT NOT NULL,
    order_number TEXT,
    special_request TEXT,
    config_modified_at TEXT,
    last_recomputed_at TEXT,
    archived_at TEXT,
    last_used_at TEXT,
    accepted_plan_revision_id INTEGER REFERENCES plan_revisions(id) ON DELETE SET NULL,
    accepted_plan_version INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_profiles_tenant_name ON build_profiles (tenant_id, name)`,
  `CREATE TABLE IF NOT EXISTS profile_layers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    profile_id INTEGER NOT NULL REFERENCES build_profiles(id) ON DELETE CASCADE,
    layer_order INTEGER NOT NULL DEFAULT 0,
    layer_type TEXT NOT NULL,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL
  )`,
  `CREATE TABLE IF NOT EXISTS parts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    profile_id INTEGER NOT NULL REFERENCES build_profiles(id) ON DELETE CASCADE,
    match_key TEXT NOT NULL,
    relative_path TEXT NOT NULL DEFAULT '',
    filename TEXT NOT NULL DEFAULT '',
    source_layer TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'base',
    role TEXT NOT NULL DEFAULT 'primary',
    filament_color_id TEXT,
    filament_custom_hex TEXT,
    quantity_auto INTEGER NOT NULL DEFAULT 1,
    quantity_override INTEGER,
    quantity_effective INTEGER NOT NULL DEFAULT 1,
    included INTEGER NOT NULL DEFAULT 1,
    notes TEXT NOT NULL DEFAULT '',
    github_blob_url TEXT,
    geometry_same INTEGER,
    requirement TEXT,
    option_group_id TEXT,
    manifest_source TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS print_progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    part_id INTEGER NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
    unit_index INTEGER NOT NULL DEFAULT 0,
    completed INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_print_progress_part_unit ON print_progress (part_id, unit_index)`,
  `CREATE TABLE IF NOT EXISTS app_settings (
    tenant_id TEXT NOT NULL DEFAULT 'default',
    key TEXT NOT NULL,
    value TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_app_settings_tenant_key ON app_settings (tenant_id, key)`,
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS auth_identities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    provider_user_id TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_auth_identity_provider ON auth_identities (provider, provider_user_id)`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS plan_shares (
    id TEXT PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
    from_user_id TEXT NOT NULL REFERENCES users(id),
    plan_id INTEGER NOT NULL,
    plan_name TEXT NOT NULL,
    recipient_email TEXT,
    bundle_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS source_docs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    kind TEXT NOT NULL,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT,
    extract_status TEXT NOT NULL DEFAULT 'pending',
    extract_error TEXT,
    page_count INTEGER,
    updated_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_source_docs_project_path ON source_docs (project_id, path)`,
  `CREATE TABLE IF NOT EXISTS source_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    profile_id INTEGER REFERENCES build_profiles(id) ON DELETE SET NULL,
    title TEXT NOT NULL DEFAULT '',
    body_markdown TEXT NOT NULL DEFAULT '',
    author_user_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS plan_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    profile_id INTEGER NOT NULL REFERENCES build_profiles(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    actor TEXT NOT NULL DEFAULT 'assistant',
    kind TEXT NOT NULL,
    action_type TEXT,
    params_json TEXT NOT NULL DEFAULT '{}',
    label TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    rationale TEXT,
    result_json TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_plan_decisions_profile ON plan_decisions (profile_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS plan_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    profile_id INTEGER NOT NULL REFERENCES build_profiles(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'user',
    payload_json TEXT NOT NULL DEFAULT '{}'
  )`,
  `CREATE INDEX IF NOT EXISTS idx_plan_snapshots_profile ON plan_snapshots (profile_id, created_at)`,
  // v9 — slicer profile tables
  `CREATE TABLE IF NOT EXISTS printer_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    name TEXT NOT NULL,
    slicer_format TEXT NOT NULL,
    slicer_version_at_import TEXT,
    printable_area TEXT,
    printable_height_mm TEXT,
    bed_exclude_area TEXT,
    nozzle_diameter_mm TEXT,
    extruder_count INTEGER NOT NULL DEFAULT 1,
    raw_json TEXT,
    raw_ini TEXT,
    resolved_flat_config TEXT,
    imported_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_printer_profiles_tenant_name ON printer_profiles (tenant_id, name)`,
  `CREATE TABLE IF NOT EXISTS process_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    name TEXT NOT NULL,
    slicer_format TEXT NOT NULL,
    compatible_printers TEXT,
    resolved_flat_config TEXT,
    imported_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_process_profiles_tenant_name ON process_profiles (tenant_id, name)`,
  `CREATE TABLE IF NOT EXISTS filament_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    name TEXT NOT NULL,
    material_type TEXT NOT NULL,
    material_tier INTEGER NOT NULL DEFAULT 1,
    nozzle_temp_c INTEGER,
    bed_temp_c INTEGER,
    fan_pct INTEGER,
    extrusion_multiplier TEXT,
    pressure_advance TEXT,
    retraction TEXT,
    raw_json TEXT,
    raw_ini TEXT,
    resolved_flat_config TEXT,
    imported_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_filament_profiles_tenant_name ON filament_profiles (tenant_id, name)`,
  `CREATE TABLE IF NOT EXISTS printer_name_map (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slicer_name TEXT NOT NULL,
    pp_fleet_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_printer_name_map_slicer_name ON printer_name_map (slicer_name)`,
  // v10 — assembly tracking column on print_progress.
  // NOTE: intentionally NOT an unconditional ALTER TABLE here (that fails with
  // "duplicate column name" on every restart once applied once). The guarded
  // add-if-missing logic for this column lives in db/client.ts runMigrations(),
  // alongside the other conditional column migrations.
  // v11 — print_jobs, print_job_parts, printer_telemetry, app_events
  `CREATE TABLE IF NOT EXISTS print_jobs (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    profile_id INTEGER NOT NULL REFERENCES build_profiles(id) ON DELETE CASCADE,
    host_integration_id TEXT,
    filename TEXT,
    at TEXT NOT NULL,
    link_id TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_print_jobs_tenant_profile ON print_jobs (tenant_id, profile_id, at)`,
  `CREATE TABLE IF NOT EXISTS print_job_parts (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    job_id TEXT REFERENCES print_jobs(id) ON DELETE SET NULL,
    at TEXT NOT NULL,
    profile_id INTEGER NOT NULL,
    part_id INTEGER NOT NULL,
    unit_index INTEGER NOT NULL DEFAULT 0,
    result TEXT NOT NULL,
    reason TEXT,
    note TEXT,
    host_integration_id TEXT,
    filename TEXT,
    match_key TEXT,
    role TEXT,
    filament_display TEXT,
    link_id TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_print_job_parts_profile ON print_job_parts (profile_id, at)`,
  `CREATE TABLE IF NOT EXISTS printer_telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    at TEXT NOT NULL,
    printer_id TEXT,
    host_integration_id TEXT,
    event_type TEXT NOT NULL,
    payload_json TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_printer_telemetry_at ON printer_telemetry (tenant_id, at)`,
  `CREATE TABLE IF NOT EXISTS app_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    actor_type TEXT,
    actor_id TEXT,
    payload_json TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_app_events_kind_at ON app_events (tenant_id, kind, at)`,
  // v12 — add printer_id / material / status / filament_consumed_g / completed_at to print_jobs
  `ALTER TABLE print_jobs ADD COLUMN printer_id TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE print_jobs ADD COLUMN material TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE print_jobs ADD COLUMN status TEXT NOT NULL DEFAULT 'sent'`,
  `ALTER TABLE print_jobs ADD COLUMN filament_consumed_g INTEGER`,
  `ALTER TABLE print_jobs ADD COLUMN completed_at TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_print_jobs_tenant_status ON print_jobs (tenant_id, status)`,
  // v13 — profile-sync provenance columns on the three slicer profile tables.
  // Populated by the chokidar-based profile-sync watcher (services/profile-sync.ts)
  // when a profile file changes on disk in the shared slicer config volumes.
  // NULL on rows that were manually imported or PP-native starters (never synced).
  `ALTER TABLE printer_profiles ADD COLUMN source_path TEXT`,
  `ALTER TABLE printer_profiles ADD COLUMN synced_from_slicer_version TEXT`,
  `ALTER TABLE printer_profiles ADD COLUMN last_synced_at TEXT`,
  `ALTER TABLE process_profiles ADD COLUMN source_path TEXT`,
  `ALTER TABLE process_profiles ADD COLUMN synced_from_slicer_version TEXT`,
  `ALTER TABLE process_profiles ADD COLUMN last_synced_at TEXT`,
  `ALTER TABLE filament_profiles ADD COLUMN source_path TEXT`,
  `ALTER TABLE filament_profiles ADD COLUMN synced_from_slicer_version TEXT`,
  `ALTER TABLE filament_profiles ADD COLUMN last_synced_at TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_printer_profiles_source_path ON printer_profiles (source_path)`,
  `CREATE INDEX IF NOT EXISTS idx_process_profiles_source_path ON process_profiles (source_path)`,
  `CREATE INDEX IF NOT EXISTS idx_filament_profiles_source_path ON filament_profiles (source_path)`,
  `CREATE INDEX IF NOT EXISTS idx_print_jobs_printer ON print_jobs (tenant_id, printer_id)`,
  // v14 — per-printer machine profile and per-slot filament assignments.
  `CREATE TABLE IF NOT EXISTS printer_profile_assignments (
    printer_id TEXT PRIMARY KEY NOT NULL,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    machine_profile_id INTEGER,
    profile_source TEXT NOT NULL DEFAULT 'auto_match',
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS printer_filament_slot_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    printer_id TEXT NOT NULL,
    slot_index INTEGER NOT NULL,
    filament_profile_id INTEGER
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_printer_filament_slot
    ON printer_filament_slot_assignments (tenant_id, printer_id, slot_index)`,
  // v15 — registered slicer GUI / sync targets (Slicer Hub). Docker columns reserved for Plan 3.
  `CREATE TABLE IF NOT EXISTS slicer_instances (
    id TEXT PRIMARY KEY NOT NULL,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    dialect TEXT NOT NULL,
    gui_url TEXT NOT NULL DEFAULT '',
    watch_path TEXT NOT NULL DEFAULT '',
    docker_target TEXT NOT NULL DEFAULT 'local',
    docker_host TEXT,
    compose_service TEXT,
    image TEXT,
    container_name TEXT,
    ports_json TEXT NOT NULL DEFAULT '[]',
    volumes_json TEXT NOT NULL DEFAULT '[]',
    env_json TEXT NOT NULL DEFAULT '{}',
    status_cache TEXT NOT NULL DEFAULT 'unknown',
    status_message TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  // v16 — immutable Source revision identities and atomically published Plan inputs.
  `CREATE TABLE IF NOT EXISTS source_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    upstream_revision_key TEXT NOT NULL,
    manifest_digest TEXT NOT NULL,
    snapshot_locator TEXT NOT NULL,
    synced_at TEXT NOT NULL,
    completeness TEXT NOT NULL DEFAULT 'complete' CHECK (completeness = 'complete')
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_source_revisions_tenant_source_upstream
    ON source_revisions (tenant_id, project_id, upstream_revision_key)`,
  `CREATE INDEX IF NOT EXISTS idx_source_revisions_tenant_source_synced
    ON source_revisions (tenant_id, project_id, synced_at)`,
  // v17 — active Source pointer to one registered immutable revision.
  `ALTER TABLE projects ADD COLUMN current_source_revision_id INTEGER
    REFERENCES source_revisions(id) ON DELETE RESTRICT`,
  `CREATE TABLE IF NOT EXISTS plan_revision_input_sets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    profile_id INTEGER NOT NULL REFERENCES build_profiles(id) ON DELETE CASCADE,
    input_set_digest TEXT NOT NULL,
    expected_input_count INTEGER NOT NULL,
    recorded_at TEXT NOT NULL,
    published_at TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_revision_input_sets_tenant_plan_digest
    ON plan_revision_input_sets (tenant_id, profile_id, input_set_digest)`,
  `CREATE INDEX IF NOT EXISTS idx_plan_revision_input_sets_tenant_plan_published
    ON plan_revision_input_sets (tenant_id, profile_id, published_at)`,
  `CREATE TABLE IF NOT EXISTS plan_revision_inputs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    input_set_id INTEGER NOT NULL REFERENCES plan_revision_input_sets(id) ON DELETE CASCADE,
    source_revision_id INTEGER NOT NULL REFERENCES source_revisions(id) ON DELETE RESTRICT,
    manifest_digest TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_plan_revision_inputs_tenant_set
    ON plan_revision_inputs (tenant_id, input_set_id)`,
  // v18 — explicit accepted Plan input identity and effective naming inputs.
  `ALTER TABLE plan_revision_input_sets ADD COLUMN format_version INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE plan_revision_inputs ADD COLUMN source_id INTEGER REFERENCES projects(id) ON DELETE RESTRICT`,
  `ALTER TABLE plan_revision_inputs ADD COLUMN source_layer TEXT`,
  `ALTER TABLE plan_revision_inputs ADD COLUMN layer_order INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE plan_revision_inputs ADD COLUMN tracking_kind TEXT NOT NULL DEFAULT 'revision'`,
  `ALTER TABLE plan_revision_inputs ADD COLUMN effective_naming_digest TEXT`,
  `UPDATE plan_revision_inputs
     SET source_id = (SELECT project_id FROM source_revisions WHERE source_revisions.id = plan_revision_inputs.source_revision_id),
         source_layer = 'legacy:' || COALESCE((SELECT project_id FROM source_revisions WHERE source_revisions.id = plan_revision_inputs.source_revision_id), 0)
   WHERE source_id IS NULL OR source_layer IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_revision_inputs_v2_set_source
    ON plan_revision_inputs (input_set_id, source_id)
    WHERE effective_naming_digest IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS plan_accepted_input_sets (
    tenant_id TEXT NOT NULL DEFAULT 'default',
    profile_id INTEGER PRIMARY KEY REFERENCES build_profiles(id) ON DELETE CASCADE,
    input_set_id INTEGER NOT NULL REFERENCES plan_revision_input_sets(id) ON DELETE RESTRICT,
    accepted_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS plan_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    profile_id INTEGER NOT NULL REFERENCES build_profiles(id) ON DELETE CASCADE,
    revision_number INTEGER NOT NULL,
    parent_revision_id INTEGER REFERENCES plan_revisions(id) ON DELETE RESTRICT,
    input_set_id INTEGER REFERENCES plan_revision_input_sets(id) ON DELETE RESTRICT,
    provenance_kind TEXT NOT NULL,
    digest_format TEXT NOT NULL,
    snapshot_digest TEXT NOT NULL,
    created_by TEXT NOT NULL,
    accepted_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    accepted_at TEXT NOT NULL,
    CONSTRAINT chk_plan_revisions_provenance CHECK (
      (provenance_kind = 'tracked' AND input_set_id IS NOT NULL)
      OR (provenance_kind = 'legacy' AND input_set_id IS NULL)
    )
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_revisions_tenant_plan_number
    ON plan_revisions (tenant_id, profile_id, revision_number)`,
  `CREATE INDEX IF NOT EXISTS idx_plan_revisions_tenant_plan
    ON plan_revisions (tenant_id, profile_id, accepted_at)`,
  `CREATE TABLE IF NOT EXISTS plan_revision_parts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    revision_id INTEGER NOT NULL REFERENCES plan_revisions(id) ON DELETE CASCADE,
    projection_part_id INTEGER,
    part_key TEXT NOT NULL,
    relative_path TEXT NOT NULL DEFAULT '',
    filename TEXT NOT NULL DEFAULT '',
    source_layer TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'base',
    role_inferred TEXT NOT NULL DEFAULT 'primary',
    role_override TEXT,
    filament_color_id TEXT,
    filament_custom_hex TEXT,
    spoolman_spool_id TEXT,
    quantity_inferred INTEGER NOT NULL DEFAULT 1,
    quantity_override INTEGER,
    quantity_effective INTEGER NOT NULL DEFAULT 1,
    included INTEGER NOT NULL DEFAULT 1,
    notes TEXT NOT NULL DEFAULT '',
    github_blob_url TEXT,
    geometry_same INTEGER,
    requirement TEXT,
    option_group_id TEXT,
    manifest_source TEXT,
    artifact_digest TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_plan_revision_parts_tenant_revision
    ON plan_revision_parts (tenant_id, revision_id)`,
  `CREATE TRIGGER IF NOT EXISTS trg_plan_revisions_ownership_insert
    BEFORE INSERT ON plan_revisions
    WHEN NOT EXISTS (
      SELECT 1 FROM build_profiles profile
       WHERE profile.id = NEW.profile_id AND profile.tenant_id = NEW.tenant_id
    ) OR (
      NEW.parent_revision_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM plan_revisions parent
         WHERE parent.id = NEW.parent_revision_id
           AND parent.profile_id = NEW.profile_id
           AND parent.tenant_id = NEW.tenant_id
      )
    ) OR (
      NEW.input_set_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM plan_revision_input_sets input_set
         WHERE input_set.id = NEW.input_set_id
           AND input_set.profile_id = NEW.profile_id
           AND input_set.tenant_id = NEW.tenant_id
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'Plan revision ownership violation');
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_plan_revision_parts_ownership_insert
    BEFORE INSERT ON plan_revision_parts
    WHEN NOT EXISTS (
      SELECT 1 FROM plan_revisions revision
       WHERE revision.id = NEW.revision_id AND revision.tenant_id = NEW.tenant_id
    ) OR (
      NEW.projection_part_id IS NOT NULL AND NOT EXISTS (
        SELECT 1
          FROM parts part
          JOIN plan_revisions revision ON revision.id = NEW.revision_id
         WHERE part.id = NEW.projection_part_id
           AND part.tenant_id = NEW.tenant_id
           AND part.profile_id = revision.profile_id
           AND revision.tenant_id = NEW.tenant_id
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'Plan revision Part ownership violation');
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_plan_revisions_immutable_update
    BEFORE UPDATE ON plan_revisions
    BEGIN
      SELECT RAISE(ABORT, 'Accepted Plan revisions are immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_plan_revisions_immutable_delete
    BEFORE DELETE ON plan_revisions
    WHEN EXISTS (
      SELECT 1 FROM build_profiles profile
       WHERE profile.id = OLD.profile_id AND profile.tenant_id = OLD.tenant_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'Accepted Plan revisions are immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_plan_revision_parts_immutable_update
    BEFORE UPDATE ON plan_revision_parts
    BEGIN
      SELECT RAISE(ABORT, 'Accepted Plan revision Parts are immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_plan_revision_parts_immutable_delete
    BEFORE DELETE ON plan_revision_parts
    WHEN EXISTS (
      SELECT 1
        FROM plan_revisions revision
        JOIN build_profiles profile
          ON profile.id = revision.profile_id
         AND profile.tenant_id = revision.tenant_id
       WHERE revision.id = OLD.revision_id
         AND revision.tenant_id = OLD.tenant_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'Accepted Plan revision Parts are immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_parts_invalidate_accepted_revision_insert
    AFTER INSERT ON parts
    BEGIN
      UPDATE build_profiles
         SET accepted_plan_revision_id = NULL
       WHERE id = NEW.profile_id AND tenant_id = NEW.tenant_id;
    END`,
  SQLITE_PARTS_INVALIDATE_ACCEPTED_REVISION_UPDATE,
  `CREATE TRIGGER IF NOT EXISTS trg_parts_invalidate_accepted_revision_delete
    AFTER DELETE ON parts
    BEGIN
      UPDATE build_profiles
         SET accepted_plan_revision_id = NULL
       WHERE id = OLD.profile_id AND tenant_id = OLD.tenant_id;
    END`,
  `CREATE TABLE IF NOT EXISTS plan_drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    profile_id INTEGER NOT NULL REFERENCES build_profiles(id) ON DELETE CASCADE,
    base_revision_id INTEGER REFERENCES plan_revisions(id) ON DELETE RESTRICT,
    base_plan_version INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('open', 'abandoned', 'consumed')),
    lifecycle_version INTEGER NOT NULL DEFAULT 0
      CHECK (lifecycle_version >= 0 AND lifecycle_version <= 2147483647),
    rebased_from_draft_id INTEGER REFERENCES plan_drafts(id) ON DELETE CASCADE,
    rebased_from_lifecycle_version INTEGER,
    rebased_from_snapshot_digest TEXT,
    digest_format TEXT NOT NULL,
    snapshot_digest TEXT NOT NULL,
    created_by TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    CHECK (
      (base_revision_id IS NULL AND base_plan_version = 0)
      OR (base_revision_id IS NOT NULL AND base_plan_version > 0)
    ),
    CHECK (
      (rebased_from_draft_id IS NULL
        AND rebased_from_lifecycle_version IS NULL
        AND rebased_from_snapshot_digest IS NULL)
      OR (rebased_from_draft_id IS NOT NULL
        AND rebased_from_lifecycle_version IS NOT NULL
        AND rebased_from_snapshot_digest IS NOT NULL
        AND rebased_from_lifecycle_version >= 0
        AND rebased_from_lifecycle_version <= 2147483647)
    )
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_drafts_tenant_actor_profile_key
    ON plan_drafts (tenant_id, created_by, profile_id, idempotency_key)`,
  `CREATE INDEX IF NOT EXISTS idx_plan_drafts_tenant_profile_created
    ON plan_drafts (tenant_id, profile_id, created_at, id)`,
  `ALTER TABLE plan_drafts ADD COLUMN lifecycle_version INTEGER NOT NULL DEFAULT 0
    CHECK (lifecycle_version >= 0 AND lifecycle_version <= 2147483647)`,
  `ALTER TABLE plan_drafts ADD COLUMN rebased_from_draft_id INTEGER
    REFERENCES plan_drafts(id) ON DELETE CASCADE`,
  `ALTER TABLE plan_drafts ADD COLUMN rebased_from_lifecycle_version INTEGER`,
  `ALTER TABLE plan_drafts ADD COLUMN rebased_from_snapshot_digest TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_drafts_tenant_profile_rebase_source_generation
    ON plan_drafts (
      tenant_id, profile_id, rebased_from_draft_id, rebased_from_lifecycle_version
    ) WHERE rebased_from_draft_id IS NOT NULL`,
  `CREATE TRIGGER IF NOT EXISTS trg_plan_drafts_lineage_insert
    BEFORE INSERT ON plan_drafts
    WHEN (
      (NEW.rebased_from_draft_id IS NULL
        OR NEW.rebased_from_lifecycle_version IS NULL
        OR NEW.rebased_from_snapshot_digest IS NULL)
      AND NOT (
        NEW.rebased_from_draft_id IS NULL
        AND NEW.rebased_from_lifecycle_version IS NULL
        AND NEW.rebased_from_snapshot_digest IS NULL
      )
    ) OR (
      NEW.rebased_from_draft_id IS NOT NULL
      AND (
        NEW.rebased_from_lifecycle_version < 0
        OR NEW.rebased_from_lifecycle_version > 2147483647
        OR NOT EXISTS (
          SELECT 1 FROM plan_drafts source
           WHERE source.id = NEW.rebased_from_draft_id
             AND source.tenant_id = NEW.tenant_id
             AND source.profile_id = NEW.profile_id
             AND source.state = 'abandoned'
             AND source.lifecycle_version = NEW.rebased_from_lifecycle_version
             AND source.snapshot_digest = NEW.rebased_from_snapshot_digest
        )
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'Plan draft rebase lineage violation');
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_plan_drafts_lineage_update
    BEFORE UPDATE OF rebased_from_draft_id, rebased_from_lifecycle_version,
      rebased_from_snapshot_digest ON plan_drafts
    WHEN (
      (NEW.rebased_from_draft_id IS NULL
        OR NEW.rebased_from_lifecycle_version IS NULL
        OR NEW.rebased_from_snapshot_digest IS NULL)
      AND NOT (
        NEW.rebased_from_draft_id IS NULL
        AND NEW.rebased_from_lifecycle_version IS NULL
        AND NEW.rebased_from_snapshot_digest IS NULL
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'Plan draft rebase lineage violation');
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_plan_drafts_lineage_immutable
    BEFORE UPDATE OF rebased_from_draft_id, rebased_from_lifecycle_version,
      rebased_from_snapshot_digest ON plan_drafts
    WHEN NEW.rebased_from_draft_id IS NOT OLD.rebased_from_draft_id
      OR NEW.rebased_from_lifecycle_version IS NOT OLD.rebased_from_lifecycle_version
      OR NEW.rebased_from_snapshot_digest IS NOT OLD.rebased_from_snapshot_digest
    BEGIN
      SELECT RAISE(ABORT, 'Plan draft rebase lineage is immutable');
    END`,
  `CREATE TABLE IF NOT EXISTS plan_draft_inputs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    draft_id INTEGER NOT NULL REFERENCES plan_drafts(id) ON DELETE CASCADE,
    source_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    source_layer TEXT NOT NULL,
    layer_order INTEGER NOT NULL,
    tracking_kind TEXT NOT NULL CHECK (tracking_kind IN ('revision', 'untracked')),
    source_revision_id INTEGER REFERENCES source_revisions(id) ON DELETE RESTRICT,
    manifest_digest TEXT,
    effective_naming_digest TEXT NOT NULL,
    CHECK (
      (tracking_kind = 'revision' AND source_revision_id IS NOT NULL AND manifest_digest IS NOT NULL)
      OR (tracking_kind = 'untracked' AND source_revision_id IS NULL AND manifest_digest IS NULL)
    )
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_draft_inputs_tenant_draft_source
    ON plan_draft_inputs (tenant_id, draft_id, source_id)`,
  `CREATE TABLE IF NOT EXISTS plan_draft_parts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    draft_id INTEGER NOT NULL REFERENCES plan_drafts(id) ON DELETE CASCADE,
    base_revision_part_id INTEGER REFERENCES plan_revision_parts(id) ON DELETE RESTRICT,
    part_key TEXT NOT NULL,
    relative_path TEXT NOT NULL DEFAULT '',
    filename TEXT NOT NULL DEFAULT '',
    source_layer TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'base',
    role_inferred TEXT NOT NULL DEFAULT 'primary',
    role_override TEXT,
    filament_color_id TEXT,
    filament_custom_hex TEXT,
    spoolman_spool_id TEXT,
    quantity_inferred INTEGER NOT NULL DEFAULT 1,
    quantity_override INTEGER,
    quantity_effective INTEGER NOT NULL DEFAULT 1,
    included INTEGER NOT NULL DEFAULT 1,
    notes TEXT NOT NULL DEFAULT '',
    github_blob_url TEXT,
    geometry_same INTEGER,
    requirement TEXT,
    option_group_id TEXT,
    manifest_source TEXT,
    artifact_digest TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_plan_draft_parts_tenant_draft
    ON plan_draft_parts (tenant_id, draft_id, id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_draft_parts_tenant_draft_predecessor
    ON plan_draft_parts (tenant_id, draft_id, base_revision_part_id)`,
  `CREATE TRIGGER IF NOT EXISTS trg_plan_drafts_ownership_insert
    BEFORE INSERT ON plan_drafts
    WHEN NOT EXISTS (
      SELECT 1 FROM build_profiles profile
       WHERE profile.id = NEW.profile_id AND profile.tenant_id = NEW.tenant_id
    ) OR (
      NEW.base_revision_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM plan_revisions revision
         WHERE revision.id = NEW.base_revision_id
           AND revision.profile_id = NEW.profile_id
           AND revision.tenant_id = NEW.tenant_id
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'Plan draft ownership violation');
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_plan_drafts_ownership_update
    BEFORE UPDATE ON plan_drafts
    WHEN EXISTS (
      SELECT 1 FROM build_profiles old_profile
       WHERE old_profile.id = OLD.profile_id AND old_profile.tenant_id = OLD.tenant_id
    ) AND (
      NOT EXISTS (
        SELECT 1 FROM build_profiles profile
         WHERE profile.id = NEW.profile_id AND profile.tenant_id = NEW.tenant_id
      ) OR (
        NEW.base_revision_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM plan_revisions revision
           WHERE revision.id = NEW.base_revision_id
             AND revision.profile_id = NEW.profile_id
             AND revision.tenant_id = NEW.tenant_id
        )
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'Plan draft ownership violation');
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_plan_drafts_identity_immutable
    BEFORE UPDATE OF tenant_id, profile_id, base_revision_id, base_plan_version ON plan_drafts
    WHEN NEW.tenant_id IS NOT OLD.tenant_id
      OR NEW.profile_id IS NOT OLD.profile_id
      OR NEW.base_revision_id IS NOT OLD.base_revision_id
      OR NEW.base_plan_version IS NOT OLD.base_plan_version
    BEGIN
      SELECT RAISE(ABORT, 'Plan draft identity is immutable');
    END`,
  `DROP TRIGGER IF EXISTS trg_plan_drafts_state_transition`,
  `CREATE TRIGGER trg_plan_drafts_state_transition
    BEFORE UPDATE OF state, lifecycle_version ON plan_drafts
    WHEN NOT (
      (NEW.state = OLD.state AND NEW.lifecycle_version = OLD.lifecycle_version)
      OR (
        NEW.lifecycle_version = OLD.lifecycle_version + 1
        AND (
          (OLD.state = 'open' AND NEW.state IN ('abandoned', 'consumed'))
          OR (OLD.state = 'abandoned' AND NEW.state = 'open')
        )
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'Invalid Plan draft state transition');
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_plan_draft_inputs_ownership_insert
    BEFORE INSERT ON plan_draft_inputs
    WHEN NOT EXISTS (
      SELECT 1 FROM plan_drafts draft
       WHERE draft.id = NEW.draft_id
         AND draft.tenant_id = NEW.tenant_id
         AND draft.state = 'open'
    ) OR NOT EXISTS (
      SELECT 1 FROM projects source
       WHERE source.id = NEW.source_id AND source.tenant_id = NEW.tenant_id
    ) OR (
      NEW.source_revision_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM source_revisions revision
         WHERE revision.id = NEW.source_revision_id
           AND revision.project_id = NEW.source_id
           AND revision.tenant_id = NEW.tenant_id
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'Plan draft input ownership requires an open parent');
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_plan_draft_inputs_ownership_update
    BEFORE UPDATE ON plan_draft_inputs
    WHEN NOT EXISTS (
      SELECT 1 FROM plan_drafts draft
       WHERE draft.id = NEW.draft_id
         AND draft.tenant_id = NEW.tenant_id
         AND draft.state = 'open'
    ) OR NOT EXISTS (
      SELECT 1 FROM projects source
       WHERE source.id = NEW.source_id AND source.tenant_id = NEW.tenant_id
    ) OR (
      NEW.source_revision_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM source_revisions revision
         WHERE revision.id = NEW.source_revision_id
           AND revision.project_id = NEW.source_id
           AND revision.tenant_id = NEW.tenant_id
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'Plan draft input ownership requires an open parent');
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_plan_draft_parts_ownership_insert
    BEFORE INSERT ON plan_draft_parts
    WHEN NOT EXISTS (
      SELECT 1 FROM plan_drafts draft
       WHERE draft.id = NEW.draft_id
         AND draft.tenant_id = NEW.tenant_id
         AND draft.state = 'open'
    ) OR (
      NEW.base_revision_part_id IS NOT NULL AND NOT EXISTS (
        SELECT 1
          FROM plan_revision_parts part
          JOIN plan_drafts draft ON draft.id = NEW.draft_id
         WHERE part.id = NEW.base_revision_part_id
           AND part.revision_id = draft.base_revision_id
           AND part.tenant_id = NEW.tenant_id
           AND draft.tenant_id = NEW.tenant_id
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'Plan draft Part ownership requires an open parent');
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_plan_draft_parts_ownership_update
    BEFORE UPDATE ON plan_draft_parts
    WHEN NOT EXISTS (
      SELECT 1 FROM plan_drafts draft
       WHERE draft.id = NEW.draft_id
         AND draft.tenant_id = NEW.tenant_id
         AND draft.state = 'open'
    ) OR (
      NEW.base_revision_part_id IS NOT NULL AND NOT EXISTS (
        SELECT 1
          FROM plan_revision_parts part
          JOIN plan_drafts draft ON draft.id = NEW.draft_id
         WHERE part.id = NEW.base_revision_part_id
           AND part.revision_id = draft.base_revision_id
           AND part.tenant_id = NEW.tenant_id
           AND draft.tenant_id = NEW.tenant_id
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'Plan draft Part ownership requires an open parent');
    END`,
  `CREATE TABLE IF NOT EXISTS required_units (
    token TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    profile_id INTEGER NOT NULL REFERENCES build_profiles(id) ON DELETE CASCADE,
    created_in_revision_id INTEGER NOT NULL REFERENCES plan_revisions(id) ON DELETE CASCADE,
    object_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    CHECK (
      length(token) = 36
      AND substr(token, 1, 4) = 'ppu_'
      AND substr(token, 5) NOT GLOB '*[^0-9a-f]*'
    ),
    CHECK (
      length(object_name) BETWEEN 1 AND 200
      AND substr(object_name, -(length(token) + 2)) = '__' || token
    )
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_required_units_object_name_ci
    ON required_units (lower(object_name))`,
  `CREATE TABLE IF NOT EXISTS plan_revision_required_unit_sets (
    revision_id INTEGER PRIMARY KEY REFERENCES plan_revisions(id) ON DELETE CASCADE,
    tenant_id TEXT NOT NULL,
    profile_id INTEGER NOT NULL REFERENCES build_profiles(id) ON DELETE CASCADE,
    format TEXT NOT NULL CHECK (format = 'required-unit-map-v1'),
    expected_unit_count INTEGER NOT NULL CHECK (expected_unit_count >= 0),
    mapping_digest TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS plan_revision_required_units (
    tenant_id TEXT NOT NULL,
    revision_id INTEGER NOT NULL REFERENCES plan_revisions(id) ON DELETE CASCADE,
    revision_part_id INTEGER NOT NULL REFERENCES plan_revision_parts(id) ON DELETE CASCADE,
    unit_index INTEGER NOT NULL CHECK (unit_index BETWEEN 0 AND 9999),
    required_unit_token TEXT NOT NULL REFERENCES required_units(token) ON DELETE CASCADE,
    PRIMARY KEY (tenant_id, revision_id, revision_part_id, unit_index),
    UNIQUE (tenant_id, revision_id, required_unit_token)
  )`,
  `CREATE TRIGGER IF NOT EXISTS trg_required_units_ownership_insert
    BEFORE INSERT ON required_units
    WHEN NOT EXISTS (
      SELECT 1
        FROM build_profiles profile
        JOIN plan_revisions revision
          ON revision.id = NEW.created_in_revision_id
         AND revision.profile_id = profile.id
         AND revision.tenant_id = profile.tenant_id
       WHERE profile.id = NEW.profile_id
         AND profile.tenant_id = NEW.tenant_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'Required unit ownership violation');
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_required_units_immutable_update
    BEFORE UPDATE ON required_units
    BEGIN
      SELECT RAISE(ABORT, 'Required unit is immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_required_units_immutable_delete
    BEFORE DELETE ON required_units
    WHEN EXISTS (
      SELECT 1 FROM build_profiles profile
       WHERE profile.id = OLD.profile_id AND profile.tenant_id = OLD.tenant_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'Required unit is immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_plan_revision_required_units_ownership_insert
    BEFORE INSERT ON plan_revision_required_units
    WHEN EXISTS (
      SELECT 1 FROM plan_revision_required_unit_sets set_header
       WHERE set_header.revision_id = NEW.revision_id
    ) OR NOT EXISTS (
      SELECT 1
        FROM plan_revisions revision
        JOIN plan_revision_parts part
          ON part.id = NEW.revision_part_id
         AND part.revision_id = revision.id
         AND part.tenant_id = revision.tenant_id
        JOIN required_units unit
          ON unit.token = NEW.required_unit_token
         AND unit.profile_id = revision.profile_id
         AND unit.tenant_id = revision.tenant_id
       WHERE revision.id = NEW.revision_id
         AND revision.tenant_id = NEW.tenant_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'Required-unit mapping ownership violation');
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_plan_revision_required_units_immutable_update
    BEFORE UPDATE ON plan_revision_required_units
    BEGIN
      SELECT RAISE(ABORT, 'Required-unit mapping is immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_plan_revision_required_units_immutable_delete
    BEFORE DELETE ON plan_revision_required_units
    WHEN EXISTS (
      SELECT 1
        FROM plan_revisions revision
        JOIN build_profiles profile
          ON profile.id = revision.profile_id
         AND profile.tenant_id = revision.tenant_id
       WHERE revision.id = OLD.revision_id
         AND revision.tenant_id = OLD.tenant_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'Required-unit mapping is immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_plan_revision_required_unit_sets_ownership_insert
    BEFORE INSERT ON plan_revision_required_unit_sets
    WHEN NOT EXISTS (
      SELECT 1 FROM plan_revisions revision
       WHERE revision.id = NEW.revision_id
         AND revision.profile_id = NEW.profile_id
         AND revision.tenant_id = NEW.tenant_id
    ) OR NEW.expected_unit_count <> (
      SELECT count(*) FROM plan_revision_required_units mapping
       WHERE mapping.tenant_id = NEW.tenant_id
         AND mapping.revision_id = NEW.revision_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'Required-unit set ownership or count violation');
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_plan_revision_required_unit_sets_immutable_update
    BEFORE UPDATE ON plan_revision_required_unit_sets
    BEGIN
      SELECT RAISE(ABORT, 'Required-unit set is immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_plan_revision_required_unit_sets_immutable_delete
    BEFORE DELETE ON plan_revision_required_unit_sets
    WHEN EXISTS (
      SELECT 1
        FROM plan_revisions revision
        JOIN build_profiles profile
          ON profile.id = revision.profile_id
         AND profile.tenant_id = revision.tenant_id
       WHERE revision.id = OLD.revision_id
         AND revision.tenant_id = OLD.tenant_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'Required-unit set is immutable');
    END`,
  `CREATE TABLE IF NOT EXISTS plan_draft_required_unit_reconciliations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    profile_id INTEGER NOT NULL REFERENCES build_profiles(id) ON DELETE CASCADE,
    draft_id INTEGER NOT NULL REFERENCES plan_drafts(id) ON DELETE CASCADE,
    format TEXT NOT NULL CHECK (format = 'required-unit-reconciliation-v1'),
    planning_digest TEXT NOT NULL,
    base_revision_id INTEGER REFERENCES plan_revisions(id) ON DELETE RESTRICT,
    base_mapping_digest TEXT,
    selection_basis_digest TEXT NOT NULL,
    selection_basis_json TEXT NOT NULL
      CHECK (json_valid(selection_basis_json) AND json_type(selection_basis_json) = 'array'),
    decision_digest TEXT NOT NULL,
    result_kind TEXT NOT NULL CHECK (result_kind IN ('unresolved', 'ready')),
    result_digest TEXT NOT NULL,
    result_json TEXT NOT NULL
      CHECK (json_valid(result_json) AND json_type(result_json) = 'object'),
    reconciliation_digest TEXT NOT NULL,
    expected_assignment_count INTEGER NOT NULL CHECK (expected_assignment_count >= 0),
    actor_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    created_at TEXT NOT NULL,
    finalized_at TEXT,
    UNIQUE (tenant_id, actor_id, draft_id, idempotency_key)
  )`,
  `CREATE TABLE IF NOT EXISTS plan_draft_required_unit_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    reconciliation_id INTEGER NOT NULL
      REFERENCES plan_draft_required_unit_reconciliations(id) ON DELETE CASCADE,
    target_draft_part_id INTEGER NOT NULL REFERENCES plan_draft_parts(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    predecessor_revision_part_id INTEGER REFERENCES plan_revision_parts(id) ON DELETE RESTRICT,
    UNIQUE (tenant_id, reconciliation_id, target_draft_part_id),
    CHECK (
      (kind = 'replace' AND predecessor_revision_part_id IS NULL)
      OR (kind IN ('select_exact_predecessor', 'accept_prior_completion')
        AND predecessor_revision_part_id IS NOT NULL)
    )
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_draft_required_unit_decisions_predecessor
    ON plan_draft_required_unit_decisions (
      tenant_id, reconciliation_id, predecessor_revision_part_id
    ) WHERE predecessor_revision_part_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS plan_draft_required_unit_assignments (
    tenant_id TEXT NOT NULL,
    reconciliation_id INTEGER NOT NULL
      REFERENCES plan_draft_required_unit_reconciliations(id) ON DELETE CASCADE,
    target_draft_part_id INTEGER NOT NULL REFERENCES plan_draft_parts(id) ON DELETE CASCADE,
    unit_index INTEGER NOT NULL CHECK (unit_index BETWEEN 0 AND 9999),
    kind TEXT NOT NULL,
    required_unit_token TEXT REFERENCES required_units(token) ON DELETE RESTRICT,
    PRIMARY KEY (tenant_id, reconciliation_id, target_draft_part_id, unit_index),
    CHECK (
      (kind = 'reuse' AND required_unit_token IS NOT NULL)
      OR (kind = 'create' AND required_unit_token IS NULL)
    )
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_draft_required_unit_assignments_token
    ON plan_draft_required_unit_assignments (
      tenant_id, reconciliation_id, required_unit_token
    ) WHERE required_unit_token IS NOT NULL`,
  `ALTER TABLE plan_drafts ADD COLUMN current_required_unit_reconciliation_id INTEGER
    REFERENCES plan_draft_required_unit_reconciliations(id) ON DELETE SET NULL`,
  `CREATE TRIGGER IF NOT EXISTS trg_plan_draft_required_unit_reconciliations_ownership_insert
    BEFORE INSERT ON plan_draft_required_unit_reconciliations
    WHEN NEW.finalized_at IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM plan_drafts draft
       WHERE draft.id = NEW.draft_id
         AND draft.tenant_id = NEW.tenant_id
         AND draft.profile_id = NEW.profile_id
         AND draft.state = 'open'
         AND draft.base_revision_id IS NEW.base_revision_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'Required-unit reconciliation ownership violation');
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_plan_draft_required_unit_reconciliations_finalize
    BEFORE UPDATE ON plan_draft_required_unit_reconciliations
    WHEN NOT (
      OLD.finalized_at IS NULL
      AND NEW.finalized_at IS NOT NULL
      AND NEW.id IS OLD.id
      AND NEW.tenant_id IS OLD.tenant_id
      AND NEW.profile_id IS OLD.profile_id
      AND NEW.draft_id IS OLD.draft_id
      AND NEW.format IS OLD.format
      AND NEW.planning_digest IS OLD.planning_digest
      AND NEW.base_revision_id IS OLD.base_revision_id
      AND NEW.base_mapping_digest IS OLD.base_mapping_digest
      AND NEW.selection_basis_digest IS OLD.selection_basis_digest
      AND NEW.selection_basis_json IS OLD.selection_basis_json
      AND NEW.decision_digest IS OLD.decision_digest
      AND NEW.result_kind IS OLD.result_kind
      AND NEW.result_digest IS OLD.result_digest
      AND NEW.result_json IS OLD.result_json
      AND NEW.reconciliation_digest IS OLD.reconciliation_digest
      AND NEW.expected_assignment_count IS OLD.expected_assignment_count
      AND NEW.actor_id IS OLD.actor_id
      AND NEW.idempotency_key IS OLD.idempotency_key
      AND NEW.payload_digest IS OLD.payload_digest
      AND NEW.created_at IS OLD.created_at
      AND (
        (NEW.result_kind = 'unresolved'
          AND json_extract(NEW.result_json, '$.kind') = 'unresolved'
          AND json_type(NEW.result_json, '$.conflicts') = 'array'
          AND NOT EXISTS (
            SELECT 1 FROM plan_draft_required_unit_assignments assignment
             WHERE assignment.reconciliation_id = NEW.id
               AND assignment.tenant_id = NEW.tenant_id
          ))
        OR (NEW.result_kind = 'ready'
          AND json_extract(NEW.result_json, '$.kind') = 'ready'
          AND json_type(NEW.result_json, '$.assignments') = 'array'
          AND json_type(NEW.result_json, '$.surplus') = 'array'
          AND json_array_length(NEW.result_json, '$.assignments') = NEW.expected_assignment_count
          AND NEW.expected_assignment_count = (
            SELECT count(*) FROM plan_draft_required_unit_assignments assignment
             WHERE assignment.reconciliation_id = NEW.id
               AND assignment.tenant_id = NEW.tenant_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM json_each(NEW.result_json, '$.assignments') expected
             WHERE NOT EXISTS (
               SELECT 1 FROM plan_draft_required_unit_assignments assignment
                WHERE assignment.reconciliation_id = NEW.id
                  AND assignment.tenant_id = NEW.tenant_id
                  AND assignment.target_draft_part_id = json_extract(expected.value, '$.draftPartId')
                  AND assignment.unit_index = json_extract(expected.value, '$.unitIndex')
                  AND assignment.kind = json_extract(expected.value, '$.kind')
                  AND (
                    (assignment.kind = 'create' AND assignment.required_unit_token IS NULL)
                    OR (assignment.kind = 'reuse'
                      AND assignment.required_unit_token = json_extract(expected.value, '$.token'))
                  )
             )
          )
          AND NOT EXISTS (
            SELECT 1 FROM plan_draft_parts part
             WHERE part.draft_id = NEW.draft_id
               AND part.tenant_id = NEW.tenant_id
               AND (
                 part.quantity_effective <> (
                   SELECT count(*) FROM plan_draft_required_unit_assignments assignment
                    WHERE assignment.reconciliation_id = NEW.id
                      AND assignment.tenant_id = NEW.tenant_id
                      AND assignment.target_draft_part_id = part.id
                 )
                 OR part.quantity_effective - 1 <> (
                   SELECT max(assignment.unit_index)
                     FROM plan_draft_required_unit_assignments assignment
                    WHERE assignment.reconciliation_id = NEW.id
                      AND assignment.tenant_id = NEW.tenant_id
                      AND assignment.target_draft_part_id = part.id
                 )
               )
          ))
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'Required-unit reconciliation finalization violation');
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_plan_draft_required_unit_reconciliations_immutable_delete
    BEFORE DELETE ON plan_draft_required_unit_reconciliations
    WHEN EXISTS (
      SELECT 1 FROM plan_drafts draft
      JOIN build_profiles profile
        ON profile.id = draft.profile_id AND profile.tenant_id = draft.tenant_id
      WHERE draft.id = OLD.draft_id AND draft.tenant_id = OLD.tenant_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'Required-unit reconciliation is immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_plan_draft_required_unit_decisions_ownership_insert
    BEFORE INSERT ON plan_draft_required_unit_decisions
    WHEN NOT EXISTS (
      SELECT 1
        FROM plan_draft_required_unit_reconciliations reconciliation
        JOIN plan_draft_parts target
          ON target.id = NEW.target_draft_part_id
         AND target.draft_id = reconciliation.draft_id
         AND target.tenant_id = reconciliation.tenant_id
       WHERE reconciliation.id = NEW.reconciliation_id
         AND reconciliation.tenant_id = NEW.tenant_id
         AND reconciliation.finalized_at IS NULL
         AND (
           NEW.predecessor_revision_part_id IS NULL
           OR EXISTS (
             SELECT 1 FROM plan_revision_parts predecessor
              WHERE predecessor.id = NEW.predecessor_revision_part_id
                AND predecessor.revision_id = reconciliation.base_revision_id
                AND predecessor.tenant_id = reconciliation.tenant_id
           )
         )
    )
    BEGIN
      SELECT RAISE(ABORT, 'Required-unit reconciliation decision ownership violation');
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_plan_draft_required_unit_decisions_immutable_update
    BEFORE UPDATE ON plan_draft_required_unit_decisions
    BEGIN
      SELECT RAISE(ABORT, 'Required-unit reconciliation decision is immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_plan_draft_required_unit_decisions_immutable_delete
    BEFORE DELETE ON plan_draft_required_unit_decisions
    WHEN EXISTS (
      SELECT 1 FROM plan_draft_required_unit_reconciliations reconciliation
      JOIN plan_drafts draft ON draft.id = reconciliation.draft_id
      JOIN build_profiles profile
        ON profile.id = draft.profile_id AND profile.tenant_id = draft.tenant_id
      WHERE reconciliation.id = OLD.reconciliation_id
        AND reconciliation.tenant_id = OLD.tenant_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'Required-unit reconciliation decision is immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_plan_draft_required_unit_assignments_ownership_insert
    BEFORE INSERT ON plan_draft_required_unit_assignments
    WHEN NOT EXISTS (
      SELECT 1
        FROM plan_draft_required_unit_reconciliations reconciliation
        JOIN plan_draft_parts target
          ON target.id = NEW.target_draft_part_id
         AND target.draft_id = reconciliation.draft_id
         AND target.tenant_id = reconciliation.tenant_id
       WHERE reconciliation.id = NEW.reconciliation_id
         AND reconciliation.tenant_id = NEW.tenant_id
         AND reconciliation.finalized_at IS NULL
         AND (
           (NEW.kind = 'create' AND NEW.required_unit_token IS NULL)
           OR (NEW.kind = 'reuse' AND EXISTS (
             SELECT 1 FROM required_units unit
              WHERE unit.token = NEW.required_unit_token
                AND unit.tenant_id = reconciliation.tenant_id
                AND unit.profile_id = reconciliation.profile_id
           ))
         )
    )
    BEGIN
      SELECT RAISE(ABORT, 'Required-unit reconciliation assignment ownership violation');
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_plan_draft_required_unit_assignments_immutable_update
    BEFORE UPDATE ON plan_draft_required_unit_assignments
    BEGIN
      SELECT RAISE(ABORT, 'Required-unit reconciliation assignment is immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_plan_draft_required_unit_assignments_immutable_delete
    BEFORE DELETE ON plan_draft_required_unit_assignments
    WHEN EXISTS (
      SELECT 1 FROM plan_draft_required_unit_reconciliations reconciliation
      JOIN plan_drafts draft ON draft.id = reconciliation.draft_id
      JOIN build_profiles profile
        ON profile.id = draft.profile_id AND profile.tenant_id = draft.tenant_id
      WHERE reconciliation.id = OLD.reconciliation_id
        AND reconciliation.tenant_id = OLD.tenant_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'Required-unit reconciliation assignment is immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_plan_drafts_required_unit_selection_update
    BEFORE UPDATE OF current_required_unit_reconciliation_id ON plan_drafts
    WHEN NEW.current_required_unit_reconciliation_id IS NOT OLD.current_required_unit_reconciliation_id
      AND EXISTS (
        SELECT 1 FROM build_profiles profile
         WHERE profile.id = OLD.profile_id AND profile.tenant_id = OLD.tenant_id
      )
      AND (
        NEW.state <> 'open'
        OR (
          NEW.current_required_unit_reconciliation_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM plan_draft_required_unit_reconciliations reconciliation
             WHERE reconciliation.id = NEW.current_required_unit_reconciliation_id
               AND reconciliation.tenant_id = NEW.tenant_id
               AND reconciliation.profile_id = NEW.profile_id
               AND reconciliation.draft_id = NEW.id
               AND reconciliation.finalized_at IS NOT NULL
          )
        )
      )
    BEGIN
      SELECT RAISE(ABORT, 'Plan draft Required-unit selection violation');
    END`,
  `ALTER TABLE plan_drafts ADD COLUMN consumed_revision_id INTEGER
    REFERENCES plan_revisions(id) ON DELETE CASCADE`,
  `ALTER TABLE plan_drafts ADD COLUMN consumed_at TEXT`,
  `CREATE TABLE IF NOT EXISTS plan_apply_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    profile_id INTEGER NOT NULL REFERENCES build_profiles(id) ON DELETE CASCADE,
    draft_id INTEGER NOT NULL REFERENCES plan_drafts(id) ON DELETE CASCADE,
    actor_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_format TEXT NOT NULL CHECK (request_format = 'plan-apply-request-v1'),
    request_digest TEXT NOT NULL,
    expected_snapshot_digest TEXT NOT NULL,
    expected_lifecycle_version INTEGER NOT NULL CHECK (
      expected_lifecycle_version BETWEEN 0 AND 2147483646
    ),
    expected_base_revision_id INTEGER REFERENCES plan_revisions(id) ON DELETE CASCADE,
    expected_base_plan_version INTEGER NOT NULL,
    reconciliation_id INTEGER NOT NULL
      REFERENCES plan_draft_required_unit_reconciliations(id) ON DELETE CASCADE,
    reconciliation_digest TEXT NOT NULL,
    revision_id INTEGER NOT NULL REFERENCES plan_revisions(id) ON DELETE CASCADE,
    plan_version INTEGER NOT NULL,
    revision_digest TEXT NOT NULL,
    required_unit_mapping_digest TEXT NOT NULL,
    draft_lifecycle_version INTEGER NOT NULL CHECK (
      draft_lifecycle_version BETWEEN 1 AND 2147483647
    ),
    applied_at TEXT NOT NULL,
    CHECK (
      (expected_base_revision_id IS NULL AND expected_base_plan_version = 0)
      OR (expected_base_revision_id IS NOT NULL AND expected_base_plan_version > 0)
    ),
    CHECK (plan_version = expected_base_plan_version + 1),
    CHECK (draft_lifecycle_version = expected_lifecycle_version + 1)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_apply_requests_tenant_actor_profile_key
    ON plan_apply_requests (tenant_id, actor_id, profile_id, idempotency_key)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_apply_requests_tenant_profile_draft
    ON plan_apply_requests (tenant_id, profile_id, draft_id)`,
  `CREATE TRIGGER IF NOT EXISTS trg_plan_drafts_consumption_insert
    BEFORE INSERT ON plan_drafts
    WHEN (NEW.state = 'consumed' AND (
      NEW.consumed_revision_id IS NULL OR NEW.consumed_at IS NULL
    )) OR (NEW.state <> 'consumed' AND (
      NEW.consumed_revision_id IS NOT NULL OR NEW.consumed_at IS NOT NULL
    ))
    BEGIN
      SELECT RAISE(ABORT, 'Plan draft consumption violation');
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_plan_drafts_consumption_update
    BEFORE UPDATE OF state, lifecycle_version, consumed_revision_id, consumed_at ON plan_drafts
    WHEN (
      (NEW.consumed_revision_id IS NULL) <> (NEW.consumed_at IS NULL)
    ) OR (
      NEW.state <> 'consumed'
      AND (NEW.consumed_revision_id IS NOT NULL OR NEW.consumed_at IS NOT NULL)
    ) OR (
      OLD.state = 'consumed'
      AND (
        OLD.consumed_revision_id IS NOT NEW.consumed_revision_id
        OR OLD.consumed_at IS NOT NEW.consumed_at
      )
    ) OR (
      OLD.state <> 'consumed'
      AND NEW.state = 'consumed'
      AND (
        NEW.consumed_revision_id IS NULL
        OR NEW.consumed_at IS NULL
        OR NOT EXISTS (
          SELECT 1
            FROM plan_revisions revision
            JOIN build_profiles profile
              ON profile.id = NEW.profile_id AND profile.tenant_id = NEW.tenant_id
           WHERE revision.id = NEW.consumed_revision_id
             AND revision.tenant_id = NEW.tenant_id
             AND revision.profile_id = NEW.profile_id
             AND revision.parent_revision_id IS NEW.base_revision_id
             AND profile.accepted_plan_revision_id = revision.id
             AND profile.accepted_plan_version = NEW.base_plan_version + 1
        )
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'Plan draft consumption violation');
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_plan_apply_requests_ownership_insert
    BEFORE INSERT ON plan_apply_requests
    WHEN NOT EXISTS (
      SELECT 1
        FROM plan_drafts draft
        JOIN plan_draft_required_unit_reconciliations reconciliation
          ON reconciliation.id = NEW.reconciliation_id
         AND reconciliation.tenant_id = NEW.tenant_id
         AND reconciliation.profile_id = NEW.profile_id
         AND reconciliation.draft_id = NEW.draft_id
         AND reconciliation.finalized_at IS NOT NULL
        JOIN plan_revisions revision
          ON revision.id = NEW.revision_id
         AND revision.tenant_id = NEW.tenant_id
         AND revision.profile_id = NEW.profile_id
        JOIN build_profiles profile
          ON profile.id = NEW.profile_id AND profile.tenant_id = NEW.tenant_id
       WHERE draft.id = NEW.draft_id
         AND draft.tenant_id = NEW.tenant_id
         AND draft.profile_id = NEW.profile_id
         AND draft.state = 'consumed'
         AND draft.consumed_revision_id = NEW.revision_id
         AND draft.lifecycle_version = NEW.draft_lifecycle_version
         AND draft.base_revision_id IS NEW.expected_base_revision_id
         AND draft.base_plan_version = NEW.expected_base_plan_version
         AND reconciliation.reconciliation_digest = NEW.reconciliation_digest
         AND revision.parent_revision_id IS NEW.expected_base_revision_id
         AND revision.snapshot_digest = NEW.revision_digest
         AND profile.accepted_plan_revision_id = NEW.revision_id
         AND profile.accepted_plan_version = NEW.plan_version
    )
    BEGIN
      SELECT RAISE(ABORT, 'Plan Apply request ownership violation');
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_plan_apply_requests_immutable_update
    BEFORE UPDATE ON plan_apply_requests
    BEGIN
      SELECT RAISE(ABORT, 'Plan Apply request is immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_plan_apply_requests_immutable_delete
    BEFORE DELETE ON plan_apply_requests
    WHEN EXISTS (
      SELECT 1 FROM build_profiles profile
       WHERE profile.id = OLD.profile_id AND profile.tenant_id = OLD.tenant_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'Plan Apply request is immutable');
    END`,
  `CREATE TABLE IF NOT EXISTS accepted_plate_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    profile_id INTEGER NOT NULL REFERENCES build_profiles(id) ON DELETE CASCADE,
    plan_revision_id INTEGER NOT NULL REFERENCES plan_revisions(id) ON DELETE CASCADE,
    plan_version INTEGER NOT NULL CHECK (plan_version > 0),
    plan_revision_digest TEXT NOT NULL,
    required_unit_mapping_digest TEXT NOT NULL,
    layout_digest TEXT NOT NULL,
    expected_plate_count INTEGER NOT NULL CHECK (expected_plate_count > 0),
    expected_unit_count INTEGER NOT NULL CHECK (expected_unit_count > 0),
    revision_number INTEGER NOT NULL CHECK (revision_number > 0),
    undo_from_revision_id INTEGER REFERENCES accepted_plate_revisions(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_accepted_plate_revisions_tenant_profile_number
    ON accepted_plate_revisions (tenant_id, profile_id, revision_number)`,
  `CREATE TABLE IF NOT EXISTS accepted_plate_heads (
    tenant_id TEXT NOT NULL,
    profile_id INTEGER PRIMARY KEY REFERENCES build_profiles(id) ON DELETE CASCADE,
    current_revision_id INTEGER NOT NULL REFERENCES accepted_plate_revisions(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS accepted_plates (
    tenant_id TEXT NOT NULL,
    revision_id INTEGER NOT NULL REFERENCES accepted_plate_revisions(id) ON DELETE CASCADE,
    plate_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal > 0),
    printer_id TEXT NOT NULL,
    printer_name TEXT NOT NULL,
    printer_model TEXT NOT NULL,
    bed_width_um INTEGER NOT NULL CHECK (bed_width_um BETWEEN 1 AND 2147483647),
    bed_depth_um INTEGER NOT NULL CHECK (bed_depth_um BETWEEN 1 AND 2147483647),
    bed_height_um INTEGER NOT NULL CHECK (bed_height_um BETWEEN 1 AND 2147483647),
    margin_um INTEGER NOT NULL CHECK (margin_um BETWEEN 0 AND 2147483647),
    CONSTRAINT pk_accepted_plates PRIMARY KEY (tenant_id, revision_id, plate_id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_accepted_plates_tenant_revision_ordinal
    ON accepted_plates (tenant_id, revision_id, ordinal)`,
  `CREATE TABLE IF NOT EXISTS accepted_plate_units (
    tenant_id TEXT NOT NULL,
    revision_id INTEGER NOT NULL REFERENCES accepted_plate_revisions(id) ON DELETE CASCADE,
    plate_id TEXT NOT NULL,
    required_unit_token TEXT NOT NULL REFERENCES required_units(token) ON DELETE CASCADE,
    x_um INTEGER NOT NULL CHECK (x_um BETWEEN 0 AND 2147483647),
    y_um INTEGER NOT NULL CHECK (y_um BETWEEN 0 AND 2147483647),
    width_um INTEGER NOT NULL CHECK (width_um BETWEEN 1 AND 2147483647),
    depth_um INTEGER NOT NULL CHECK (depth_um BETWEEN 1 AND 2147483647),
    height_um INTEGER NOT NULL CHECK (height_um BETWEEN 1 AND 2147483647),
    placement TEXT NOT NULL DEFAULT 'auto' CHECK (placement IN ('auto', 'manual', 'unplaced')),
    pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
    CONSTRAINT pk_accepted_plate_units
      PRIMARY KEY (tenant_id, revision_id, required_unit_token)
  )`,
  `CREATE TRIGGER IF NOT EXISTS trg_accepted_plate_revisions_ownership_insert
    BEFORE INSERT ON accepted_plate_revisions
    WHEN NOT EXISTS (
      SELECT 1
        FROM build_profiles profile
        JOIN plan_revisions revision
          ON revision.id = NEW.plan_revision_id
         AND revision.tenant_id = profile.tenant_id
         AND revision.profile_id = profile.id
        JOIN plan_revision_required_unit_sets unit_set
          ON unit_set.revision_id = revision.id
         AND unit_set.tenant_id = revision.tenant_id
         AND unit_set.profile_id = revision.profile_id
       WHERE profile.id = NEW.profile_id
         AND profile.tenant_id = NEW.tenant_id
         AND profile.accepted_plan_revision_id = NEW.plan_revision_id
         AND profile.accepted_plan_version = NEW.plan_version
         AND revision.snapshot_digest = NEW.plan_revision_digest
         AND unit_set.mapping_digest = NEW.required_unit_mapping_digest
    )
    BEGIN
      SELECT RAISE(ABORT, 'Accepted Plate revision ownership violation');
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_accepted_plate_heads_ownership_insert
    BEFORE INSERT ON accepted_plate_heads
    WHEN NOT EXISTS (
      SELECT 1 FROM accepted_plate_revisions revision
       WHERE revision.id = NEW.current_revision_id
         AND revision.tenant_id = NEW.tenant_id
         AND revision.profile_id = NEW.profile_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'Accepted Plate head ownership violation');
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_accepted_plate_heads_ownership_update
    BEFORE UPDATE ON accepted_plate_heads
    WHEN NOT EXISTS (
      SELECT 1 FROM accepted_plate_revisions revision
       WHERE revision.id = NEW.current_revision_id
         AND revision.tenant_id = NEW.tenant_id
         AND revision.profile_id = NEW.profile_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'Accepted Plate head ownership violation');
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_accepted_plates_ownership_insert
    BEFORE INSERT ON accepted_plates
    WHEN NOT EXISTS (
      SELECT 1 FROM accepted_plate_revisions revision
       WHERE revision.id = NEW.revision_id
         AND revision.tenant_id = NEW.tenant_id
         AND NOT EXISTS (
           SELECT 1 FROM accepted_plate_heads head
            WHERE head.current_revision_id = revision.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM accepted_plate_revisions newer
            WHERE newer.tenant_id = revision.tenant_id
              AND newer.profile_id = revision.profile_id
              AND newer.revision_number > revision.revision_number
         )
    )
    BEGIN
      SELECT RAISE(ABORT, 'Accepted Plate ownership violation');
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_accepted_plate_units_ownership_insert
    BEFORE INSERT ON accepted_plate_units
    WHEN NOT EXISTS (
      SELECT 1
        FROM accepted_plates plate
        JOIN accepted_plate_revisions plate_revision
          ON plate_revision.id = plate.revision_id
         AND plate_revision.tenant_id = plate.tenant_id
        JOIN plan_revision_required_units mapping
          ON mapping.revision_id = plate_revision.plan_revision_id
         AND mapping.tenant_id = plate_revision.tenant_id
         AND mapping.required_unit_token = NEW.required_unit_token
        JOIN plan_revision_parts part
          ON part.id = mapping.revision_part_id
         AND part.revision_id = mapping.revision_id
         AND part.tenant_id = mapping.tenant_id
       WHERE plate.tenant_id = NEW.tenant_id
         AND plate.revision_id = NEW.revision_id
         AND plate.plate_id = NEW.plate_id
         AND part.included = 1
         AND NOT EXISTS (
           SELECT 1 FROM accepted_plate_heads head
            WHERE head.current_revision_id = plate_revision.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM accepted_plate_revisions newer
            WHERE newer.tenant_id = plate_revision.tenant_id
              AND newer.profile_id = plate_revision.profile_id
              AND newer.revision_number > plate_revision.revision_number
         )
    )
    BEGIN
      SELECT RAISE(ABORT, 'Accepted Plate unit ownership violation');
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_accepted_plate_revisions_immutable_update
    BEFORE UPDATE ON accepted_plate_revisions
    WHEN NOT (
      OLD.undo_from_revision_id IS NOT NULL
      AND NEW.undo_from_revision_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM accepted_plate_revisions predecessor
         WHERE predecessor.id = OLD.undo_from_revision_id
      )
      AND NEW.id IS OLD.id
      AND NEW.tenant_id IS OLD.tenant_id
      AND NEW.profile_id IS OLD.profile_id
      AND NEW.plan_revision_id IS OLD.plan_revision_id
      AND NEW.plan_version IS OLD.plan_version
      AND NEW.plan_revision_digest IS OLD.plan_revision_digest
      AND NEW.required_unit_mapping_digest IS OLD.required_unit_mapping_digest
      AND NEW.layout_digest IS OLD.layout_digest
      AND NEW.expected_plate_count IS OLD.expected_plate_count
      AND NEW.expected_unit_count IS OLD.expected_unit_count
      AND NEW.revision_number IS OLD.revision_number
      AND NEW.created_at IS OLD.created_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'Accepted Plate revision is immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_accepted_plates_immutable_update
    BEFORE UPDATE ON accepted_plates
    BEGIN
      SELECT RAISE(ABORT, 'Accepted Plate is immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_accepted_plate_units_immutable_update
    BEFORE UPDATE ON accepted_plate_units
    BEGIN
      SELECT RAISE(ABORT, 'Accepted Plate unit is immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_accepted_plate_revisions_immutable_delete
    BEFORE DELETE ON accepted_plate_revisions
    WHEN EXISTS (
      SELECT 1 FROM build_profiles profile
       WHERE profile.id = OLD.profile_id AND profile.tenant_id = OLD.tenant_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'Accepted Plate revision is immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_accepted_plates_immutable_delete
    BEFORE DELETE ON accepted_plates
    WHEN EXISTS (
      SELECT 1
        FROM accepted_plate_revisions revision
        JOIN build_profiles profile
          ON profile.id = revision.profile_id AND profile.tenant_id = revision.tenant_id
       WHERE revision.id = OLD.revision_id AND revision.tenant_id = OLD.tenant_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'Accepted Plate is immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_accepted_plate_units_immutable_delete
    BEFORE DELETE ON accepted_plate_units
    WHEN EXISTS (
      SELECT 1
        FROM accepted_plate_revisions revision
        JOIN build_profiles profile
          ON profile.id = revision.profile_id AND profile.tenant_id = revision.tenant_id
       WHERE revision.id = OLD.revision_id AND revision.tenant_id = OLD.tenant_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'Accepted Plate unit is immutable');
    END`,
  // v32 - durable cutover from mutable workspace manifests to Source revisions.
  `ALTER TABLE projects ADD COLUMN legacy_manifest_cutover INTEGER NOT NULL DEFAULT 0`,
  // v34 — host-wide invite board. Not tenant-scoped.
  `CREATE TABLE IF NOT EXISTS board_posts (
    id TEXT PRIMARY KEY,
    author_user_id TEXT NOT NULL REFERENCES users(id),
    caption TEXT NOT NULL,
    title TEXT NOT NULL,
    cover_url TEXT,
    snapshot_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    hidden_at TEXT,
    hidden_by_user_id TEXT REFERENCES users(id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_board_posts_created ON board_posts (created_at)`,
  `CREATE TABLE IF NOT EXISTS board_comments (
    id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL REFERENCES board_posts(id) ON DELETE CASCADE,
    author_user_id TEXT NOT NULL REFERENCES users(id),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_board_comments_post_created ON board_comments (post_id, created_at)`,
];
