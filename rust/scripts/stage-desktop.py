import argparse
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys

parser = argparse.ArgumentParser()
parser.add_argument('--web', type=pathlib.Path, required=True)
parser.add_argument('--node', type=pathlib.Path, required=True)
parser.add_argument('--output', type=pathlib.Path, required=True)
parser.add_argument('--commit', required=True)
args = parser.parse_args()
source = args.web.resolve(strict=True)
stage = args.output.absolute()
if stage.exists():
    parser.error('Stage must be a new directory')
node_identity = json.loads(subprocess.check_output([str(args.node), '-p',
    'JSON.stringify({version:process.version,abi:process.versions.modules,os:process.platform,arch:process.arch})'], text=True))
if node_identity['version'] != 'v24.21.0' or node_identity['abi'] != '137':
    parser.error('Node 24.21.0 ABI 137 is required')
system = {'darwin': 'macos', 'linux': 'linux'}.get(node_identity['os'])
arch = {'x64': 'x86_64', 'arm64': 'aarch64'}.get(node_identity['arch'])
if not system or not arch or system != ('macos' if sys.platform == 'darwin' else sys.platform):
    parser.error('Stage requires the target-native Node runtime')
web_relative = pathlib.Path('Resources/desktop-runtime/web' if system == 'macos' else 'web')
node_relative = pathlib.Path('MacOS/printpartner-node' if system == 'macos' else 'bin/node')
web = stage / web_relative
node = stage / node_relative
node.parent.mkdir(parents=True)
shutil.copy2(args.node, node)
for path in ['apps/server/dist/current', 'apps/web/dist', 'packages/contracts/dist/current', 'packages/domain/dist/current']:
    shutil.copytree(source / path, web / path)
for path in ['package.json', 'package-lock.json', 'apps/server/package.json', 'apps/web/package.json',
             'packages/contracts/package.json', 'packages/domain/package.json']:
    target = web / path
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source / path, target)
lock = json.loads((source / 'package-lock.json').read_text())
for name, package in lock['packages'].items():
    if 'node_modules/' not in name or package.get('dev'):
        continue
    original = source / name
    target = web / name
    if original.is_symlink():
        target.parent.mkdir(parents=True, exist_ok=True)
        target.symlink_to(os.readlink(original))
    elif original.is_dir() and not target.exists():
        shutil.copytree(original, target, symlinks=True, ignore=shutil.ignore_patterns('node_modules'))
    elif not original.exists() and not package.get('optional'):
        raise ValueError('Locked runtime dependency missing: '+name)
for name, relative in [('contracts', 'packages/contracts'), ('domain', 'packages/domain')]:
    alias = web / 'node_modules/@print-partner' / name
    if not alias.exists():
        alias.parent.mkdir(parents=True, exist_ok=True)
        alias.symlink_to(os.path.relpath(web / relative, alias.parent))
if system == 'macos':
    frameworks = stage / 'Frameworks'
    frameworks.mkdir()
    for addon in list(web.rglob('*.node')):
        name = hashlib.sha256(addon.relative_to(web).as_posix().encode()).hexdigest()[:12]+'_'+addon.name
        destination = frameworks / name
        shutil.move(addon, destination)
        addon.symlink_to(os.path.relpath(destination, addon.parent))
subprocess.run([str(node), '-e',
    "const Database=require('better-sqlite3');const db=new Database(':memory:');"
    "if(db.prepare('SELECT 42 answer').get().answer!==42)process.exit(1);db.close();"], cwd=web, check=True)
package = json.loads((web / 'package.json').read_text())
release = {'runtime_version': package['version']+'-web', 'commit': args.commit,
           'node': node_relative.as_posix(), 'web': web_relative.as_posix(), 'os': system,
           'arch': arch, 'node_version': node_identity['version'], 'node_abi': node_identity['abi']}
identity_path = stage / ('Resources/desktop-runtime/release.json' if system == 'macos' else 'release.json')
identity_path.write_text(json.dumps(release, sort_keys=True)+'\n')
if system == 'macos':
    native_config = json.loads((pathlib.Path(__file__).resolve().parents[1] / 'crates/pp-desktop/tauri.conf.json').read_text())
    bundle = {'resources': {str(stage / 'Resources/desktop-runtime'): 'desktop-runtime'},
              'macOS': {'minimumSystemVersion': native_config['bundle']['macOS']['minimumSystemVersion'],
                        'files': {str(path.relative_to(stage)): str(path)
                                  for directory in ['MacOS', 'Frameworks']
                                  for path in (stage / directory).iterdir() if path.is_file()}}}
else:
    bundle = {'resources': {str(stage / 'web'): 'desktop-runtime/web',
                            str(stage / 'bin'): 'desktop-runtime/bin',
                            str(stage / 'release.json'): 'desktop-runtime/release.json'}}
bundle.update({'active': True, 'icon': [str(pathlib.Path(__file__).resolve().parents[1] / 'crates/pp-desktop/icons/icon.png')]})
(stage / 'bundle-config.json').write_text(json.dumps({'bundle': bundle}, sort_keys=True)+'\n')
manifest = stage / 'bundle-manifest.json'
subprocess.run([sys.executable, str(pathlib.Path(__file__).with_name('build-desktop-manifest.py')),
    '--web', str(web), '--node', str(node), '--package-root', str(stage), '--output', str(manifest),
    '--commit', args.commit], check=True)
print(json.dumps({'stage': str(stage), 'release': release, 'sqlite_answer': 42,
                  'signed': False, 'manifest': str(manifest)}))
