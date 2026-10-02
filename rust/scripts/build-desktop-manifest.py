import argparse
import hashlib
import json
import pathlib
import re
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--web', type=pathlib.Path, required=True)
parser.add_argument('--node', type=pathlib.Path, required=True)
parser.add_argument('--output', type=pathlib.Path, required=True)
parser.add_argument('--commit', required=True)
args = parser.parse_args()
if not re.fullmatch(r"[0-9a-f]{40}", args.commit):
    parser.error("--commit must be a full lowercase Git commit")
web = args.web.resolve(strict=True)

def digest(path):
    return hashlib.file_digest(path.open('rb'), 'sha256').hexdigest()

def inventory(root):
    root = root.resolve(strict=True)
    files = {}
    for path in sorted(root.rglob('*')):
        if path.is_file():
            if not path.resolve(strict=True).is_relative_to(root):
                raise ValueError('Artifact escapes its root')
            files[path.relative_to(root).as_posix()] = digest(path)
    if not files:
        raise ValueError('Empty artifact root')
    return files

metadata = ['package.json', 'package-lock.json', 'apps/server/package.json',
            'packages/contracts/package.json', 'packages/domain/package.json']
frontend = web / 'apps/web/dist'
desktop = json.loads((frontend / 'desktop-build.json').read_text())
if desktop['mode'] != 'desktop' or desktop['service_worker'] is not False:
    raise ValueError('Expected desktop frontend build')
version = json.loads((web / 'package.json').read_text())['version']
if desktop['version'] != version:
    raise ValueError('Frontend version mismatch')
manifest = {
    'schema': 1,
    'runtime_version': version + '-web',
    'commit': args.commit,
    'node_version': subprocess.check_output([str(args.node), '--version'], text=True).strip(),
    'node_sha256': digest(args.node),
    'frontend': inventory(frontend),
    'backend': inventory(web / 'apps/server/dist/current'),
    'contracts': inventory(web / 'packages/contracts/dist/current'),
    'domain': inventory(web / 'packages/domain/dist/current'),
    'metadata': {name: digest(web / name) for name in metadata},
}
encoded = (json.dumps(manifest, sort_keys=True, separators=(',', ':')) + '\n').encode()
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_bytes(encoded)
print(json.dumps({'manifest_sha256': hashlib.sha256(encoded).hexdigest(),
                  'measured_files': sum(len(manifest[key]) for key in ['frontend', 'backend', 'contracts', 'domain', 'metadata']) + 1,
                  'node_version': manifest['node_version']}))
