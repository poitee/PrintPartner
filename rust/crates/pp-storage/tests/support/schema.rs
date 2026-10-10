// Test-only helpers for reconstructing historical schemas from a current database.
use rusqlite::Connection;

pub fn remove_schema42(connection: &Connection) {
    connection
        .execute_batch("DROP TABLE source_sync_targets; DROP TABLE source_sync_batches;")
        .unwrap();
}

pub fn remove_schema37(connection: &Connection) {
    connection
        .execute_batch(
            "DROP TRIGGER trg_plan_apply_admissions_immutable_delete;
             DROP TRIGGER trg_plan_apply_admissions_immutable_update;
             DROP TABLE plan_apply_admissions;",
        )
        .unwrap();
}

pub fn remove_schema38(connection: &Connection) {
    connection
        .execute_batch(
            "DROP TRIGGER trg_source_revisions_provenance_immutable_update;
             DROP TRIGGER trg_source_revisions_provenance_immutable_delete;
             DROP TRIGGER trg_source_revision_attempts_immutable_update;
             DROP TRIGGER trg_source_revision_attempts_immutable_delete;
             DROP TRIGGER trg_source_revision_artifacts_immutable_update;
             DROP TRIGGER trg_source_revision_artifacts_immutable_delete;
             DROP TRIGGER trg_source_revision_observations_immutable_update;
             DROP TRIGGER trg_source_revision_observations_immutable_delete;
             DROP TABLE source_revision_observations;
             DROP TABLE source_revision_artifacts;
             DROP TABLE source_revision_attempts;
             ALTER TABLE source_docs DROP COLUMN producer_version;
             ALTER TABLE source_docs DROP COLUMN input_digest;
             ALTER TABLE source_docs DROP COLUMN source_revision_id;
             ALTER TABLE source_revisions DROP COLUMN producer_version;
             ALTER TABLE source_revisions DROP COLUMN input_digest;
             ALTER TABLE source_revisions DROP COLUMN activation_observation_digest;
             ALTER TABLE source_revisions DROP COLUMN source_configuration_version;
             ALTER TABLE projects DROP COLUMN source_configuration_version;",
        )
        .unwrap();
}

pub fn remove_schema39(connection: &Connection) {
    connection
        .execute_batch(
            "DROP TRIGGER trg_source_revision_observations_preclaim_cursor_insert;
             DROP TRIGGER trg_source_preclaim_refusals_cursor_insert;
             DROP TRIGGER trg_source_preclaim_refusals_immutable_delete;
             DROP TRIGGER trg_source_preclaim_refusals_immutable_update;
             DROP TABLE source_preclaim_refusals;",
        )
        .unwrap();
}

pub fn remove_schema40(connection: &Connection) {
    connection
        .execute_batch("DROP TABLE source_scan_executions;")
        .unwrap();
}

pub fn remove_after(connection: &Connection, version: u64) {
    if version < 42 {
        remove_schema42(connection);
    }
    if version < 40 {
        remove_schema40(connection);
    }
    if version < 39 {
        remove_schema39(connection);
    }
    if version < 38 {
        remove_schema38(connection);
    }
    if version < 37 {
        remove_schema37(connection);
    }
}
