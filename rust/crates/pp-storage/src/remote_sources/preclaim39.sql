CREATE TABLE source_preclaim_refusals (
  tenant_id TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  cursor INTEGER NOT NULL CHECK (cursor > 0),
  phase TEXT NOT NULL CHECK (phase = 'authority_refused'),
  job_id TEXT NOT NULL,
  admitted_generation INTEGER NOT NULL CHECK (admitted_generation = 0),
  cancel_requested INTEGER NOT NULL CHECK (cancel_requested IN (0,1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, operation_key, cursor),
  UNIQUE (tenant_id, operation_key),
  FOREIGN KEY (tenant_id, operation_key)
    REFERENCES source_import_operations(tenant, operation_key)
);
CREATE TRIGGER trg_source_preclaim_refusals_immutable_update
BEFORE UPDATE ON source_preclaim_refusals
BEGIN
  SELECT RAISE(ABORT, 'Source preclaim refusal is immutable');
END;
CREATE TRIGGER trg_source_preclaim_refusals_immutable_delete
BEFORE DELETE ON source_preclaim_refusals
BEGIN
  SELECT RAISE(ABORT, 'Source preclaim refusal is immutable');
END;
CREATE TRIGGER trg_source_preclaim_refusals_cursor_insert
BEFORE INSERT ON source_preclaim_refusals
WHEN EXISTS (
  SELECT 1 FROM source_revision_observations
  WHERE tenant_id = NEW.tenant_id
    AND operation_key = NEW.operation_key
    AND cursor = NEW.cursor
)
BEGIN
  SELECT RAISE(ABORT, 'Source observation cursor collision');
END;
CREATE TRIGGER trg_source_revision_observations_preclaim_cursor_insert
BEFORE INSERT ON source_revision_observations
WHEN EXISTS (
  SELECT 1 FROM source_preclaim_refusals
  WHERE tenant_id = NEW.tenant_id
    AND operation_key = NEW.operation_key
    AND cursor = NEW.cursor
)
BEGIN
  SELECT RAISE(ABORT, 'Source observation cursor collision');
END;
