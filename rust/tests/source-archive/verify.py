import argparse
import hashlib
import io
import json
from pathlib import Path
import struct
import subprocess
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--binary', type=Path, required=True)
parser.add_argument('--node', type=Path, required=True)
parser.add_argument('--node-archive', type=Path, required=True)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=False)
args.output = args.output.resolve()
args.binary = args.binary.resolve()
rows = []
DEFAULT = {'maxCompressedBytes': 256 * 1024**2, 'maxInflatedBytes': 1024**3, 'maxEntries': 10000}
oracle = Path(__file__).resolve().parents[1] / 'source-artifacts/node-archive-oracle.mjs'

def sha(path):
    with path.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()

def make(case, entries, compression=zipfile.ZIP_DEFLATED):
    folder = args.output / case
    folder.mkdir()
    archive = folder / 'upload.zip'
    with zipfile.ZipFile(archive, 'w', compression=compression) as writer:
        for name, data in entries:
            writer.writestr(name, data)
    return archive

def invoke(case, archive, limits=None, prefix=None, revision='archive-revision', repos=None, rust=True):
    limits = limits or DEFAULT
    root = args.output / case
    root.mkdir(exist_ok=True)
    repos = repos or root / 'repos'
    repos.mkdir(exist_ok=True)
    command = {'tenantId': 'archive-tenant', 'sourceId': 42, 'reposDir': str(repos), 'inputDir': str(archive.parent), 'zipPath': archive.name, 'revisionKey': revision, 'limits': limits}
    if rust:
        cmd = [str(args.binary)]
        engine = 'rust'
    else:
        command = {'zip': str(archive), 'destination': str(root / 'node'), 'limits': {'maxEntries': limits['maxEntries'], 'maxUncompressedBytes': limits['maxInflatedBytes']}}
        if case == 'compressed-limit':
            command.update(operation='upload', maxBytes=limits['maxCompressedBytes'])
        cmd = [str(args.node), str(oracle), str(args.node_archive)]
        engine = 'node'
    result = subprocess.run((prefix or []) + cmd, input=json.dumps(command), capture_output=True, text=True)
    (root / f'{engine}-command.json').write_text(json.dumps(command, indent=2))
    (root / f'{engine}.json').write_text(result.stdout)
    (root / f'{engine}.stderr').write_text(result.stderr)
    parsed = json.loads(result.stdout) if result.stdout else {'processExit': result.returncode}
    return result.returncode, parsed, repos

def run_case(case, archive, accepted, limits=None, parity=True):
    before = sha(archive)
    nc, node, _ = invoke(case, archive, limits, rust=False)
    rc, result, repos = invoke(case, archive, limits)
    assert (rc == 0) == accepted, (case, rc, result)
    assert sha(archive) == before
    assert not (repos / '42/revisions/.pp-source-archives/.candidate').exists(), case
    if accepted:
        assert nc == 0, (case, node)
        receipt = result['extraction']
        assert receipt['archiveSha256'] == before and receipt['compressedBytes'] == archive.stat().st_size
        expected_files = []
        node_root = args.output / case / 'node'
        for path in node_root.rglob('*'):
            if path.is_file():
                expected_files.append({'path': path.relative_to(node_root).as_posix(), 'sizeBytes': path.stat().st_size, 'sha256': sha(path)})
        order = lambda entry: entry['path'].encode('utf-16-be')
        assert sorted(expected_files, key=order) == receipt['files'], case
        directories = [path.relative_to(node_root).as_posix() for path in node_root.rglob('*') if path.is_dir()]
        assert sorted(directories, key=lambda s: s.encode('utf-16-be')) == receipt['directories'], (case, directories, receipt)
        assert receipt['stlCount'] == node['result']
        for entry in receipt['files']:
            published = repos / result['snapshot']['snapshotLocator'] / entry['path']
            assert sha(published) == entry['sha256']
    elif parity:
        assert nc != 0, (case, node)
    rows.append({'case': case, 'rustAccepted': rc == 0, 'nodeAccepted': nc == 0, 'rust': result.get('error', 'accepted'), 'node': node.get('error', 'accepted'), 'passed': True})
    return result, repos

