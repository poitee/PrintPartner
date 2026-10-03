CREATE TABLE source_import_operations (
 tenant TEXT NOT NULL, operation_key TEXT NOT NULL, actor TEXT NOT NULL,
 intent_digest TEXT NOT NULL, source_id INTEGER NOT NULL, job_id TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL CHECK(state IN ('admitted','owned_input_ready','published','activated','conflict','failed','cancelled')),
 document_version INTEGER NOT NULL CHECK(document_version=1), document TEXT NOT NULL,
 PRIMARY KEY(tenant,operation_key)
);
CREATE INDEX source_import_source ON source_import_operations(tenant,source_id,state);
CREATE TABLE source_import_quota (
 tenant TEXT NOT NULL, operation_key TEXT NOT NULL,
 reserved_bytes INTEGER NOT NULL CHECK(reserved_bytes>=0),
 retained_bytes INTEGER NOT NULL CHECK(retained_bytes>=0),
 settled INTEGER NOT NULL CHECK(settled IN (0,1)),
 PRIMARY KEY(tenant,operation_key),
 FOREIGN KEY(tenant,operation_key) REFERENCES source_import_operations(tenant,operation_key)
);
CREATE INDEX source_import_quota_pending ON source_import_quota(tenant,settled);
