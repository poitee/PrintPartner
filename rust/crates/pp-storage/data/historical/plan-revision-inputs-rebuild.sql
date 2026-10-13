        ALTER TABLE plan_revision_inputs RENAME TO plan_revision_inputs_v17;
        CREATE TABLE plan_revision_inputs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          input_set_id INTEGER NOT NULL REFERENCES plan_revision_input_sets(id) ON DELETE CASCADE,
          source_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
          source_layer TEXT NOT NULL,
          layer_order INTEGER NOT NULL DEFAULT 0,
          tracking_kind TEXT NOT NULL DEFAULT 'revision'
            CHECK (tracking_kind IN ('revision', 'untracked')),
          source_revision_id INTEGER REFERENCES source_revisions(id) ON DELETE RESTRICT,
          manifest_digest TEXT,
          effective_naming_digest TEXT,
          CHECK (
            (tracking_kind = 'revision' AND source_revision_id IS NOT NULL AND manifest_digest IS NOT NULL)
            OR
            (tracking_kind = 'untracked' AND source_revision_id IS NULL AND manifest_digest IS NULL)
          )
        );
        INSERT INTO plan_revision_inputs (
          id, tenant_id, input_set_id, source_id, source_layer, layer_order,
          tracking_kind, source_revision_id, manifest_digest, effective_naming_digest
        )
        SELECT
          id, tenant_id, input_set_id, source_id, source_layer, layer_order,
          tracking_kind, source_revision_id, manifest_digest, effective_naming_digest
        FROM plan_revision_inputs_v17;
        DROP TABLE plan_revision_inputs_v17;
        CREATE UNIQUE INDEX uq_plan_revision_inputs_v2_set_source
          ON plan_revision_inputs (input_set_id, source_id)
          WHERE effective_naming_digest IS NOT NULL;
        CREATE INDEX idx_plan_revision_inputs_tenant_set
          ON plan_revision_inputs (tenant_id, input_set_id);