normal = [('parts/', b''), ('parts/深い/', b''), ('empty/', b''), ('parts/深い/café bracket.stl', b'solid cafe'), ('notes/README.md', b'# notes'), ('empty.stl', b''), ('opaque.3mf', b'opaque project bytes')]
for compression, case in [(zipfile.ZIP_STORED, 'stored'), (zipfile.ZIP_DEFLATED, 'deflated')]:
    run_case(case, make(case, normal, compression), True)
for case, entries in [('empty-archive', []), ('directories-only', [('empty/', b'')])]:
    run_case(case, make(case, entries), True)
class NonSeeking(io.BytesIO):
    def seekable(self): return False
    def seek(self, *args): raise io.UnsupportedOperation('non-seeking ZIP fixture')

stream = NonSeeking()
with zipfile.ZipFile(stream, 'w', compression=zipfile.ZIP_DEFLATED) as writer:
    writer.writestr('descriptor.stl', b'data descriptor body')
archive = make('data-descriptor', [])
archive.write_bytes(stream.getvalue())
run_case('data-descriptor', archive, True)
archive = make('directory-after-child', [('parts/part.stl', b'part'), ('parts/', b'')])
run_case('directory-after-child', archive, True)
for case, entries, parity in [
    ('duplicate', [('same.stl', b'first'), ('same.stl', b'last')], False),
    ('normalized-duplicate', [('parts/./part.stl', b'first'), ('parts/part.stl', b'last')], False),
    ('case-fold-duplicate', [('Part.stl', b'first'), ('part.stl', b'last')], False),
    ('directory-case-conflict', [('Part/a.stl', b'a'), ('part/b.stl', b'b')], False),
    ('traversal', [('../outside.stl', b'escape')], True),
    ('absolute', [('/absolute.stl', b'absolute')], False),
    ('backslash', [('parts\\part.stl', b'backslash')], False),
    ('control', [('line\nbreak.stl', b'newline')], False),
    ('prefix-conflict', [('part.stl', b'file'), ('part.stl/nested.stl', b'child')], True),
    ('directory-duplicate', [('parts/', b''), ('parts/', b'')], False),
]:
    run_case(case, make(case, entries), False, parity=parity)
archive = make('symlink-entry', [])
with zipfile.ZipFile(archive, 'w') as writer:
    info = zipfile.ZipInfo('shortcut.stl'); info.create_system = 3; info.external_attr = 0o120777 << 16
    writer.writestr(info, b'../../outside.stl')
run_case('symlink-entry', archive, False, parity=False)
for case, field, value in [('compressed-limit', 'maxCompressedBytes', 1), ('inflated-limit', 'maxInflatedBytes', 3), ('entry-limit', 'maxEntries', 1)]:
    archive = make(case, [('a.stl', b'a' * 64), ('b.stl', b'b' * 64)])
    run_case(case, archive, False, {**DEFAULT, field: value})
for case in ['forged-inflated-limit', 'crc', 'truncated', 'truncated-body', 'corrupt-central', 'encrypted-flag', 'non-utf8', 'local-central-name-mismatch', 'forged-central-count']:
    archive = make(case, [('plain.stl', b'x' * 4096)])
    data = bytearray(archive.read_bytes()); central = data.index(b'PK\x01\x02')
    limits = None
    if case == 'forged-inflated-limit':
        struct.pack_into('<I', data, 22, 1); struct.pack_into('<I', data, central + 24, 1)
        limits = {**DEFAULT, 'maxInflatedBytes': 10}
    elif case == 'crc':
        struct.pack_into('<I', data, 14, 123); struct.pack_into('<I', data, central + 16, 123)
    elif case == 'truncated': data = data[:-12]
    elif case == 'truncated-body': data = data[:40]
    elif case == 'corrupt-central': data[central] = 0
    elif case == 'encrypted-flag':
        struct.pack_into('<H', data, 6, 1); struct.pack_into('<H', data, central + 8, 1)
    elif case == 'non-utf8': data[30] = 0x82; data[central + 46] = 0x82
    elif case == 'local-central-name-mismatch': data[30:39] = b'../a.stl '
    elif case == 'forged-central-count':
        end = data.index(b'PK\x05\x06'); struct.pack_into('<H', data, end + 8, 0); struct.pack_into('<H', data, end + 10, 0)
    archive.write_bytes(data)
    run_case(case, archive, False, limits, parity=False)
