import argparse
import hashlib
import json
import pathlib
import re
import os
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--web', type=pathlib.Path, required=True)
parser.add_argument('--node', type=pathlib.Path, required=True)
parser.add_argument('--output', type=pathlib.Path, required=True)
parser.add_argument('--commit', required=True)
parser.add_argument('--package-root', type=pathlib.Path)
args = parser.parse_args()
if not re.fullmatch(r"[0-9a-f]{40}", args.commit):
    parser.error("--commit must be a full lowercase Git commit")
web = args.web.resolve(strict=True)
package_root = (args.package_root or web).resolve(strict=True)
web_path = web.relative_to(package_root).as_posix()

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

def dependencies():
    roots = []
    files = {}
    links = {}
    pending = []
    visited = set()
    search = {web / 'node_modules', web / 'apps/node_modules', web / 'packages/node_modules'}
    ancestor = web.parent
    while ancestor.is_relative_to(package_root):
        search.add(ancestor / 'node_modules')
        if ancestor == package_root:
            break
        ancestor = ancestor.parent
    for workspace in [*(path for path in web.glob('apps/*') if path.is_dir() and path.name != 'node_modules'),
                      *(path for path in web.glob('packages/*') if path.is_dir() and path.name != 'node_modules')]:
        for directory in [workspace, workspace / 'dist', workspace / 'dist/current']:
            search.add(directory / 'node_modules')
    for directory in sorted(search):
        roots.append(directory.relative_to(package_root).as_posix())
        if not directory.exists():
            continue
        pending.append(directory)
    while pending:
        directory = pending.pop().resolve(strict=True)
        if not directory.is_relative_to(package_root):
            raise ValueError('Dependency root escapes package root')
        if directory in visited:
            continue
        visited.add(directory)
        for path in directory.iterdir():
            relative = path.relative_to(package_root).as_posix()
            if path.is_symlink():
                target = path.resolve(strict=True)
                if not target.is_relative_to(package_root):
                    raise ValueError('Dependency link escapes package root')
                link = os.readlink(path)
                if pathlib.Path(link).is_absolute():
                    raise ValueError('Dependency link must be relative')
                links[relative] = link
                if target.is_file():
                    files[target.relative_to(package_root).as_posix()] = digest(target)
                elif target.is_dir():
                    pending.append(target)
                else:
                    raise ValueError('Dependency link target is not a file or directory')
            elif path.is_file():
                files[relative] = digest(path)
            elif path.is_dir():
                pending.append(path)
            else:
                raise ValueError('Dependency entry is not a file or directory')
    if not files or not roots:
        raise ValueError('Runtime dependencies unavailable')
    return {'web_path': web_path, 'roots': sorted(roots), 'files': files, 'links': links}

metadata = ['package.json', 'package-lock.json', 'apps/server/package.json',
            'apps/web/package.json', 'packages/contracts/package.json',
            'packages/domain/package.json']
frontend = web / 'apps/web/dist'
desktop = json.loads((frontend / 'desktop-build.json').read_text())
if desktop['mode'] != 'desktop' or desktop['service_worker'] is not False:
    raise ValueError('Expected desktop frontend build')
version = json.loads((web / 'package.json').read_text())['version']
if desktop['version'] != version:
    raise ValueError('Frontend version mismatch')
backend = inventory(web / 'apps/server/dist/current')
if 'desktop-resolution.js' not in backend:
    raise ValueError('Measured desktop resolution preload missing')
manifest = {
    'schema': 1,
    'runtime_version': version + '-web',
    'commit': args.commit,
    'node_version': subprocess.check_output([str(args.node), '--version'], text=True).strip(),
    'node_sha256': digest(args.node),
    'frontend': inventory(frontend),
    'backend': backend,
    'contracts': inventory(web / 'packages/contracts/dist/current'),
    'domain': inventory(web / 'packages/domain/dist/current'),
    'metadata': {name: digest(web / name) for name in metadata},
    'dependencies': dependencies(),
}
encoded = (json.dumps(manifest, sort_keys=True, separators=(',', ':')) + '\n').encode()
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_bytes(encoded)
print(json.dumps({'manifest_sha256': hashlib.sha256(encoded).hexdigest(),
                  'measured_files': sum(len(manifest[key]) for key in ['frontend', 'backend', 'contracts', 'domain', 'metadata']) + 1,
                  'dependency_files': len(manifest['dependencies']['files']),
                  'dependency_links': len(manifest['dependencies']['links']),
                  'node_version': manifest['node_version']}))
