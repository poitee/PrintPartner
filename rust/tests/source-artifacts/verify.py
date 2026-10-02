import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--node', type=Path, required=True)
parser.add_argument('--node-snapshot', type=Path, required=True)
parser.add_argument('--binary', type=Path, required=True)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=False)
args.output = args.output.resolve()
args.binary = args.binary.resolve()
fixture = args.output / 'fixtures'
fixture.mkdir()
input_dir = fixture / 'input'
input_dir.mkdir()
rows = []
results = {}
base = {
    'tenantId': 'fixture-tenant', 'sourceId': 42, 'inputDir': str(input_dir),
    'reservedStoredBytes': 2 * 1024**3,
    'snapshot': {'upstreamRevisionKey': '8a18a2e8-6266-40dc-a9a6-4305736052af', 'files': [],
                 'selection': {'maxStlFiles': 500, 'maxDocumentationBytes': 1024**3, 'omittedFiles': []}},
}
for name, data in [('parts/café bracket.stl', b'solid cafe\nendsolid cafe\n'), ('parts/nested/clip.STL', b'solid clip'), ('README.md', b'# Notes\n'), ('😀.stl', b'astral'), ('\ue000.stl', b'bmp')]:
    path = input_dir / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
for name in ['parts/assembly.3mf', 'original.zip']:
    with zipfile.ZipFile(input_dir / name, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('3D/3dmodel.model' if name.endswith('3mf') else 'parts/part.stl', 'model bytes')
for path in input_dir.rglob('*'):
    if path.is_file():
        base['snapshot']['files'].append({'path': path.relative_to(input_dir).as_posix(), 'kind': 'stl' if path.suffix.lower() == '.stl' else 'readme' if path.name == 'README.md' else 'artifact', 'sizeHintBytes': None})

def invoke(case, engine, command, expect=True, prefix=None):
    command = copy.deepcopy(command)
    repo = fixture / case / engine
    repo.mkdir(parents=True, exist_ok=True)
    command.setdefault('reposDir', str(repo))
    commands = [str(args.binary)] if engine == 'rust' else [str(args.node), str(Path(__file__).with_name('node-oracle.mjs')), str(args.node_snapshot)]
    if prefix:
        commands = prefix + commands
    raw = json.dumps(command, ensure_ascii=False)
    result = subprocess.run(commands, input=raw, text=True, capture_output=True)
    (args.output / f'{case}-{engine}-command.json').write_text(raw)
    (args.output / f'{case}-{engine}.json').write_text(result.stdout)
    (args.output / f'{case}-{engine}.stderr').write_text(result.stderr)
    parsed = json.loads(result.stdout) if result.stdout else {}
    if expect is not None:
        assert (result.returncode == 0) == expect, (case, engine, result.returncode, parsed, result.stderr)
    results[case, engine] = parsed
    return parsed

def compare(case, command=base, expect=True):
    node = invoke(case, 'node', command, expect)
    rust = invoke(case, 'rust', command, expect)
    if expect:
        for key in ['upstreamRevisionKey', 'manifestDigest', 'snapshotLocator', 'files', 'selection', 'publication']:
            assert node[key] == rust[key], (case, key, node, rust)
        for file in node['files']:
            first = fixture / case / 'node' / node['snapshotLocator'] / file['path']
            second = fixture / case / 'rust' / rust['snapshotLocator'] / file['path']
            assert first.read_bytes() == second.read_bytes()
    rows.append({'case': case, 'expectation': 'parity-success' if expect else 'both-reject', 'passed': True})
    return node, rust

node, rust = compare('nested-unicode-archive-bytes')
for engine, other in [('rust', 'node'), ('node', 'rust')]:
    command = copy.deepcopy(base)
    command['reposDir'] = str(fixture / 'nested-unicode-archive-bytes' / other)
    reused = invoke('cross-load', engine, command)
    assert reused['publication'] == 'reused' and reused['manifestDigest'] == node['manifestDigest']
rows.append({'case': 'cross-load-node-rust-manifests', 'passed': True})
old_bytes = (input_dir / 'parts/café bracket.stl').read_bytes()
(input_dir / 'parts/café bracket.stl').write_bytes(b'changed geometry')
for engine in ['node', 'rust']:
    command = copy.deepcopy(base)
    command['reposDir'] = str(fixture / 'nested-unicode-archive-bytes' / engine)
    reused = invoke('same-revision-changed-input', engine, command)
    assert reused['publication'] == 'reused' and reused['manifestDigest'] == node['manifestDigest']
    command['snapshot']['upstreamRevisionKey'] = 'new-revision-uuid-owned-by-caller'
    new = invoke('changed-revision', engine, command)
    assert new['manifestDigest'] != node['manifestDigest']
    assert (Path(command['reposDir']) / node['snapshotLocator'] / 'parts/café bracket.stl').read_bytes() == old_bytes
rows.append({'case': 'immutable-reuse-and-new-revision', 'passed': True})
(input_dir / 'parts/café bracket.stl').write_bytes(old_bytes)

(input_dir / 'part.stl').write_bytes(b'prefix conflict fixture')
for case, paths in [
    ('traversal', ['../escape.stl']), ('absolute', ['/outside.stl']),
    ('backslash', ['parts\\part.stl']), ('nfd', ['cafe\u0301.stl']),
    ('duplicate', ['same.stl', 'same.stl']), ('case-collision', ['Part.stl', 'part.stl']),
    ('prefix-conflict', ['part.stl', 'part.stl/child.stl']),
    ('reserved', ['.printpartner-source-snapshot.json']),
]:
    command = copy.deepcopy(base)
    command['snapshot']['files'] = [{'path': path, 'kind': 'stl', 'sizeHintBytes': None} for path in paths]
    compare(case, command, False)
for case, field, value in [('stl-limit', 'maxStlFiles', 0), ('docs-limit', 'maxDocumentationBytes', 0)]:
    command = copy.deepcopy(base)
    command['snapshot']['selection'][field] = value
    compare(case, command, False)
for case, field in [('content-limit', 'maxContentBytes'), ('reservation-limit', 'reservedStoredBytes')]:
    command = copy.deepcopy(base)
    command[field] = 10
    invoke(case, 'rust', command, False)
    assert not (fixture / case / 'rust' / '42/revisions/.pp-source-candidate').exists()
    rows.append({'case': case, 'passed': True})
command = copy.deepcopy(base)
command['snapshot']['files'] = []
command['reservedStoredBytes'] = 0
invoke('manifest-reservation-limit', 'rust', command, False)
rows.append({'case': 'manifest-reservation-limit', 'passed': True})

outside = fixture / 'outside'
outside.mkdir()
(outside / 'part.stl').write_text('outside sentinel')
(input_dir / 'escape').symlink_to(outside, target_is_directory=True)
command = copy.deepcopy(base)
command['snapshot']['files'] = [{'path': 'escape/part.stl', 'kind': 'stl', 'sizeHintBytes': None}]
invoke('symlink-input', 'node', command, True)
invoke('symlink-input', 'rust', command, False)
assert (outside / 'part.stl').read_text() == 'outside sentinel'
rows.append({'case': 'symlink-input', 'expectation': 'intentional-reject-node-opener-follows', 'passed': True})
for level in ['root', 'source', 'revisions']:
    repo = fixture / f'symlink-{level}' / 'rust'
    repo.mkdir(parents=True)
    if level == 'root':
        repo.rmdir(); repo.symlink_to(outside, target_is_directory=True)
    elif level == 'source':
        (repo / '42').symlink_to(outside, target_is_directory=True)
    else:
        (repo / '42').mkdir(); (repo / '42/revisions').symlink_to(outside, target_is_directory=True)
    invoke(f'symlink-{level}', 'rust', base, False)
    rows.append({'case': f'symlink-{level}', 'passed': True})
assert sorted(p.name for p in outside.iterdir()) == ['part.stl']

for tamper in ['bytes', 'extra-file', 'empty-dir', 'manifest-link']:
    for engine in ['node', 'rust']:
        repo = fixture / f'tamper-{tamper}' / engine
        shutil.copytree(fixture / 'nested-unicode-archive-bytes' / engine, repo)
        published = repo / node['snapshotLocator']
        if tamper == 'bytes': (published / 'README.md').write_text('tampered')
        elif tamper == 'extra-file': (published / 'extra.stl').write_text('extra')
        elif tamper == 'empty-dir': (published / 'unexpected').mkdir()
        else:
            manifest = published / '.printpartner-source-snapshot.json'
            target = outside / f'{engine}-manifest.json'
            shutil.copyfile(manifest, target)
            manifest.unlink(); manifest.symlink_to(target)
        invoke(f'tamper-{tamper}', engine, base, False)
    rows.append({'case': f'tamper-{tamper}', 'passed': True})

for megabytes in [16, 192]:
    large_input = fixture / f'large-{megabytes}' / 'input'
    large_input.mkdir(parents=True)
    archive_path = large_input / 'large.zip'
    with zipfile.ZipFile(archive_path, 'w', zipfile.ZIP_STORED) as archive:
        with archive.open('nested/model.stl', 'w') as model:
            for _ in range(megabytes): model.write(b'x' * 1024**2)
    command = copy.deepcopy(base)
    command['inputDir'] = str(large_input)
    command['snapshot']['files'] = [{'path': 'large.zip', 'kind': 'artifact', 'sizeHintBytes': None}]
    for engine in ['node', 'rust']:
        timing = args.output / f'large-{megabytes}-{engine}.time'
        invoke(f'large-{megabytes}', engine, command, True, ['/usr/bin/time', '-f', '%M', '-o', str(timing)])
    assert results[f'large-{megabytes}', 'rust']['manifestDigest'] == results[f'large-{megabytes}', 'node']['manifestDigest']
    rows.append({'case': f'large-{megabytes}-opaque-zip', 'rustMaxRssKiB': int((args.output / f'large-{megabytes}-rust.time').read_text()), 'nodeMaxRssKiB': int((args.output / f'large-{megabytes}-node.time').read_text()), 'passed': True})
assert int((args.output / 'large-192-rust.time').read_text()) < 64 * 1024

small = copy.deepcopy(base)
small['snapshot']['files'] = [{'path': 'README.md', 'kind': 'readme', 'sizeHintBytes': None}]
for stage, injection, command in [
    ('mid-copy', 'write:signal=SIGKILL:when=2', command),
    ('before-rename', 'renameat2:signal=SIGKILL:when=1', small),
    ('after-durable-rename', 'write:signal=SIGKILL:when=3', small),
]:
    trace = args.output / f'{stage}.strace'
    invoke(stage, 'rust', command, None, ['strace', '-o', str(trace), '-e', 'trace=write,fsync,renameat2', '-e', f'inject={injection}'])
    repo = fixture / stage / 'rust'
    final = repo / '42/revisions' / command['snapshot']['upstreamRevisionKey']
    assert final.exists() == (stage == 'after-durable-rename'), (stage, trace.read_text())
    assert 'killed by SIGKILL' in trace.read_text()
    retry = invoke(stage + '-retry', 'rust', {**command, 'reposDir': str(repo)})
    assert retry['publication'] == ('reused' if stage == 'after-durable-rename' else 'created')
    assert not (repo / '42/revisions/.pp-source-candidate').exists()
    rows.append({'case': stage, 'publicationOnRetry': retry['publication'], 'passed': True})

case = 'concurrent-same-source'
repo = fixture / case / 'rust'
repo.mkdir(parents=True)
command = {**base, 'reposDir': str(repo)}
workers = [subprocess.Popen([str(args.binary)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(4)]
for worker in workers:
    worker.stdin.write(json.dumps(command)); worker.stdin.close()
receipts = []
for worker in workers:
    receipts.append(json.loads(worker.stdout.read())); assert worker.wait() == 0
assert sorted(item['publication'] for item in receipts) == ['created', 'reused', 'reused', 'reused']
(args.output / 'concurrent-receipts.json').write_text(json.dumps(receipts, indent=2))
rows.append({'case': case, 'passed': True})

manifest = []
for path in sorted(args.output.rglob('*')):
    if path.is_file() and not path.is_symlink():
        digest = hashlib.file_digest(path.open('rb'), 'sha256').hexdigest()
        manifest.append({'path': str(path.relative_to(args.output)), 'bytes': path.stat().st_size, 'sha256': digest})
(args.output / 'manifest.json').write_text(json.dumps(manifest, indent=2, ensure_ascii=False))
(args.output / 'checks.json').write_text(json.dumps(rows, indent=2))
print(json.dumps({'passed': len(rows), 'output': str(args.output), 'memory': [r for r in rows if 'rustMaxRssKiB' in r]}, indent=2))
