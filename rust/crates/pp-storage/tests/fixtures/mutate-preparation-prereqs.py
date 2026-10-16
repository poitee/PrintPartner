"""Check preparation prerequisite mutants against the Node parity tests."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

rust = Path(__file__).resolve().parents[4]
manifest = Path('crates/pp-storage/src/working_drafts/manifest.rs')
read_model = Path('crates/pp-storage/src/read_model.rs')
context = Path('crates/pp-storage/src/read_model/context.rs')
mutants = [
    ('optional invalid is fatal', manifest, 'Err(ReadFailure::InvalidDocument) => Ok(None)', 'Err(ReadFailure::InvalidDocument) => Err(ReadFailure::InvalidDocument)'),
    ('kit ignores stored selections', manifest, '.selection_projection();', '.selection_projection();\n    let selections = if selections.is_empty() { selections } else { Vec::new() };'),
    ('manifest defaults override kit', manifest, 'if !selections.iter().any(|(k, _)| k == key)', 'if selections.iter().any(|(k, _)| k == key)'),
    ('project filtering omitted', manifest, 'if d.project.as_ref().is_some_and', 'if false && d.project.as_ref().is_some_and'),
    ('matched requirement omitted', manifest, 'part.manifest.requirement = Some(v.clone())', 'part.manifest.requirement = None'),
    ('explicit group membership ignored', manifest, 'explicit == id', 'false'),
    ('group minimum ignored', manifest, '(ids.len() as u64) >= g.min.unwrap_or(0)', 'true'),
    ('group maximum ignored', manifest, '(ids.len() as u64) <= max', 'true'),
    ('exclusion omitted', manifest, 'if excluded {', 'if false && excluded {'),
    ('stale base reused', read_model, 'if !context::draft_freshness_current', 'if false && !context::draft_freshness_current'),
    ('accepted validation bypassed', read_model, 'let accepted = graph::read(tx, tenant, profile, repos, &mut budget)?;', 'let accepted = AcceptedRead::Empty { profile: Profile { id: profile, name: String::new(), order_number: None, special_request: None, archived_at: None } };'),
    ('freshness always current', context, 'FreshnessFacts::Current { .. }\n    ))', 'FreshnessFacts::Current { .. } | FreshnessFacts::Untracked { .. }\n    ))'),
    ('path entry budget omitted', manifest, '        b.entry(0, key.len())?;', ''),
    ('comparison work uncharged', manifest, '    b.comparison(work)?;', ''),
    ('raw comparison input uncharged', manifest, '    b.comparison(pattern.units().len().saturating_add(key.len()))?;', ''),
    ('matcher steps uncounted', manifest, '        *work += 1;', ''),
    ('comparisons charged to document bytes', manifest, '    b.comparison(work)?;', '    b.comparison(work)?;\n    b.expansion(work.saturating_mul(2))?;'),
]
with tempfile.TemporaryDirectory(prefix='pp-preparation-mutants-', dir=rust / 'target') as directory:
    scratch = Path(directory) / 'rust'
    shutil.copytree(rust, scratch, ignore=shutil.ignore_patterns('target'))
    for sibling in rust.parent.iterdir():
        if sibling.name not in ('rust', '.git'):
            (scratch.parent / sibling.name).symlink_to(sibling)
    env = {**os.environ, 'CARGO_TARGET_DIR': str(rust / 'target/preparation-mutants-target')}
    command = ['cargo', 'nextest', 'run', '--locked', '--manifest-path', str(scratch / 'Cargo.toml'), '-p', 'pp-storage', '--features', 'desktop_rebuild', '--lib', '-E', 'test(preparation_tests)', '--test-threads=2']
    def run():
        return subprocess.run(command, env=env, capture_output=True, text=True)
    baseline = run()
    if baseline.returncode:
        raise SystemExit(baseline.stdout + baseline.stderr)
    killed = 0
    for name, path, before, after in mutants:
        target = scratch / path
        original = target.read_text()
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
