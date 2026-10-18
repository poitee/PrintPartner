"""Require each rebase mutant to fail an executed behavior test."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

rust = Path(__file__).resolve().parents[4]
source = Path('crates/pp-storage/src/working_drafts/rebase.rs')
mutants = [
    ('open source at the version cap accepted', '!(open && version == 2_147_483_647)', 'true'),
    ('open source keeps its generation', 'generation: version + i64::from(open),', 'generation: version,'),
    ('wrong source state reported as conflict', 'state: identity.state,', 'state: DraftState::Consumed,'),
    ('stale source digest accepted', '|| identity.snapshot_digest.as_str() != self.digest', '|| false'),
    ('successor digest ignored', 'if successor.header["rebasedFromSnapshotDigest"] == source.digest {', 'if true {'),
    ('unchanged path always prepares', 'if same_base && inputs_current(&tx, &current.inputs, &mut budget)? {', 'if false {'),
    ('moved base after preparation ignored', '        if profile_row["acceptedPlanRevisionId"] != prepared.base["baseRevisionId"]\n            || profile_row["acceptedPlanVersion"] != prepared.base["basePlanVersion"]', '        if false'),
    ('changed inputs ignored', 'if captured.fingerprint != prepared.capture.fingerprint {', 'if false {'),
    ('open source not abandoned', '        if open\n            && tx.execute(', '        if false\n            && tx.execute('),
    ('new Part included baseline is false', 'None if field == Field::Included => json!(true),', 'None if field == Field::Included => json!(false),'),
    ('new Part inclusion not decided', 'let new_included = field == Field::Included && part["baseRevisionPartId"].is_null();', 'let new_included = false;'),
    ('shared layer keeps its first Source', '.and_modify(|shared| *shared = None)', '.and_modify(|_| ())'),
    ('duplicated key not ambiguous', '&& !(source_evidence.keyed(source_id, key).len() == 1 && found.len() == 1);', '&& false;'),
    ('projection match skipped', 'old_projections.get(projection) == Some(&1)', 'false'),
    ('tracked artifact fallback skipped', 'let found = if fresh_evidence.tracked.contains(&source_id) {', 'let found = if false {'),
    ('target collision not reported', 'if source_part_ids.len() > 1 {', 'if false {'),
    ('concurrent decision overwritten', 'if !independent && *current != baseline(part, field)? && current != value {', 'if false {'),
    ('effective quantity not refreshed', 'next["quantityEffective"] = if value.is_null() {', 'next["quantityOverride"] = if value.is_null() {'),
    ('merged digest kept', 'fresh.digest = model::planning(&fresh.base, &fresh.capture.inputs, &fresh.parts)?;', ''),
]
with tempfile.TemporaryDirectory(prefix='pp-rebase-mutants-', dir='/persist/tmp') as directory:
    scratch = Path(directory) / 'rust'
    shutil.copytree(rust, scratch, ignore=shutil.ignore_patterns('target'))
    for sibling in rust.parent.iterdir():
        if sibling.name not in ('rust', '.git'):
            (scratch.parent / sibling.name).symlink_to(sibling)
    env = {**os.environ, 'CARGO_TARGET_DIR': str(Path(directory) / 'target')}
    command = ['cargo', 'nextest', 'run', '--locked', '--manifest-path', str(scratch / 'Cargo.toml'), '-p', 'pp-storage', '--features', 'desktop_rebuild', '--test', 'working_draft_rebase', '--test-threads=4']
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
