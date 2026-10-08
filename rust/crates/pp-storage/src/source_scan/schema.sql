CREATE TABLE source_scan_executions (
  job_id TEXT NOT NULL REFERENCES durable_jobs(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK (generation > 0),
  tenant TEXT NOT NULL,
  attempt_worker TEXT NOT NULL,
  attempt_fence_digest TEXT NOT NULL CHECK (length(attempt_fence_digest) = 64),
  source_id INTEGER NOT NULL,
  reservation_incarnation TEXT NOT NULL CHECK (length(reservation_incarnation) = 64),
  reservation_token TEXT NOT NULL CHECK (
    length(reservation_token) = 16
    AND reservation_token = lower(reservation_token)
    AND reservation_token NOT GLOB '*[^0-9a-f]*'
    AND reservation_token <> '0000000000000000'
  ),
  configuration_version INTEGER NOT NULL CHECK (configuration_version > 0),
  authority_actor TEXT NOT NULL,
  authority_basis_digest TEXT NOT NULL CHECK (length(authority_basis_digest) = 64),
  activation_observation_digest TEXT NOT NULL CHECK (length(activation_observation_digest) = 64),
  path_observation_digest TEXT NOT NULL CHECK (length(path_observation_digest) = 64),
  producer_version TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('observed','local_settled','completed','reconciliation_required')),
  effect_applied INTEGER NOT NULL DEFAULT 0 CHECK (effect_applied IN (0,1)),
  inventory_digest TEXT CHECK (inventory_digest IS NULL OR length(inventory_digest) = 64),
  index_digest TEXT CHECK (index_digest IS NULL OR length(index_digest) = 64),
  receipt_id TEXT,
  receipt_hash TEXT,
  receipt_target TEXT,
  result_digest TEXT CHECK (result_digest IS NULL OR length(result_digest) = 64),
  primary_failure TEXT,
  reconciliation_reason TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (job_id,generation),
  UNIQUE (tenant,job_id,generation,attempt_worker,attempt_fence_digest),
  UNIQUE (reservation_incarnation,reservation_token),
  CHECK ((effect_applied=0 AND inventory_digest IS NULL AND index_digest IS NULL AND receipt_id IS NULL AND receipt_hash IS NULL AND receipt_target IS NULL)
      OR (effect_applied=1 AND inventory_digest IS NOT NULL AND index_digest IS NOT NULL AND receipt_id IS NOT NULL AND receipt_hash IS NOT NULL AND receipt_target IS NOT NULL)),
  CHECK (phase NOT IN ('local_settled','completed') OR effect_applied=1),
  CHECK ((phase='completed' AND result_digest IS NOT NULL) OR (phase<>'completed' AND result_digest IS NULL)),
  CHECK (phase<>'reconciliation_required' OR reconciliation_reason IS NOT NULL)
);
CREATE UNIQUE INDEX source_scan_execution_receipt
ON source_scan_executions(receipt_id) WHERE receipt_id IS NOT NULL;
