import type Database from "better-sqlite3";
import { schemaVersionKey } from "./schema.js";

export const ACCEPTED_PLATE_EDIT_SCHEMA_VERSION = 31;

type ColumnInfo = Readonly<{ name: string }>;

function hasColumn(sqlite: Database.Database, table: string, column: string): boolean {
  const columns = sqlite.pragma(`table_info(${table})`) as ColumnInfo[];
  return columns.some((candidate) => candidate.name === column);
}

export function applyAcceptedPlateEditSchema(sqlite: Database.Database): void {
  const migrate = sqlite.transaction(() => {
    if (!hasColumn(sqlite, "accepted_plate_revisions", "undo_from_revision_id")) {
      sqlite.exec(
        "ALTER TABLE accepted_plate_revisions ADD COLUMN undo_from_revision_id INTEGER REFERENCES accepted_plate_revisions(id) ON DELETE SET NULL",
      );
    }
    if (!hasColumn(sqlite, "accepted_plate_units", "placement")) {
      sqlite.exec(
        "ALTER TABLE accepted_plate_units ADD COLUMN placement TEXT NOT NULL DEFAULT 'auto' CHECK (placement IN ('auto', 'manual', 'unplaced'))",
      );
    }
    if (!hasColumn(sqlite, "accepted_plate_units", "pinned")) {
      sqlite.exec(
        "ALTER TABLE accepted_plate_units ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1))",
      );
    }
    sqlite.exec(`DROP TRIGGER IF EXISTS trg_accepted_plate_revisions_immutable_update;
      CREATE TRIGGER trg_accepted_plate_revisions_immutable_update
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
      END`);
    sqlite
      .prepare(
        `INSERT INTO app_settings (tenant_id, key, value) VALUES (?, ?, ?)
         ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value`,
      )
      .run("default", schemaVersionKey, String(ACCEPTED_PLATE_EDIT_SCHEMA_VERSION));
  });
  migrate.immediate();
}
