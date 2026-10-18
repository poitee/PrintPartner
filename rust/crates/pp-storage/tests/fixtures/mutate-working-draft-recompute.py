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
    ('carried draft header is not charged', '    for (table, columns, predicate, visits, overhead) in tables {', '    for (table, columns, predicate, visits, overhead) in tables {\n        if table == "plan_drafts" { continue; }'),
    ('carried inputs are not charged', '    for (table, columns, predicate, visits, overhead) in tables {', '    for (table, columns, predicate, visits, overhead) in tables {\n        if table == "plan_draft_inputs" { continue; }'),
    ('carried Parts are not charged', '    for (table, columns, predicate, visits, overhead) in tables {', '    for (table, columns, predicate, visits, overhead) in tables {\n        if table == "plan_draft_parts" { continue; }'),
    ('carried reconciliation is not charged', '    for (table, columns, predicate, visits, overhead) in tables {', '    for (table, columns, predicate, visits, overhead) in tables {\n        if table == "plan_draft_required_unit_reconciliations" { continue; }'),
    ('carried assignments are not charged', '    for (table, columns, predicate, visits, overhead) in tables {', '    for (table, columns, predicate, visits, overhead) in tables {\n        if table == "plan_draft_required_unit_assignments" { continue; }'),
    ('carried text is not charged', '            budget.comparison(usize::try_from(row.get::<_, i64>(0)?)? + overhead)?;\n', '            let _ = (row, overhead);\n'),
    ('carried spool IDs are not charged', "            .split(',')\n", "            .split(',')\n            .filter(|column| *column != \"spoolman_spool_id\")\n"),
    ('assignment row work is free', 'const ASSIGNMENT_ROW_WORK: usize = 1024;', 'const ASSIGNMENT_ROW_WORK: usize = 0;'),
    ('assignment row work is undercharged', 'const ASSIGNMENT_ROW_WORK: usize = 1024;', 'const ASSIGNMENT_ROW_WORK: usize = 32;'),
    ('carried loader cancellation is removed', 'Ok(budget.check()?)', 'Ok(())'),
    ('assignments spend visits', '            0,\n            ASSIGNMENT_ROW_WORK,', '            1,\n            ASSIGNMENT_ROW_WORK,'),
    ('carried edits keep the prepared digest', 'changed |= *part != before;', 'changed |= false;'),
    ('superseded draft keeps its lifecycle', "SET state='abandoned',lifecycle_version=lifecycle_version+1 WHERE tenant_id=? AND profile_id=? AND state='open'", "SET state='abandoned' WHERE tenant_id=? AND profile_id=? AND state='open'"),
    ('creation time is not ISO', '            auth::catalog_timestamp(),', '            "now",'),
    ('recompute skips selection', '                    let _ = reply.send(recomputed.and_then(|outcome| {\n                        select_recomputed(\n                            connection, credential, policy, profile, &cancelled, outcome,\n                        )\n                    }));', '                    let _ = (credential, reply.send(recomputed.map(RecomputeWorkspaceOutcome::Refused)));'),
    ('existing draft is not selected', '        RecomputeOutcome::Created { draft } | RecomputeOutcome::Existing { draft } => draft,', '        RecomputeOutcome::Created { draft } => draft,'),
    ('selected draft is selected again', '    if !draft.ordinary["requiredUnitReconciliation"].is_null() {', '    if false {'),
    ('selection key ignores the digest', '        &format!("auto-{}", digest.as_str()),', '        "auto",'),
    ('selection skips the commit cancellation check', '    let outcome = body(&tx)?;\n    ensure!(!cancelled.load(Ordering::Acquire), Failure::Cancelled);', '    let outcome = body(&tx)?;'),
]
with tempfile.TemporaryDirectory(prefix='pp-a9-mutants-', dir='/persist/tmp') as directory:
    scratch = Path(directory) / 'rust'
    shutil.copytree(rust, scratch, ignore=shutil.ignore_patterns('target'))
    for sibling in rust.parent.iterdir():
        if sibling.name not in ('rust', '.git'):
            (scratch.parent / sibling.name).symlink_to(sibling)
    env = {**os.environ, 'CARGO_TARGET_DIR': os.environ.get('CARGO_TARGET_DIR', str(Path(directory) / 'target'))}
    command = ['cargo', 'nextest', 'run', '--locked', '--manifest-path', str(scratch / 'Cargo.toml'), '-p', 'pp-storage', '--features', 'desktop_rebuild', '--test', 'working_draft_recompute', '--test-threads=4']
    def run(name=None):
        selected = command
        if name in ('assignment row work is free', 'assignment row work is undercharged'):
            selected = command + ['--release', '-E', 'test(multiple_maximum_drafts)']
        elif name == 'assignments spend visits':
            selected = command + ['--release', '-E', 'test(two_hundred_thousand_assignments)']
        elif name:
            selected = command + ['-E', 'not test(two_hundred_thousand_assignments)']
        return subprocess.run(selected, env=env, capture_output=True, text=True)
    baseline = run()
    if baseline.returncode:
        raise SystemExit(baseline.stdout + baseline.stderr)
    print('BASELINE debug passed', flush=True)
    baseline = subprocess.run(command + ['--release', '-E', 'test(two_hundred_thousand_assignments) | test(multiple_maximum_drafts) | test(cancellation_inside_a_large)'], env=env, capture_output=True, text=True)
    if baseline.returncode:
        raise SystemExit(baseline.stdout + baseline.stderr)
    print('BASELINE release passed', flush=True)
    target = scratch / source
    original = target.read_text()
    killed = 0
    for name, before, after in mutants:
        if original.count(before) != 1:
            raise SystemExit(f'Mutation target is not unique: {name}')
        try:
            target.write_text(original.replace(before, after))
            result = run(name)
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
