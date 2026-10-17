"""Require each recompute mutant to fail an executed behavior test."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

rust = Path(__file__).resolve().parents[4]
source = Path('crates/pp-storage/src/working_drafts.rs')
mutants = [
    ('key not trimmed', 'JsText::scalar(idempotency_key).trim_ecmascript()', 'JsText::scalar(idempotency_key)'),
    ('key cap raised', 'key.units().len() <= 160', 'key.units().len() <= 161'),
    ('kept draft skips accepted reuse', 'prefer_accepted: !self.apply_manifest,', 'prefer_accepted: false,'),
    ('rebased key replayed', 'if draft_origin(&saved.header)? == json!({"kind":"recompute"}) {', 'if true {'),
    ('no STLs reported as no layers', 'Some(preparation::Failure::NoStls) => finished(RecomputeOutcome::NoStls),', 'Some(preparation::Failure::NoStls) => finished(RecomputeOutcome::NoLayers),'),
    ('cancelled outcomes returned', '    let finished = |outcome| {\n        ensure!(!cancelled.load(Ordering::Acquire), Failure::Cancelled);\n', '    let finished = |outcome| {\n'),
    ('winner after preparation ignored', '        if let Some(winner) = winner(tx, &tenant, &actor, profile, key)? {\n            return Ok(winner);\n        }\n', ''),
    ('hidden profile is not found', '        else {\n            return Ok(RecomputeOutcome::BaseChanged);\n        };', '        else {\n            return Ok(RecomputeOutcome::ProfileNotFound);\n        };'),
    ('baseline lost after preparation ignored', '        if baseline_required(tx, &tenant, &profile_row)? {', '        if false {'),
    ('moved Plan version ignored', '            || profile_row["acceptedPlanVersion"] != base["basePlanVersion"]', '            || false'),
    ('changed inputs ignored', 'if current.fingerprint != prepared.capture.fingerprint {', 'if false {'),
    ('carried quantity dropped', 'if !quantity.is_null() {', 'if false {'),
    ('inclusion always carried', '        if keep_inclusion {', '        if true {'),
    ('carried draft header is not charged', 'SELECT id,1,LENGTH(CAST(concat(base_revision_id,base_plan_version,digest_format,snapshot_digest,current_required_unit_reconciliation_id) AS BLOB)) FROM open', 'SELECT id,1,0 FROM open'),
    ('carried inputs are not charged', 'concat(i.source_id,i.source_layer,i.layer_order,i.tracking_kind,i.source_revision_id,i.manifest_digest,i.effective_naming_digest)', "''"),
    ('carried Parts are not charged', 'SELECT o.id,1,LENGTH(CAST(concat(p.', 'SELECT o.id,0,LENGTH(CAST(concat(p.'),
    ('carried reconciliation is not charged', 'JOIN plan_draft_required_unit_reconciliations r ON r.tenant_id=o.tenant_id', 'JOIN plan_draft_required_unit_reconciliations r ON 0 AND r.tenant_id=o.tenant_id'),
    ('carried assignments are not charged', 'JOIN plan_draft_required_unit_assignments a ON a.tenant_id=o.tenant_id', 'JOIN plan_draft_required_unit_assignments a ON 0 AND a.tenant_id=o.tenant_id'),
    ('carried text is not charged', '        budget.comparison(usize::try_from(num(&open, "bytes")?)?)?;\n', ''),
    ('carried spool IDs are not charged', 'p.filament_custom_hex,p.spoolman_spool_id,', 'p.filament_custom_hex,'),
    ('carried edits keep the prepared digest', 'changed |= *part != before;', 'changed |= false;'),
    ('superseded draft keeps its lifecycle', "SET state='abandoned',lifecycle_version=lifecycle_version+1 WHERE tenant_id=? AND profile_id=? AND state='open'", "SET state='abandoned' WHERE tenant_id=? AND profile_id=? AND state='open'"),
    ('creation time is not ISO', '            auth::catalog_timestamp(),', '            "now",'),
]
with tempfile.TemporaryDirectory(prefix='pp-a8-mutants-', dir='/persist/tmp') as directory:
    scratch = Path(directory) / 'rust'
    shutil.copytree(rust, scratch, ignore=shutil.ignore_patterns('target'))
    for sibling in rust.parent.iterdir():
        if sibling.name not in ('rust', '.git'):
            (scratch.parent / sibling.name).symlink_to(sibling)
    env = {**os.environ, 'CARGO_TARGET_DIR': str(Path(directory) / 'target')}
    command = ['cargo', 'nextest', 'run', '--locked', '--manifest-path', str(scratch / 'Cargo.toml'), '-p', 'pp-storage', '--features', 'desktop_rebuild', '--test', 'working_draft_recompute', '--test-threads=4']
    def run():
        return subprocess.run(command, env=env, capture_output=True, text=True)
    baseline = run()
    if baseline.returncode:
        raise SystemExit(baseline.stdout + baseline.stderr)
    print('BASELINE passed', flush=True)
    target = scratch / source
    original = target.read_text()
    killed = 0
    for name, before, after in mutants:
        if original.count(before) != 1:
            raise SystemExit(f'Mutation target is not unique: {name}')
        try:
            target.write_text(original.replace(before, after))
            result = run()
            output = result.stdout + result.stderr
            if result.returncode == 100 and 'FAIL [' in output:
                killed += 1
                print(f'KILLED {name}', flush=True)
            elif result.returncode == 0:
                print(f'SURVIVED {name}', flush=True)
            else:
                raise SystemExit(output)
        finally:
            target.write_text(original)
    print(f'{killed}/{len(mutants)} mutants killed')
    if killed != len(mutants):
        raise SystemExit(1)
