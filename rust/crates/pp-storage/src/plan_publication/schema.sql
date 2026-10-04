CREATE TABLE plan_apply_admissions (
  apply_request_id INTEGER PRIMARY KEY
    REFERENCES plan_apply_requests(id) ON DELETE CASCADE,
  request_format TEXT NOT NULL CHECK (request_format = 'plan-apply-request-v1'),
  request_digest TEXT NOT NULL,
  expected_snapshot_digest TEXT NOT NULL,
  expected_lifecycle_version INTEGER NOT NULL CHECK (
    expected_lifecycle_version BETWEEN 0 AND 2147483646
  ),
  expected_base_revision_id INTEGER,
  expected_base_plan_version INTEGER NOT NULL,
  CHECK (
    (expected_base_revision_id IS NULL AND expected_base_plan_version = 0)
    OR (expected_base_revision_id IS NOT NULL AND expected_base_plan_version > 0)
  )
);

CREATE TRIGGER trg_plan_apply_admissions_immutable_update
BEFORE UPDATE ON plan_apply_admissions
BEGIN
  SELECT RAISE(ABORT, 'Plan Apply admission is immutable');
END;

CREATE TRIGGER trg_plan_apply_admissions_immutable_delete
BEFORE DELETE ON plan_apply_admissions
WHEN EXISTS (
  SELECT 1
    FROM plan_apply_requests request
    JOIN build_profiles profile
      ON profile.id = request.profile_id
     AND profile.tenant_id = request.tenant_id
   WHERE request.id = OLD.apply_request_id
)
BEGIN
  SELECT RAISE(ABORT, 'Plan Apply admission is immutable');
END;
