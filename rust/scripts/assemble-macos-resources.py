#!/usr/bin/env python3
import argparse
from dataclasses import dataclass
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import shutil
import tempfile

spec = importlib.util.spec_from_file_location('bundle_inventory', Path(__file__).with_name('check-macos-bundle.py'))
inventory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inventory)
require = inventory.require
RUNTIME = 'Resources/desktop-runtime'


@dataclass(frozen=True)
class CompletedMeasuredStage:
    root: Path
    manifest_bytes: bytes
    manifest: dict
    architecture: str
    runtime_files: dict
    runtime_links: dict
    native_files: dict


@dataclass(frozen=True)
class FreshUnsignedApp:
    contents: Path
    runtime_destination: Path


def tree(root, directory):
    files, links, directories = {}, {}, set()
    pending = [directory]
    while pending:
        folder = pending.pop()
        require(not folder.is_symlink(), 'Directory authority cannot be an alias')
        inventory.contained(root, folder)
        for path in folder.iterdir():
            name = path.relative_to(root).as_posix()
            inventory.contained(root, path)
            if path.is_symlink():
                target = os.readlink(path)
                require(not Path(target).is_absolute(), 'Absolute resource alias: '+name)
                links[name] = target
            elif path.is_dir():
                directories.add(name)
                pending.append(path)
            elif path.is_file():
                files[name] = inventory.digest(path)
            else:
                raise ValueError('Invalid resource entry: '+name)
    require(all(any(n.startswith(d+'/') for n in files.keys() | links.keys()) for d in directories),
            'Unmeasured empty resource directory')
    return files, links


def completed_stage(path):
    require(not path.is_symlink(), 'Stage authority cannot be an alias')
    root = path.resolve(strict=True)
    require(root.is_dir() and set(p.name for p in root.iterdir()) ==
            {'MacOS', 'Frameworks', 'Resources', 'bundle-config.json', 'bundle-manifest.json'},
            'Expected a completed macOS stage')
    require(all(not p.is_symlink() for p in root.iterdir()), 'Stage entries cannot redirect their authority')
    manifest_bytes = (root / 'bundle-manifest.json').read_bytes()
    manifest = json.loads(manifest_bytes)
    release = json.loads((root / RUNTIME / 'release.json').read_text())
    architecture = {'aarch64': 'arm64', 'x86_64': 'x86_64'}.get(release.get('arch'))
    require(architecture is not None, 'Invalid staged architecture')
    inventory.verify_resources(root, manifest, architecture)
    native = {'MacOS/printpartner-node': manifest['node_sha256']}
    expected = {RUNTIME+'/release.json': inventory.digest(root / RUNTIME / 'release.json')}
    for group, suffix in inventory.ARTIFACTS.items():
        expected.update({inventory.WEB+'/'+suffix+'/'+name: digest for name, digest in manifest[group].items()})
    expected.update({inventory.WEB+'/'+name: digest for name, digest in manifest['metadata'].items()})
    for name, digest in manifest['dependencies']['files'].items():
        if name.startswith(inventory.WEB+'/'):
            expected[name] = digest
        else:
            require(name.startswith('Frameworks/') and len(Path(name).parts) == 2,
                    'Unexpected native inventory authority')
            native[name] = digest
    links = manifest['dependencies']['links']
    require(all(name.startswith(inventory.WEB+'/') for name in links), 'Unexpected alias authority')
    require(set(p.name for p in (root / 'Resources').iterdir()) == {'desktop-runtime'},
            'Unexpected staged Resources entry')
    files, actual_links = tree(root, root / RUNTIME)
    require(files == expected and actual_links == links, 'Runtime tree differs from its complete inventory')
    actual_native = {}
    for directory in ['MacOS', 'Frameworks']:
        measured, aliases = tree(root, root / directory)
        require(not aliases, 'Native entries must be regular measured files')
        actual_native.update(measured)
    require(actual_native == native, 'Staged native inventory differs')
    config = json.loads((root / 'bundle-config.json').read_text())['bundle']
    require(config['active'] is True and config['resources'] == {} and
            config['macOS']['minimumSystemVersion'] == '13.5' and
            config['macOS']['files'] == {name: str(root / name) for name in native},
            'Stage configuration must leave runtime assembly to this helper')
    return CompletedMeasuredStage(root, manifest_bytes, manifest, architecture, files, links, native)


