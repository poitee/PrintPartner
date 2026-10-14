CREATE TABLE IF NOT EXISTS native_secret_migrations (
    tenant_id TEXT NOT NULL,
    purpose TEXT NOT NULL CHECK (purpose = 'github_pat'),
    generation INTEGER NOT NULL CHECK (generation > 0),
    migration_id TEXT NOT NULL CHECK (
      length(migration_id) = 64
      AND migration_id NOT GLOB '*[^0-9a-f]*'
    ),
    state TEXT NOT NULL CHECK (state IN ('prepared', 'legacy_row_removed')),
    legacy_rowid INTEGER NOT NULL CHECK (legacy_rowid > 0),
    legacy_digest BLOB NOT NULL CHECK (length(legacy_digest) = 32),
    CONSTRAINT pk_native_secret_migrations PRIMARY KEY (tenant_id, purpose),
    CONSTRAINT uq_native_secret_migrations_id UNIQUE (migration_id)
  );
