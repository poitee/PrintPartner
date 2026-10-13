CREATE TABLE durable_jobs (
 id TEXT PRIMARY KEY, tenant TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL,
 resource TEXT NOT NULL, version INTEGER NOT NULL, generation INTEGER NOT NULL,
 lease_until INTEGER, created INTEGER NOT NULL, updated INTEGER NOT NULL, document TEXT NOT NULL
);
CREATE INDEX durable_jobs_claim ON durable_jobs(state, created, id);
CREATE INDEX durable_jobs_tenant ON durable_jobs(tenant, updated, id);
CREATE TABLE durable_job_keys (
 tenant TEXT NOT NULL, key TEXT NOT NULL, intent TEXT NOT NULL, job_id TEXT NOT NULL UNIQUE, archived_document TEXT,
 PRIMARY KEY(tenant,key)
);
CREATE TABLE durable_job_history (
 job_id TEXT NOT NULL REFERENCES durable_jobs(id) ON DELETE CASCADE,
 version INTEGER NOT NULL, at INTEGER NOT NULL, state TEXT NOT NULL, event TEXT NOT NULL,
 PRIMARY KEY(job_id,version)
);
CREATE TABLE durable_job_reconciliations (
 job_id TEXT NOT NULL REFERENCES durable_jobs(id) ON DELETE CASCADE,
 version INTEGER NOT NULL, subject TEXT NOT NULL, generation INTEGER NOT NULL,
 effect_hash TEXT NOT NULL, basis_hash TEXT NOT NULL, target TEXT NOT NULL,
 decision TEXT NOT NULL, receipt TEXT NOT NULL, at INTEGER NOT NULL,
 PRIMARY KEY(job_id,version)
);
