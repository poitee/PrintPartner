import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--bin-dir', type=Path, required=True)
parser.add_argument('--original-bin-dir', type=Path, required=True)
parser.add_argument('--frozen-output', type=Path, required=True)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=False)
rows = []


def sha(path):
    return hashlib.file_digest(path.open('rb'), 'sha256').hexdigest()


def inventory(root):
    return {p.relative_to(root).as_posix(): sha(p) for p in root.rglob('*') if p.is_file()}


def invoke(binary, command, label):
    result = subprocess.run([str(binary)], input=json.dumps(command), text=True, capture_output=True)
    row = dict(label=label, binary=str(binary), binarySha256=sha(binary), command=command,
               exitCode=result.returncode, stdout=result.stdout, stderr=result.stderr)
    rows.append(row)
    (args.output / 'receipts.json').write_text(json.dumps(rows, indent=2, ensure_ascii=False) + '\n')
    return result.returncode, json.loads(result.stdout)


def fixture(label, names):
    root = args.output / label
    (root / 'input').mkdir(parents=True)
    (root / 'repos').mkdir()
    with zipfile.ZipFile(root / 'input/upload.zip', 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name in names:
            archive.writestr(name, name.encode())
    archive_command = dict(tenantId='unicode-tenant', sourceId=42, reposDir=str(root / 'repos'),
                           inputDir=str(root / 'input'), zipPath='upload.zip', revisionKey='unicode-revision')
    snapshot_command = dict(tenantId='unicode-tenant', sourceId=42, reposDir=str(root / 'repos'),
                            inputDir=str(root / 'input'), reservedStoredBytes=100000,
                            maxContentBytes=100000, snapshot=dict(upstreamRevisionKey='unicode-revision',
                            files=[dict(path=name, kind='stl', sizeHintBytes=1) for name in names],
                            selection=dict(maxStlFiles=100, maxDocumentationBytes=100000, omittedFiles=[])))
    return root, archive_command, snapshot_command


cases = [
    ('sharp-s', ['Straße.stl', 'STRASSE.stl'], 'duplicate-entry'),
    ('sigma-capital-final', ['Σ.stl', 'ς.stl'], 'duplicate-entry'),
    ('sigma-small-final', ['σ.stl', 'ς.stl'], 'duplicate-entry'),
    ('ligature', ['ﬃ.stl', 'FFI.stl'], 'duplicate-entry'),
    ('canonical', ['café.stl', 'cafe\u0301.stl'], 'unsafe-entry'),
    ('nested-sharp-s', ['parts/Straße/a.stl', 'parts/STRASSE/b.stl'], 'duplicate-entry'),
    ('nested-sigma', ['parts/Σ/a.stl', 'parts/ς/b.stl'], 'duplicate-entry'),
    ('file-directory', ['Straße', 'STRASSE/a.stl'], 'duplicate-entry'),
]
for label, names, error in cases:
    root, archive_command, snapshot_command = fixture(label, names)
    before = sha(root / 'input/upload.zip')
    code, result = invoke(args.bin_dir / 'pp-source-archive', archive_command, label + '-archive')
    assert code == 1 and result.get('error') == error, (label, code, result)
    code, result = invoke(args.bin_dir / 'pp-source', snapshot_command, label + '-snapshot')
    assert code == 1 and ('duplicate-path' if error == 'duplicate-entry' else 'unsafe-path') in result.get('error', ''), (label, code, result)
    assert not (root / 'repos/42/revisions/unicode-revision').exists()
    assert not (root / 'repos/42/revisions/.pp-source-archives/.candidate').exists()
    assert sha(root / 'input/upload.zip') == before

root, archive_command, snapshot_command = fixture('legacy-ambiguous', ['Straße.stl', 'STRASSE.stl'])
code, original = invoke(args.original_bin_dir / 'pp-source-archive', archive_command, 'legacy-create')
assert code == 0 and original['snapshot']['publication'] == 'created'
accepted = root / 'repos/42/revisions/unicode-revision'
before = inventory(accepted)
snapshot_command['snapshot']['files'] = []
code, result = invoke(args.bin_dir / 'pp-source', snapshot_command, 'legacy-reuse-reject')
assert code == 1 and result['error'] == 'duplicate-path'
assert inventory(accepted) == before

root, archive_command, snapshot_command = fixture('ordinary-unicode', ['深い/café.stl', '深い/二.stl', '\U00010000.stl', '\ue000.stl', 'İ.stl', 'ı.stl', 'I.stl'])
code, result = invoke(args.bin_dir / 'pp-source-archive', archive_command, 'unicode-create')
assert code == 0 and result['snapshot']['publication'] == 'created'
assert [f['path'] for f in result['snapshot']['files']] == sorted([f['path'] for f in result['snapshot']['files']], key=lambda x: x.encode('utf-16-be'))
accepted = root / 'repos/42/revisions/unicode-revision'
before = inventory(accepted)
code, reused = invoke(args.bin_dir / 'pp-source-archive', archive_command, 'unicode-reuse')
assert code == 0 and reused['snapshot']['publication'] == 'reused'
assert reused['snapshot']['manifestDigest'] == result['snapshot']['manifestDigest']
snapshot_command['snapshot']['files'] = [dict(path='Straße.stl', kind='stl', sizeHintBytes=1), dict(path='STRASSE.stl', kind='stl', sizeHintBytes=1)]
code, rejected = invoke(args.bin_dir / 'pp-source', snapshot_command, 'accepted-survives-validation-failure')
assert code == 1 and rejected['error'] == 'duplicate-path'
assert inventory(accepted) == before

root, archive_command, snapshot_command = fixture('omitted-collision', ['Straße.stl'])
snapshot_command['snapshot']['selection']['omittedFiles'] = [dict(path='STRASSE.stl', kind='md', sizeHintBytes=1, reason='documentation-byte-budget')]
code, result = invoke(args.bin_dir / 'pp-source', snapshot_command, 'omitted-collision')
assert code == 1 and result['error'] == 'duplicate-path'

root = args.output / 'frozen-normal'
root.mkdir()
(root / 'repos').mkdir()
frozen = args.frozen_output / 'initial'
command = json.loads((frozen / 'rust-command.json').read_text())
command['reposDir'] = str(root / 'repos')
command['inputDir'] = str(frozen / 'input')
original = json.loads((frozen / 'rust.json').read_text())
code, result = invoke(args.bin_dir / 'pp-source-archive', command, 'frozen-node-fixture-create')
assert code == 0 and result == original
accepted = root / 'repos' / result['snapshot']['snapshotLocator']
original_root = frozen / 'repos' / original['snapshot']['snapshotLocator']
assert inventory(accepted) == inventory(original_root)
for entry in result['extraction']['files']:
    assert sha(accepted / entry['path']) == sha(frozen / 'node' / entry['path'])
code, result = invoke(args.bin_dir / 'pp-source-archive', command, 'frozen-node-fixture-reuse')
assert code == 0 and result['snapshot']['publication'] == 'reused'
assert result['snapshot']['manifestDigest'] == original['snapshot']['manifestDigest']
assert inventory(accepted) == inventory(original_root)
(args.output / 'result.json').write_text(json.dumps(dict(passed=True, publicCliRuns=len(rows), frozenNodeBytesExact=True, legacyBytesPreserved=True), indent=2) + '\n')
print(json.dumps(dict(passed=True, publicCliRuns=len(rows))))
