CREATE TABLE source_sync_batches (
  job_id TEXT PRIMARY KEY REFERENCES durable_jobs(id) ON DELETE CASCADE,
  tenant TEXT NOT NULL,
  selection_kind TEXT NOT NULL CHECK (selection_kind IN ('all','explicit')),
  target_basis_digest TEXT NOT NULL CHECK (length(target_basis_digest) = 64),
  target_count INTEGER NOT NULL CHECK (target_count >= 0 AND target_count <= 1000),
  phase TEXT NOT NULL CHECK (phase IN ('open','completed','failed','halted','reconciliation_required')),
  halt_code TEXT CHECK (halt_code IS NULL OR halt_code IN ('cancelled','authority_refused','fatal','uncertain_target')),
  aggregate_json TEXT,
  aggregate_digest TEXT CHECK (aggregate_digest IS NULL OR length(aggregate_digest) = 64),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((aggregate_json IS NULL) = (aggregate_digest IS NULL)),
  CHECK (phase IN ('open','halted','reconciliation_required') OR aggregate_json IS NOT NULL),
  CHECK ((phase = 'halted') = (halt_code IS NOT NULL))
);

CREATE TABLE source_sync_targets (
  job_id TEXT NOT NULL REFERENCES source_sync_batches(job_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0 AND ordinal < 1000),
  requested_source_id INTEGER NOT NULL CHECK (requested_source_id > 0),
  tenant TEXT NOT NULL,
  source_name TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending','claimed','succeeded','failed','not_run','reconciliation_required')),
  claim_generation INTEGER NOT NULL DEFAULT 0 CHECK (claim_generation >= 0),
  parent_generation INTEGER,
  attempt_worker TEXT,
  attempt_fence_digest TEXT CHECK (attempt_fence_digest IS NULL OR length(attempt_fence_digest) = 64),
  reservation_incarnation TEXT CHECK (reservation_incarnation IS NULL OR length(reservation_incarnation) = 64),
  reservation_token TEXT CHECK (reservation_token IS NULL OR (length(reservation_token) = 16 AND reservation_token = lower(reservation_token) AND reservation_token NOT GLOB '*[^0-9a-f]*' AND reservation_token <> '0000000000000000')),
  configuration_version INTEGER CHECK (configuration_version IS NULL OR configuration_version > 0),
  authority_actor TEXT,
  authority_basis_digest TEXT CHECK (authority_basis_digest IS NULL OR length(authority_basis_digest) = 64),
  activation_observation_digest TEXT CHECK (activation_observation_digest IS NULL OR length(activation_observation_digest) = 64),
  path_observation_digest TEXT CHECK (path_observation_digest IS NULL OR length(path_observation_digest) = 64),
  result_json TEXT,
  result_digest TEXT CHECK (result_digest IS NULL OR length(result_digest) = 64),
  receipt_id TEXT,
  receipt_hash TEXT,
  receipt_target TEXT,
  failure_code TEXT CHECK (failure_code IS NULL OR failure_code IN ('unavailable','unsupported_kind','local_read','local_settlement','configuration_changed','authority_refused','batch_halt')),
  failure_detail TEXT,
  reservation_acknowledged INTEGER NOT NULL DEFAULT 0 CHECK (reservation_acknowledged IN (0,1)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (job_id, ordinal),
  CHECK ((state = 'pending' AND parent_generation IS NULL AND reservation_incarnation IS NULL AND result_json IS NULL AND failure_code IS NULL)
      OR state <> 'pending'),
  CHECK ((state = 'claimed' AND parent_generation IS NOT NULL AND attempt_worker IS NOT NULL AND attempt_fence_digest IS NOT NULL AND reservation_incarnation IS NOT NULL AND reservation_token IS NOT NULL AND configuration_version IS NOT NULL AND authority_actor IS NOT NULL AND authority_basis_digest IS NOT NULL AND activation_observation_digest IS NOT NULL AND path_observation_digest IS NOT NULL)
      OR state <> 'claimed'),
  CHECK ((state = 'succeeded' AND result_json IS NOT NULL AND result_digest IS NOT NULL AND receipt_id IS NOT NULL AND receipt_hash IS NOT NULL AND receipt_target IS NOT NULL AND failure_code IS NULL)
      OR state <> 'succeeded'),
  CHECK ((state = 'failed' AND failure_code IS NOT NULL AND result_json IS NULL)
      OR state <> 'failed'),
  CHECK ((state = 'not_run' AND failure_code = 'batch_halt' AND result_json IS NULL AND reservation_incarnation IS NULL)
      OR state <> 'not_run'),
  CHECK (state NOT IN ('succeeded','failed') OR reservation_acknowledged = 1 OR reservation_incarnation IS NOT NULL)
);

CREATE INDEX source_sync_targets_next
ON source_sync_targets(job_id, state, ordinal);

CREATE UNIQUE INDEX source_sync_targets_active_source
ON source_sync_targets(tenant, requested_source_id)
WHERE state = 'claimed';

CREATE UNIQUE INDEX source_sync_targets_receipt
ON source_sync_targets(receipt_id)
WHERE receipt_id IS NOT NULL;
