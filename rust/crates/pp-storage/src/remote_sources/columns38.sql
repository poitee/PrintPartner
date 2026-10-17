ALTER TABLE projects ADD COLUMN source_configuration_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE source_revisions ADD COLUMN source_configuration_version INTEGER;
ALTER TABLE source_revisions ADD COLUMN activation_observation_digest TEXT;
ALTER TABLE source_revisions ADD COLUMN input_digest TEXT;
ALTER TABLE source_revisions ADD COLUMN producer_version TEXT;
ALTER TABLE source_docs ADD COLUMN source_revision_id INTEGER REFERENCES source_revisions(id) ON DELETE RESTRICT;
ALTER TABLE source_docs ADD COLUMN input_digest TEXT;
ALTER TABLE source_docs ADD COLUMN producer_version TEXT CHECK ((source_revision_id IS NULL AND input_digest IS NULL AND producer_version IS NULL) OR (source_revision_id IS NOT NULL AND input_digest IS NOT NULL AND length(input_digest) = 64 AND producer_version IS NOT NULL));