run_case('bzip2', make('bzip2', [('part.stl', b'data')], zipfile.ZIP_BZIP2), False)

for size in [1, 32]:
    case = f'memory-{size}'
    archive = make(case, [])
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as writer:
        with writer.open('model.stl', 'w') as member:
            for _ in range(size): member.write(b'x' * 1024**2)
    before = sha(archive)
    times = {}
    for engine in ['node', 'rust']:
        timing = args.output / case / f'{engine}.time'
        code, result, _ = invoke(case, archive, prefix=['/usr/bin/time', '-f', '%M', '-o', str(timing)], rust=engine == 'rust')
        assert code == 0, result
        times[engine] = int(timing.read_text())
    result = json.loads((args.output / case / 'rust.json').read_text())
    assert result['extraction']['inflatedBytes'] == size * 1024**2
    assert sha(archive) == before
    for entry in result['extraction']['files']:
        assert entry['sha256'] == sha(args.output / case / 'node' / entry['path'])
    assert times['rust'] < 32 * 1024
    rows.append({'case': case, 'inflatedBytes': size * 1024**2, 'compressedBytes': archive.stat().st_size, 'maxRssKiB': times, 'passed': True})

archive = make('crash-extraction', [('model.stl', b'x' * 8 * 1024**2)])
trace = args.output / 'crash-extraction' / 'kill.strace'
code, result, repos = invoke('crash-extraction', archive, prefix=['strace', '-o', str(trace), '-e', 'trace=write,renameat2,fsync', '-e', 'inject=write:signal=SIGKILL:when=3'])
assert code != 0 and 'killed by SIGKILL' in trace.read_text()
assert (repos / '42/revisions/.pp-source-archives/.candidate').is_dir()
assert not (repos / '42/revisions/archive-revision').exists()
code, result, _ = invoke('crash-extraction-retry', archive, repos=repos)
assert code == 0 and not (repos / '42/revisions/.pp-source-archives/.candidate').exists()
assert result['snapshot']['publication'] == 'created'
accepted = repos / result['snapshot']['snapshotLocator'] / 'model.stl'
before = sha(accepted)
code, result, _ = invoke('immutable-repeat', archive, repos=repos)
assert code == 0 and result['snapshot']['publication'] == 'reused' and sha(accepted) == before
rows.append({'case': 'SIGKILL-retry-cleanup-and-immutable-repeat', 'passed': True})

archive = args.output / 'deflated/upload.zip'
trace = args.output / 'read-error-baseline.strace'
code, _, _ = invoke('read-error-baseline', archive, prefix=['strace', '-yy', '-o', str(trace), '-e', 'trace=read'])
assert code == 0
reads = [line for line in trace.read_text().splitlines() if line.startswith('read(')]
index = next(i + 1 for i, line in enumerate(reads) if str(archive) in line)
trace = args.output / 'read-error-injected.strace'
code, result, repos = invoke('read-error-injected', archive, prefix=['strace', '-yy', '-o', str(trace), '-e', 'trace=read', '-e', f'inject=read:error=EIO:when={index}'])
assert code != 0 and 'Input/output error' in result['error'], (code, result, trace.read_text())
assert not (repos / '42/revisions/.pp-source-archives/.candidate').exists()
rows.append({'case': 'injected-input-read-EIO', 'passed': True})

manifest = []
for path in sorted(args.output.rglob('*')):
    if path.is_file() and not path.is_symlink():
        manifest.append({'path': path.relative_to(args.output).as_posix(), 'bytes': path.stat().st_size, 'sha256': sha(path)})
(args.output / 'manifest.json').write_text(json.dumps(manifest, indent=2, ensure_ascii=False))
(args.output / 'checks.json').write_text(json.dumps(rows, indent=2, ensure_ascii=False))
print(json.dumps({'passed': len(rows), 'bytes': sum(row['bytes'] for row in manifest), 'memory': [row for row in rows if 'maxRssKiB' in row]}, indent=2))
