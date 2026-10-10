CREATE INDEX IF NOT EXISTS durable_jobs_printer_start_parent
ON durable_jobs(tenant, json_extract(document,'$.payload.payload.uploaded_job_id'));
CREATE INDEX IF NOT EXISTS durable_job_keys_archived_printer_start_parent
ON durable_job_keys(tenant, json_extract(archived_document,'$.payload.payload.uploaded_job_id'))
WHERE archived_document IS NOT NULL;
