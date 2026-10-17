"""Require each preparation mutant to fail an executed behavior test."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

rust = Path(__file__).resolve().parents[4]
source = Path('crates/pp-storage/src/working_drafts/preparation.rs')
mutants = [
    ('layer override projection uncharged', 'defaults\n                    .bytes\n                    .saturating_add(raw_metadata.map(str::len).unwrap_or_default())\n                    .saturating_mul(8)', '0'),
    ('global default projection repeated per layer', 'defaults.clone()', 'project_naming(Map::new(), (*defaults.profile).clone(), budget)?'),
    ('quantity anchors replaced globally', 'strip = regress::Regex::new(r"\\\\\\.stl\\$")?.replace(&strip, "$");', 'strip = regress::Regex::new(r"\\\\\\.stl\\$")?.replace_all(&strip, "$");'),
    ('disabled Spoolman defaults retained', 'match default_key {', 'match "enabled" {'),
    ('folder matching work uncharged', 'lower.len().saturating_add(rule.path_contains.len())', '0'),
    ('marker matching work uncharged', 'segment.len().saturating_add(marker.len())', '0'),
    ('duplicate attachment accepted', 'seen.insert(id),', 'seen.insert(id) || true,'),
    ('input tracking lost', 'if revision.is_some(){"revision"}else{"untracked"}', '"untracked"'),
    ('prior decisions lost', 'prior.entry(text(&p, "partKey")?.to_owned()).or_insert(p);', 'let _ = p;'),
    ('path exclusions ignored', 'excluded |= p == &path;', 'excluded |= false;'),
    ('import restrictions ignored', 'if imported(&p.path, &layer.rules, b)? {', 'if true {'),
    ('untracked artifacts hashed', 'let artifact = if tracked {', 'let artifact = if true {'),
    ('manifest inclusion restored unconditionally', 'if !options.apply_manifest {', 'if true {'),
    ('accepted reuse ignored', 'if reuse {', 'if false {'),
    ('reference choices lost', 'part["roleOverride"] = json!(choice.role);', 'part["roleOverride"] = Value::Null;'),
    ('missing reference choice accepted', 'matched.len() == choices.values().map(|choices| choices.len()).sum::<usize>(),', 'true,'),
    ('capture visit budget omitted', '        budget.visit(0)?;', ''),
]
with tempfile.TemporaryDirectory(prefix='pp-a6b-mutants-', dir='/persist/tmp') as directory:
    scratch = Path(directory) / 'rust'
    shutil.copytree(rust, scratch, ignore=shutil.ignore_patterns('target'))
    for sibling in rust.parent.iterdir():
        if sibling.name not in ('rust', '.git'):
            (scratch.parent / sibling.name).symlink_to(sibling)
    env = {**os.environ, 'CARGO_TARGET_DIR': str(Path(directory) / 'target')}
    command = ['cargo', 'nextest', 'run', '--locked', '--manifest-path', str(scratch / 'Cargo.toml'), '-p', 'pp-storage', '--features', 'desktop_rebuild', '--lib', '-E', 'test(working_drafts::preparation_tests)', '--test-threads=2']
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
