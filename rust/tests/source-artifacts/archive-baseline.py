import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--node', required=True)
parser.add_argument('--node-archive', required=True)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=False)
rows = []
for case, names in [
    ('nested', ['parts/é space.stl', 'parts/nested/project.3mf']),
    ('duplicate-normalized', ['parts/./part.stl', 'parts/part.stl']),
    ('traversal', ['../outside.stl']), ('absolute', ['/absolute.stl']),
    ('symlink-entry', ['shortcut.stl']), ('inflated-limit', ['huge.stl']),
    ('compressed-limit', ['part.stl']), ('entry-limit', ['a.stl', 'b.stl']),
]:
    archive = args.output / f'{case}.zip'
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as writer:
        for index, name in enumerate(names):
            info = zipfile.ZipInfo(name)
            info.compress_type = zipfile.ZIP_DEFLATED
            if case == 'symlink-entry': info.create_system = 3; info.external_attr = 0o120777 << 16
            writer.writestr(info, b'x' * 65536 if case == 'inflated-limit' else b'../outside.stl' if case == 'symlink-entry' else f'bytes-{index}'.encode())
    destination = args.output / case
    command = {'zip': str(archive), 'destination': str(destination), 'limits': {}}
    if case == 'inflated-limit': command['limits']['maxUncompressedBytes'] = 10
    if case == 'entry-limit': command['limits']['maxEntries'] = 1
    if case == 'compressed-limit': command.update(operation='upload', maxBytes=1)
    result = subprocess.run([args.node, str(Path(__file__).with_name('node-archive-oracle.mjs')), args.node_archive], input=json.dumps(command), capture_output=True, text=True)
    (args.output / f'{case}-command.json').write_text(json.dumps(command))
    (args.output / f'{case}-node.json').write_text(result.stdout)
    observed = json.loads(result.stdout)
    accepted = case in ['nested', 'duplicate-normalized', 'absolute', 'symlink-entry']
    assert (result.returncode == 0) == accepted, (case, result.stderr, observed)
    if destination.is_dir():
        observed['files'] = [{'path': str(file.relative_to(destination)), 'sha256': hashlib.sha256(file.read_bytes()).hexdigest(), 'symlink': file.is_symlink()} for file in destination.rglob('*') if file.is_file()]
    rows.append({'case': case, 'node': observed, 'rust': 'not-implemented-extraction-outside-this-unit'})
(args.output / 'observations.json').write_text(json.dumps(rows, indent=2, ensure_ascii=False))
print(json.dumps({'nodeArchiveObservations': len(rows), 'rustExtractionClaim': False}))