def fresh_app(stage, path):
    require(path.name == 'Print Partner.app' and not path.is_symlink(), 'Expected the fresh Print Partner app')
    app = path.resolve(strict=True)
    require(not app.is_relative_to(stage.root) and not stage.root.is_relative_to(app),
            'Stage and app authorities must be separate')
    contents = app / 'Contents'
    require(contents.is_dir() and not contents.is_symlink(), 'Invalid app Contents authority')
    require(not os.path.lexists(contents / '_CodeSignature') and not os.path.lexists(contents / 'CodeResources'),
            'Resources must be assembled before outer signing')
    plist_path = contents / 'Info.plist'
    require(not plist_path.is_symlink(), 'App metadata cannot be an alias')
    info = plistlib.loads(plist_path.read_bytes())
    require(info.get('CFBundleIdentifier') == 'com.poitee.printpartner' and
            info.get('CFBundlePackageType') == 'APPL' and info.get('LSMinimumSystemVersion') == '13.5' and
            info.get('CFBundleShortVersionString') == stage.manifest['runtime_version'].removesuffix('-web'),
            'App product identity differs from the stage')
    executable = info.get('CFBundleExecutable')
    require(isinstance(executable, str) and inventory.relative_path(executable) == executable and
            len(Path(executable).parts) == 1 and executable != 'printpartner-node', 'Invalid main executable')
    main = contents / 'MacOS' / executable
    require(main.is_file() and not main.is_symlink() and os.access(main, os.X_OK), 'Fresh app executable missing')
    actual_native = {}
    for directory in ['MacOS', 'Frameworks']:
        measured, aliases = tree(contents, contents / directory)
        require(not aliases, 'Fresh native entries must be regular files')
        actual_native.update(measured)
    actual_native.pop('MacOS/'+executable, None)
    require(actual_native == stage.native_files, 'Fresh app Node or Frameworks bytes differ from the stage')
    resources = contents / 'Resources'
    require(resources.is_dir() and not resources.is_symlink(), 'Invalid Resources authority')
    destination = contents / RUNTIME
    require(not os.path.lexists(destination), 'Runtime destination must be absent in a fresh app')
    for path in contents.rglob('*'):
        inventory.contained(contents, path)
    for relative in stage.manifest['dependencies']['roots']:
        if not relative.startswith(inventory.WEB+'/') and relative != inventory.WEB+'/node_modules':
            require(not os.path.lexists(contents / relative), 'Unexpected app resolver root')
    return FreshUnsignedApp(contents, destination)


def assemble(stage_path, app_path):
    stage = completed_stage(stage_path)
    app = fresh_app(stage, app_path)
    with tempfile.TemporaryDirectory(prefix='.runtime-assembly-', dir=app.contents / 'Resources') as temporary:
        candidate = Path(temporary)
        for relative in stage.native_files:
            target = candidate / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            os.link(app.contents / relative, target)
        runtime = candidate / RUNTIME
        runtime.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(stage.root / RUNTIME, runtime, symlinks=True)
        files, links = tree(candidate, runtime)
        require(files == stage.runtime_files and links == stage.runtime_links, 'Copied runtime inventory differs')
        inventory.verify_resources(candidate, stage.manifest, stage.architecture)
        require((stage.root / 'bundle-manifest.json').read_bytes() == stage.manifest_bytes,
                'Stage manifest changed during assembly')
        require(not os.path.lexists(app.runtime_destination), 'Runtime destination appeared during assembly')
        runtime.rename(app.runtime_destination)
    return {'app': str(app_path), 'architecture': stage.architecture,
            'runtime_files': len(stage.runtime_files), 'runtime_aliases': len(stage.runtime_links), 'signed': False}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--stage', type=Path, required=True)
    parser.add_argument('--validate-stage', action='store_true')
    args = parser.parse_args()
    if args.validate_stage:
        stage = completed_stage(args.stage)
        print(json.dumps({'stage': str(stage.root), 'architecture': stage.architecture, 'complete': True}))
    else:
        repo = Path(__file__).resolve().parents[2]
        print(json.dumps(assemble(args.stage, repo / 'rust/target/release/bundle/macos/Print Partner.app')))


if __name__ == '__main__':
    main()
