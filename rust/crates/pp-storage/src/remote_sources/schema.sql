CREATE TABLE IF NOT EXISTS source_revision_attempts (
  tenant_id TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  job_id TEXT NOT NULL,
  source_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  revision_id INTEGER NOT NULL REFERENCES source_revisions(id) ON DELETE RESTRICT,
  source_configuration_version INTEGER NOT NULL CHECK (source_configuration_version > 0),
  activation_observation_digest TEXT NOT NULL CHECK (length(activation_observation_digest) = 64),
  input_digest TEXT NOT NULL CHECK (length(input_digest) = 64),
  producer_version TEXT NOT NULL,
  attempt_generation INTEGER NOT NULL CHECK (attempt_generation > 0),
  attempt_fence TEXT NOT NULL,
  activated INTEGER NOT NULL CHECK (activated IN (0,1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, operation_key)
);
CREATE TABLE IF NOT EXISTS source_revision_artifacts (
  revision_id INTEGER NOT NULL REFERENCES source_revisions(id) ON DELETE RESTRICT,
  artifact_kind TEXT NOT NULL,
  input_digest TEXT NOT NULL CHECK (length(input_digest) = 64),
  producer_version TEXT NOT NULL,
  artifact_digest TEXT NOT NULL CHECK (length(artifact_digest) = 64),
  PRIMARY KEY (revision_id, artifact_kind, input_digest, producer_version)
);
CREATE TABLE IF NOT EXISTS source_revision_observations (
  tenant_id TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  cursor INTEGER NOT NULL CHECK (cursor > 0),
  phase TEXT NOT NULL,
  job_id TEXT NOT NULL,
  attempt_generation INTEGER NOT NULL CHECK (attempt_generation > 0),
  attempt_fence TEXT,
  revision_id INTEGER REFERENCES source_revisions(id) ON DELETE RESTRICT,
  receipt_activated INTEGER CHECK (receipt_activated IN (0,1)),
  cancel_requested INTEGER NOT NULL CHECK (cancel_requested IN (0,1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, operation_key, cursor),
  FOREIGN KEY (tenant_id, operation_key)
    REFERENCES source_import_operations(tenant, operation_key)
);
CREATE TRIGGER IF NOT EXISTS trg_source_revisions_provenance_immutable_update
BEFORE UPDATE ON source_revisions
WHEN OLD.source_configuration_version IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Source revision provenance is immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_source_revisions_provenance_immutable_delete
BEFORE DELETE ON source_revisions
WHEN OLD.source_configuration_version IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Source revision provenance is immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_source_revision_attempts_immutable_update
BEFORE UPDATE ON source_revision_attempts
WHEN NOT (OLD.activated = 0 AND NEW.activated = 1
  AND NEW.tenant_id IS OLD.tenant_id
  AND NEW.operation_key IS OLD.operation_key
  AND NEW.job_id IS OLD.job_id
  AND NEW.source_id IS OLD.source_id
  AND NEW.revision_id IS OLD.revision_id
  AND NEW.source_configuration_version IS OLD.source_configuration_version
  AND NEW.activation_observation_digest IS OLD.activation_observation_digest
  AND NEW.input_digest IS OLD.input_digest
  AND NEW.producer_version IS OLD.producer_version
  AND NEW.attempt_generation IS OLD.attempt_generation
  AND NEW.attempt_fence IS OLD.attempt_fence
  AND NEW.created_at IS OLD.created_at)
BEGIN
  SELECT RAISE(ABORT, 'Source revision attempt is immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_source_revision_attempts_immutable_delete
BEFORE DELETE ON source_revision_attempts
BEGIN
  SELECT RAISE(ABORT, 'Source revision attempt is immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_source_revision_artifacts_immutable_update
BEFORE UPDATE ON source_revision_artifacts
BEGIN
  SELECT RAISE(ABORT, 'Source revision artifact is immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_source_revision_artifacts_immutable_delete
BEFORE DELETE ON source_revision_artifacts
BEGIN
  SELECT RAISE(ABORT, 'Source revision artifact is immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_source_revision_observations_immutable_update
BEFORE UPDATE ON source_revision_observations
BEGIN
  SELECT RAISE(ABORT, 'Source revision observation is immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_source_revision_observations_immutable_delete
BEFORE DELETE ON source_revision_observations
BEGIN
  SELECT RAISE(ABORT, 'Source revision observation is immutable');
END;
