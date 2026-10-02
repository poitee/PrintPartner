#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
import pathlib
import plistlib
import re
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

WEB = 'Resources/desktop-runtime/web'
ARTIFACTS = {'frontend': 'apps/web/dist', 'backend': 'apps/server/dist/current',
             'contracts': 'packages/contracts/dist/current', 'domain': 'packages/domain/dist/current'}
FLOOR = (13, 5, 0)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def relative_path(value):
    require(isinstance(value, str) and value and '\\' not in value, 'Invalid inventory path')
    path = pathlib.PurePosixPath(value)
    require(not path.is_absolute() and all(part not in ('', '.', '..') for part in value.split('/')),
            'Inventory path must be canonical and relative: '+value)
    return value


def contained(root, path):
    resolved = path.resolve(strict=True)
    require(resolved.is_relative_to(root), 'Resource escapes Contents: '+str(path))
    return resolved


def measured_files(root, directory):
    result = {}
    for path in sorted(directory.rglob('*')):
        contained(root, path)
        if path.is_file():
            result[path.relative_to(directory).as_posix()] = digest(path)
    require(result, 'Empty artifact: '+str(directory))
    return result


def dependency_roots(root, web):
    search = {web / 'node_modules', web / 'apps/node_modules', web / 'packages/node_modules'}
    ancestor = web.parent
    while ancestor.is_relative_to(root):
        search.add(ancestor / 'node_modules')
        if ancestor == root:
            break
        ancestor = ancestor.parent
    for workspace in [*(p for p in web.glob('apps/*') if p.is_dir() and p.name != 'node_modules'),
                      *(p for p in web.glob('packages/*') if p.is_dir() and p.name != 'node_modules')]:
        for directory in [workspace, workspace / 'dist', workspace / 'dist/current']:
            search.add(directory / 'node_modules')
    return sorted(p.relative_to(root).as_posix() for p in search)


def dependency_inventory(root, roots):
    files, links, visited = {}, {}, set()
    pending = [root / relative_path(value) for value in roots if (root / value).exists()]
    while pending:
        directory = contained(root, pending.pop())
        if directory in visited:
            continue
        visited.add(directory)
        require(directory.is_dir(), 'Dependency root must be a directory')
        require(any(directory.iterdir()), 'Unexpected empty dependency directory: '+str(directory))
        for path in directory.iterdir():
            name = path.relative_to(root).as_posix()
            if path.is_symlink():
                target = contained(root, path)
                link = os.readlink(path)
                require(not pathlib.Path(link).is_absolute(), 'Absolute dependency alias: '+name)
                links[name] = link
                if target.is_file():
                    files[target.relative_to(root).as_posix()] = digest(target)
                else:
                    require(target.is_dir(), 'Invalid alias target: '+name)
                    pending.append(target)
            elif path.is_file():
                files[name] = digest(path)
            elif path.is_dir():
                pending.append(path)
            else:
                raise ValueError('Invalid dependency entry: '+name)
    return {'files': files, 'links': links}


def hash_map(value):
    require(isinstance(value, dict) and value, 'Empty or malformed hash inventory')
    for name, checksum in value.items():
        relative_path(name)
        require(isinstance(checksum, str) and re.fullmatch('[0-9a-f]{64}', checksum), 'Invalid SHA-256')


def verify_resources(root, manifest, arch):
    require(manifest.get('schema') == 1, 'Unsupported manifest schema')
    require(re.fullmatch('[0-9a-f]{40}', manifest.get('commit', '')), 'Invalid manifest commit')
    require(manifest.get('node_version') == 'v24.21.0', 'Unexpected Node version')
    require(re.fullmatch('[0-9a-f]{64}', manifest.get('node_sha256', '')), 'Invalid Node hash')
    web = root / WEB
    contained(root, web)
    node = root / 'MacOS/printpartner-node'
    require(contained(root, node).is_file() and os.access(node, os.X_OK), 'Installed Node missing or not executable')
    require(digest(node) == manifest['node_sha256'], 'Installed Node bytes changed')
    for key, suffix in ARTIFACTS.items():
        hash_map(manifest.get(key))
        require(measured_files(root, web / suffix) == manifest[key], 'Changed or missing '+key+' inventory')
    require('desktop-resolution.js' in manifest['backend'], 'Measured preload missing')
    hash_map(manifest.get('metadata'))
    expected_metadata = {'package.json', 'package-lock.json', 'apps/server/package.json',
                         'packages/contracts/package.json', 'packages/domain/package.json'}
    require(set(manifest['metadata']) == expected_metadata, 'Incomplete metadata inventory')
    for name, checksum in manifest['metadata'].items():
        require(digest(contained(root, web / name)) == checksum, 'Changed metadata: '+name)
    deps = manifest.get('dependencies')
    require(isinstance(deps, dict) and deps.get('web_path') == WEB, 'Invalid installed web root')
    hash_map(deps.get('files'))
    require(isinstance(deps.get('links'), dict), 'Malformed alias inventory')
    for name, target in deps['links'].items():
        relative_path(name)
        require(isinstance(target, str) and target and not pathlib.Path(target).is_absolute(), 'Invalid alias target')
    require(deps.get('roots') == dependency_roots(root, web), 'Missing or changed resolver roots')
    actual = dependency_inventory(root, deps['roots'])
    require(actual == {'files': deps['files'], 'links': deps['links']}, 'Changed dependency bytes or aliases')
    for name in ('contracts', 'domain'):
        alias = web / 'node_modules/@print-partner' / name
        require(alias.is_symlink() and contained(root, alias) == web / 'packages' / name,
                'Missing or incorrect workspace alias: '+name)
    lock = json.loads((web / 'package-lock.json').read_text())
    require(isinstance(lock.get('packages'), dict), 'Missing locked production closure')
    for name, package in lock['packages'].items():
        if 'node_modules/' in name and not package.get('dev') and not package.get('devOptional'):
            relative_path(name)
            if not package.get('optional'):
                require((web / name).is_dir(), 'Locked production package omitted: '+name)
            if (web / name).exists():
                contained(root, web / name)
    release = json.loads((root / 'Resources/desktop-runtime/release.json').read_text())
    expected = {'runtime_version': manifest['runtime_version'], 'commit': manifest['commit'],
                'node': 'MacOS/printpartner-node', 'web': WEB, 'os': 'macos',
                'arch': {'arm64': 'aarch64', 'x86_64': 'x86_64'}[arch],
                'node_version': 'v24.21.0', 'node_abi': '137'}
    require(release == expected, 'Installed release identity mismatch')
    desktop = json.loads((web / 'apps/web/dist/desktop-build.json').read_text())
    require(desktop == {'mode': 'desktop', 'version': manifest['runtime_version'].removesuffix('-web'),
                        'service_worker': False}, 'Installed frontend is not the desktop build')
    return {'node_sha256': manifest['node_sha256'], 'dependency_files': len(deps['files']),
            'dependency_links': len(deps['links']), 'artifact_files': {key: len(manifest[key]) for key in ARTIFACTS}}


def version(value):
    require(isinstance(value, str) and re.fullmatch(r'\d+\.\d+(?:\.\d+)?', value), 'Malformed deployment target')
    parts = tuple(int(part) for part in value.split('.'))
    return parts + (0,) * (3 - len(parts))


def load_commands(output):
    blocks = re.split(r'(?m)^Load command \d+\s*$', output)
    commands = []
    for block in blocks[1:]:
        names = re.findall(r'(?m)^\s*cmd (LC_\w+)\s*$', block)
        require(len(names) == 1, 'Malformed otool load command')
        name = names[0]
        wanted = {'LC_BUILD_VERSION': {'platform', 'minos'}, 'LC_VERSION_MIN_MACOSX': {'version'},
                  'LC_RPATH': {'path'}, 'LC_ID_DYLIB': {'name'}}.get(name, set())
        fields = {}
        for line in block.splitlines():
            parts = line.strip().split(maxsplit=1)
            if len(parts) == 2 and parts[0] in wanted:
                require(parts[0] not in fields, 'Duplicate otool field')
                fields[parts[0]] = parts[1]
        commands.append((name, fields))
    require(commands, 'Missing otool load commands')
    return commands


def deployment_target(output):
    targets = []
    for command, fields in load_commands(output):
        if command == 'LC_BUILD_VERSION':
            require(fields.get('platform') in ('1', 'macos', 'MACOS'), 'Mach-O targets a non-macOS platform')
            targets.append(version(fields.get('minos')))
        elif command == 'LC_VERSION_MIN_MACOSX':
            targets.append(version(fields.get('version')))
        elif command.startswith('LC_VERSION_MIN_'):
            raise ValueError('Mach-O targets a non-macOS platform')
    require(len(targets) == 1, 'Missing or ambiguous macOS deployment target')
    require((10, 0, 0) <= targets[0] <= FLOOR, 'Mach-O deployment target exceeds macOS 13.5')
    return '.'.join(map(str, targets[0]))


def architecture(output, expected):
    require(output.split() == [expected], 'Incorrect Mach-O architecture: '+output)


def bundle_info(info):
    require(info.get('LSMinimumSystemVersion') == '13.5', 'Info.plist must promise macOS 13.5')
    require(info.get('CFBundleIdentifier') == 'com.poitee.printpartner', 'Bundle identifier changed')
    executable = relative_path(info.get('CFBundleExecutable'))
    require('/' not in executable, 'Main executable must be in MacOS')
    return executable


def linked_libraries(output):
    lines = output.splitlines()
    require(lines and lines[0].endswith(':'), 'Malformed otool library header')
    result = []
    for line in lines[1:]:
        match = re.fullmatch(r'\s+(.+) \(compatibility version [^,]+, current version [^)]+\)', line)
        require(match is not None, 'Malformed otool library record')
        result.append(match[1])
    return result


def command(*args, **kwargs):
    return subprocess.check_output(args, text=True, **kwargs).strip()


def verify_macho(root, arch, executable, receipt):
    records, sysroot = {}, set()
    receipt['mach_o'] = records
    receipt['sysroot_libraries'] = []
    main = root / 'MacOS' / executable
    require(main.is_file() and os.access(main, os.X_OK), 'Main executable missing')
    candidates = [p for p in root.rglob('*') if p.is_file() and not p.is_symlink()]
    outputs = {}
    for path in candidates:
        description = command('/usr/bin/file', '-b', str(path))
        if 'Mach-O' not in description:
            require(path.suffix not in ('.node', '.dylib') and path not in (main, root / 'MacOS/printpartner-node'),
                    'Expected native file is not Mach-O: '+str(path))
            continue
        name = path.relative_to(root).as_posix()
        observed_arch = command('/usr/bin/lipo', '-archs', str(path))
        records[name] = {'architecture': observed_arch, 'sha256': digest(path), 'file': description}
        architecture(observed_arch, arch)
        outputs[path] = command('/usr/bin/otool', '-l', str(path))
        records[name]['load_commands'] = outputs[path]
        records[name]['minimum_macos'] = deployment_target(outputs[path])
    require(main in outputs and root / 'MacOS/printpartner-node' in outputs, 'Required Mach-O executable missing')
    require(any(name.endswith('.node') for name in records), 'Installed SQLite addon missing')
    libraries = {}
    rpaths = {}
    for path, output in outputs.items():
        rpaths[path] = []
        identities = []
        for cmd, fields in load_commands(output):
            if cmd in ('LC_RPATH', 'LC_ID_DYLIB'):
                match = re.fullmatch(r'(.+) \(offset \d+\)', fields.get('path' if cmd == 'LC_RPATH' else 'name', ''))
                require(match is not None, 'Malformed '+cmd)
                (rpaths[path] if cmd == 'LC_RPATH' else identities).append(match[1])
        require(len(identities) <= 1, 'Ambiguous dylib identity')
        libraries[path] = linked_libraries(command('/usr/bin/otool', '-L', str(path)))
        if identities:
            require(libraries[path] and libraries[path][0] == identities[0], 'Dylib identity mismatch')
            libraries[path] = libraries[path][1:]
        records[path.relative_to(root).as_posix()]['libraries'] = libraries[path]
        records[path.relative_to(root).as_posix()]['loader_contexts'] = []

    def system_library(path):
        value = str(path)
        return ((value in ('/usr/lib', '/System/Library') or value.startswith(('/usr/lib/', '/System/Library/')))
                and '\\' not in value
                and all(part not in ('', '.', '..') for part in value[1:].split('/')))

    def expand(value, loader, loading_executable):
        if value == '@loader_path':
            return loader.parent
        if value == '@executable_path':
            return loading_executable.parent
        if value.startswith('@loader_path/'):
            return loader.parent / value.removeprefix('@loader_path/')
        if value.startswith('@executable_path/'):
            return loading_executable.parent / value.removeprefix('@executable_path/')
        require(value.startswith('/'), 'Unresolved dyld path: '+value)
        require('\\' not in value and all(part not in ('', '.', '..') for part in value[1:].split('/')),
                'Noncanonical dyld path: '+value)
        return pathlib.Path(value)

    checked = set()
    reached = set()

    def visit(image, loading_executable, ancestors):
        search = []
        for owner in (image, *reversed(ancestors)):
            for value in rpaths[owner]:
                base = expand(value, owner, loading_executable)
                if not system_library(base):
                    base = base.resolve()
                    require(base.is_relative_to(root), 'LC_RPATH escapes Contents')
                if base not in search:
                    search.append(base)
        key = (image, loading_executable, tuple(search))
        if key in checked:
            return
        checked.add(key)
        reached.add(image)
        context = {'executable': loading_executable.relative_to(root).as_posix(),
                   'loader_chain': [p.relative_to(root).as_posix() for p in (*ancestors, image)],
                   'rpaths': [str(p) for p in search], 'resolved_libraries': {}}
        records[image.relative_to(root).as_posix()]['loader_contexts'].append(context)
        for library in libraries[image]:
            if library.startswith('@rpath/'):
                suffix = relative_path(library.removeprefix('@rpath/'))
                choices = [base / suffix for base in search]
            else:
                choices = [expand(library, image, loading_executable)]
            target = None
            for choice in choices:
                if system_library(choice):
                    sysroot.add(str(choice))
                    receipt['sysroot_libraries'] = sorted(sysroot)
                    target = choice
                    break
                require(choice.is_relative_to(root), 'Native dependency escapes Contents: '+library)
                resolved = choice.resolve()
                require(resolved.is_relative_to(root), 'Native dependency escapes Contents: '+library)
                if resolved in outputs:
                    target = resolved
                    break
                require(not resolved.exists(), 'Native dependency is not Mach-O: '+library)
            require(target is not None, 'Unbundled native dependency in '+str(loading_executable)+': '+library)
            context['resolved_libraries'][library] = str(target)
            if target in outputs and target not in ancestors and target != image:
                visit(target, loading_executable, (*ancestors, image))

    node = root / 'MacOS/printpartner-node'
    visit(main, main, ())
    visit(node, node, ())
    for addon in outputs:
        if addon.suffix == '.node':
            visit(addon, node, (node,))
    for image in outputs:
        if image not in reached:
            visit(image, node, (node,))
    return {'mach_o': records, 'sysroot_libraries': sorted(sysroot)}


def verify(app, manifest_path, arch, receipt):
    require(sys.platform == 'darwin', 'Real bundle verification requires macOS; use --self-test on Linux')
    root = (app / 'Contents').resolve(strict=True)
    with (root / 'Info.plist').open('rb') as stream:
        info = plistlib.load(stream)
    receipt['info_plist'] = {key: info.get(key) for key in
                            ('LSMinimumSystemVersion', 'CFBundleIdentifier', 'CFBundleExecutable')}
    executable = bundle_info(info)
    manifest = json.loads(manifest_path.read_text())
    receipt['manifest_sha256'] = digest(manifest_path)
    for path in root.rglob('*'):
        if path.is_symlink():
            require(not pathlib.Path(os.readlink(path)).is_absolute(), 'Absolute installed alias')
            contained(root, path)
    resources = verify_resources(root, manifest, arch)
    receipt['resources'] = resources
    native = verify_macho(root, arch, executable, receipt)
    measured_native = set(manifest['dependencies']['files']) | {'MacOS/printpartner-node', 'MacOS/'+executable}
    require(set(native['mach_o']).issubset(measured_native), 'Unmeasured native code in app')
    env = {key: value for key, value in os.environ.items() if key not in ('NODE_OPTIONS', 'NODE_PATH')}
    program = "const D=require('better-sqlite3');const db=new D(':memory:');const answer=db.prepare('SELECT 42 answer').get().answer;db.close();if(answer!==42)throw Error('SQLite failed');const {createCanvas}=require('@napi-rs/canvas');const canvas=createCanvas(2,2);const ctx=canvas.getContext('2d');ctx.fillStyle='#123456';ctx.fillRect(0,0,2,2);const pixel=Array.from(ctx.getImageData(0,0,1,1).data);const png=canvas.toBuffer('image/png');if(JSON.stringify(pixel)!=='[18,52,86,255]'||png.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw Error('Canvas failed');console.log(JSON.stringify({version:process.version,abi:process.versions.modules,os:process.platform,arch:process.arch,sqlite_answer:answer,canvas_pixel:pixel,canvas_png_signature:png.subarray(0,8).toString('hex'),native_addons:Object.keys(require.cache).filter(p=>p.endsWith('.node')).map(p=>require('node:fs').realpathSync(p)).sort()}));"
    node_arch = {'arm64': 'arm64', 'x86_64': 'x64'}[arch]
    expected_addons = sorted(str(contained(root, root / WEB / name)) for name in [
        'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
        f'node_modules/@napi-rs/canvas-darwin-{node_arch}/skia.darwin-{node_arch}.node'])
    result = json.loads(command(str(root / 'MacOS/printpartner-node'), '--no-global-search-paths',
        '--import', str(root / WEB / 'apps/server/dist/current/desktop-resolution.js'), '-e', program,
        'bundle-probe', '--pp-desktop-package-root='+str(root), cwd=root / WEB, env=env, timeout=30))
    require(result == {'version': 'v24.21.0', 'abi': '137', 'os': 'darwin',
                       'arch': {'arm64': 'arm64', 'x86_64': 'x64'}[arch], 'sqlite_answer': 42,
                       'canvas_pixel': [18, 52, 86, 255], 'canvas_png_signature': '89504e470d0a1a0a',
                       'native_addons': expected_addons}, 'Installed runtime identity mismatch')
    require(digest(root / 'MacOS/printpartner-node') == manifest['node_sha256'], 'Node changed during probe')
    return {'proof_class': 'unsigned_macos_bundle', 'app': str(app.resolve()), 'architecture': arch,
            'manifest_sha256': digest(manifest_path), 'minimum_macos': '13.5', 'resources': resources,
            **native, 'installed_runtime': result, 'signed_release': False, 'native_launch': False, 'rendered_ui': False}


class ParserTests(unittest.TestCase):
    def test_system_install_names_preserve_loader_authority(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary).resolve()
            main = root / 'MacOS/pp-desktop'
            node = root / 'MacOS/printpartner-node'
            addon = root / 'Frameworks/addon.node'
            for image in (main, node, addon):
                image.parent.mkdir(parents=True, exist_ok=True)
                image.write_bytes(image.name.encode())
                image.chmod(0o755)
            framework = '/System/Library/Frameworks/WebKit.framework/Versions/A/WebKit'
            dependencies = {main: framework}
            paths = {}
            base = 'binary:\nLoad command 0\n cmd LC_BUILD_VERSION\n platform 1\n minos 13.5\n'

            def tool(*args, **kwargs):
                image = pathlib.Path(args[-1])
                if args[0] == '/usr/bin/file':
                    return 'Mach-O 64-bit arm64'
                if args[0] == '/usr/bin/lipo':
                    return 'arm64'
                if args[1] == '-l':
                    value = paths.get(image)
                    return base + ('Load command 1\n cmd LC_RPATH\n path '+value+' (offset 12)\n' if value else '')
                if args[1] == '-L':
                    value = dependencies.get(image, '/usr/lib/libSystem.B.dylib')
                    return str(image)+':\n\t'+value+' (compatibility version 1.0.0, current version 1.0.0)'
                raise AssertionError(args)

            original_resolve = pathlib.Path.resolve

            def resolve(path, *args, **kwargs):
                if str(path) == framework:
                    return pathlib.Path('/outside/synthetic-system-indirection/WebKit')
                return original_resolve(path, *args, **kwargs)

            with patch(__name__+'.command', side_effect=tool), patch.object(pathlib.Path, 'resolve', resolve):
                report = verify_macho(root, 'arm64', 'pp-desktop', {})
                self.assertIn(framework, report['sysroot_libraries'])
                self.assertEqual(report['mach_o']['MacOS/pp-desktop']['loader_contexts'][0]
                                 ['resolved_libraries'][framework], framework)
                with patch.object(pathlib.Path, 'exists', side_effect=AssertionError('Cache-only name touched disk')):
                    verify_macho(root, 'arm64', 'pp-desktop', {})
                paths[main] = '/System/Library/Frameworks/WebKit.framework/Versions/A'
                dependencies[main] = '@rpath/WebKit'
                verify_macho(root, 'arm64', 'pp-desktop', {})
                paths[main] = '/usr/lib'
                dependencies[main] = '@rpath/libSystem.B.dylib'
                verify_macho(root, 'arm64', 'pp-desktop', {})
                paths.clear()
                for library in ['/usr/local/lib/libcustom.dylib', '/System/Library-lookalike/libcustom.dylib',
                                '/Library/Frameworks/Custom.framework/Custom', '/private/tmp/libcustom.dylib',
                                '/Users/fixture/libcustom.dylib', '/System/Volumes/unproven/libcustom.dylib',
                                '/System/Library/../../tmp/libcustom.dylib', '/usr/lib/../../tmp/libcustom.dylib',
                                '/System//Library/Frameworks/WebKit.framework/Versions/A/WebKit',
                                '/System/Library/./Frameworks/WebKit.framework/Versions/A/WebKit',
                                '//System/Library/Frameworks/WebKit.framework/Versions/A/WebKit',
                                '/usr/lib\\libcustom.dylib', '@unknown/libcustom.dylib', 'libcustom.dylib',
                                '@rpath/libcustom.dylib']:
                    dependencies[main] = library
                    with self.subTest(library=library), self.assertRaises(ValueError):
                        verify_macho(root, 'arm64', 'pp-desktop', {})
                dependencies[main] = '@rpath/WebKit'
                for rpath in ['/usr/local/lib', '/System/Library-lookalike', '/private/tmp',
                              '/System/Library/../../tmp', '/System//Library/Frameworks']:
                    paths[main] = rpath
                    with self.subTest(rpath=rpath), self.assertRaises(ValueError):
                        verify_macho(root, 'arm64', 'pp-desktop', {})
                paths[main] = '/System/Library/Frameworks/WebKit.framework/Versions/A'
                dependencies[main] = '@rpath/../../../../../tmp/libcustom.dylib'
                with self.assertRaises(ValueError):
                    verify_macho(root, 'arm64', 'pp-desktop', {})
                paths.clear()
                dependencies[main] = framework
                alias = root / 'Frameworks/user-alias.dylib'
                alias.symlink_to('/usr/lib/libSystem.B.dylib')
                dependencies[addon] = '@loader_path/user-alias.dylib'
                with self.assertRaisesRegex(ValueError, 'Native dependency escapes Contents'):
                    verify_macho(root, 'arm64', 'pp-desktop', {})

    def test_node_addon_uses_node_executable_and_loader_chain(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary).resolve()
            main = root / 'MacOS/pp-desktop'
            node = root / 'MacOS/printpartner-node'
            addon = root / 'Frameworks/addon.node'
            library = root / 'Frameworks/libfixture.dylib'
            child = root / 'Frameworks/nested/libchild.dylib'
            for path in (main, node, addon, library):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(path.name.encode())
                path.chmod(0o755)
            base = 'binary:\nLoad command 0\n cmd LC_BUILD_VERSION\n platform 1\n minos 13.5\n'
            paths = {main: '@executable_path/../Frameworks'}
            dependencies = {addon: '@rpath/libfixture.dylib'}
            identities = {}

            def tool(*args, **kwargs):
                image = pathlib.Path(args[-1])
                if args[0] == '/usr/bin/file':
                    return 'Mach-O 64-bit arm64'
                if args[0] == '/usr/bin/lipo':
                    return 'arm64'
                if args[1] == '-l':
                    value = paths.get(image)
                    identity = identities.get(image)
                    return (base + ('Load command 1\n cmd LC_RPATH\n path '+value+' (offset 12)\n' if value else '')
                            + ('Load command 2\n cmd LC_ID_DYLIB\n name '+identity+' (offset 24)\n' if identity else ''))
                if args[1] == '-L':
                    value = dependencies.get(image, '/usr/lib/libSystem.B.dylib')
                    values = ([identities[image]] if image in identities else []) + [value]
                    return str(image)+':\n'+ '\n'.join('\t'+v+' (compatibility version 1.0.0, current version 1.0.0)' for v in values)
                raise AssertionError(args)

            with patch(__name__+'.command', side_effect=tool):
                with self.assertRaisesRegex(ValueError, r'printpartner-node: @rpath/libfixture'):
                    verify_macho(root, 'arm64', 'pp-desktop', {})
                paths[node] = '@executable_path/../Frameworks'
                valid = verify_macho(root, 'arm64', 'pp-desktop', {})
                context = valid['mach_o']['Frameworks/addon.node']['loader_contexts'][0]
                self.assertEqual(context['executable'], 'MacOS/printpartner-node')
                self.assertNotIn('MacOS/pp-desktop', context['loader_chain'])
                paths.pop(node)
                paths[addon] = '@loader_path'
                verify_macho(root, 'arm64', 'pp-desktop', {})
                child.parent.mkdir()
                child.write_bytes(b'child library')
                dependencies[library] = '@rpath/libchild.dylib'
                paths[library] = '@loader_path/nested'
                dependencies[child] = '@rpath/libfixture.dylib'
                chained = verify_macho(root, 'arm64', 'pp-desktop', {})
                child_context = chained['mach_o']['Frameworks/nested/libchild.dylib']['loader_contexts'][0]
                self.assertEqual(child_context['loader_chain'], ['MacOS/printpartner-node', 'Frameworks/addon.node',
                                                                'Frameworks/libfixture.dylib', 'Frameworks/nested/libchild.dylib'])
                paths.pop(library)
                with self.assertRaisesRegex(ValueError, r'printpartner-node: @rpath/libchild'):
                    verify_macho(root, 'arm64', 'pp-desktop', {})
                dependencies[library] = '@loader_path/nested/libchild.dylib'
                verify_macho(root, 'arm64', 'pp-desktop', {})
                dependencies[child] = '/usr/lib/libSystem.B.dylib'
                paths.pop(addon)
                dependencies[addon] = '@executable_path/../Frameworks/libfixture.dylib'
                verify_macho(root, 'arm64', 'pp-desktop', {})
                identities[library] = '@rpath/libfixture.dylib'
                verify_macho(root, 'arm64', 'pp-desktop', {})

    def test_architecture_and_plist_controls(self):
        architecture('arm64', 'arm64')
        architecture('x86_64', 'x86_64')
        for output in ['', 'x86_64', 'arm64 x86_64', 'arm64e']:
            with self.subTest(output=output), self.assertRaises(ValueError):
                architecture(output, 'arm64')
        info = {'LSMinimumSystemVersion': '13.5', 'CFBundleIdentifier': 'com.poitee.printpartner',
                'CFBundleExecutable': 'pp-desktop'}
        self.assertEqual(bundle_info(info), 'pp-desktop')
        for key, value in [('LSMinimumSystemVersion', '14.0'), ('LSMinimumSystemVersion', None),
                           ('CFBundleIdentifier', 'wrong'), ('CFBundleExecutable', '../escape')]:
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                bundle_info({**info, key: value})

    def test_deployment_controls(self):
        modern = 'binary:\nLoad command 0\n      cmd LC_BUILD_VERSION\n  cmdsize 32\n platform 1\n    minos 13.5\n      sdk 26.0\n   ntools 0\n'
        legacy = 'binary:\nLoad command 0\n cmd LC_VERSION_MIN_MACOSX\n cmdsize 16\n version 11.0\n sdk 26.0\n'
        self.assertEqual(deployment_target(modern), '13.5.0')
        self.assertEqual(deployment_target(legacy), '11.0.0')
        sections = 'binary:\nLoad command 0\n cmd LC_SEGMENT_64\n sectname __text\n segname __TEXT\n sectname __stubs\n segname __TEXT\n'
        self.assertEqual(deployment_target(sections + modern.replace('Load command 0', 'Load command 1')), '13.5.0')
        for bad in ['', modern.replace('13.5', '14.0'), modern.replace('platform 1', 'platform 2'),
                    modern.replace('minos 13.5', 'minos unknown'), modern.replace('minos 13.5', ''),
                    modern + legacy, legacy.replace('LC_VERSION_MIN_MACOSX', 'LC_VERSION_MIN_IPHONEOS'),
                    modern.replace('sdk 26.0', 'minos 13.0')]:
            with self.subTest(output=bad), self.assertRaises(ValueError):
                deployment_target(bad)

    def test_library_controls(self):
        output = 'binary:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1351.0.0)'
        self.assertEqual(linked_libraries(output), ['/usr/lib/libSystem.B.dylib'])
        for bad in ['', 'binary\n', 'binary:\n bad library', output+'\nmalformed']:
            with self.subTest(output=bad), self.assertRaises(ValueError):
                linked_libraries(bad)

    def test_resource_verifier_rejects_changed_or_missing_closure(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary).resolve()
            web = root / WEB
            node = root / 'MacOS/printpartner-node'
            node.parent.mkdir(parents=True)
            node.write_text('fixture node bytes')
            node.chmod(0o755)
            for suffix in ARTIFACTS.values():
                directory = web / suffix
                directory.mkdir(parents=True)
                (directory / 'index.js').write_text('fixture artifact')
            (web / ARTIFACTS['backend'] / 'desktop-resolution.js').write_text('fixture preload')
            (web / ARTIFACTS['frontend'] / 'desktop-build.json').write_text(json.dumps(
                {'mode': 'desktop', 'version': '3.3.0', 'service_worker': False}))
            metadata = ['package.json', 'package-lock.json', 'apps/server/package.json',
                        'packages/contracts/package.json', 'packages/domain/package.json']
            for name in metadata:
                (web / name).write_text(json.dumps({'version': '3.3.0'}))
            (web / 'package-lock.json').write_text(json.dumps({'packages': {
                'node_modules/better-sqlite3': {'version': 'fixture'}}}))
            addon = root / 'Frameworks/fixture.node'
            addon.parent.mkdir()
            addon.write_text('fixture addon bytes')
            alias = web / 'node_modules/better-sqlite3/build/Release/better_sqlite3.node'
            alias.parent.mkdir(parents=True)
            alias.symlink_to(os.path.relpath(addon, alias.parent))
            workspaces = web / 'node_modules/@print-partner'
            workspaces.mkdir()
            for name in ('contracts', 'domain'):
                (workspaces / name).symlink_to('../../packages/'+name)
            roots = dependency_roots(root, web)
            manifest = {'schema': 1, 'commit': 'a'*40, 'node_version': 'v24.21.0',
                        'runtime_version': '3.3.0-web', 'node_sha256': digest(node),
                        'metadata': {name: digest(web / name) for name in metadata},
                        'dependencies': {'web_path': WEB, 'roots': roots, **dependency_inventory(root, roots)},
                        **{key: measured_files(root, web / suffix) for key, suffix in ARTIFACTS.items()}}
            (root / 'Resources/desktop-runtime/release.json').write_text(json.dumps({
                'runtime_version': '3.3.0-web', 'commit': 'a'*40, 'node': 'MacOS/printpartner-node',
                'web': WEB, 'os': 'macos', 'arch': 'aarch64', 'node_version': 'v24.21.0', 'node_abi': '137'}))
            self.assertGreater(verify_resources(root, manifest, 'arm64')['dependency_files'], 0)
            for key in ['frontend', 'backend', 'metadata', 'dependencies']:
                broken = json.loads(json.dumps(manifest))
                if key == 'dependencies':
                    broken[key]['files'].pop(next(iter(broken[key]['files'])))
                else:
                    broken[key].pop(next(iter(broken[key])))
                with self.subTest(omitted=key), self.assertRaises(ValueError):
                    verify_resources(root, broken, 'arm64')
            for path in [node, addon, web / ARTIFACTS['backend'] / 'index.js']:
                original = path.read_bytes()
                path.write_bytes(b'changed')
                with self.subTest(changed=str(path)), self.assertRaises(ValueError):
                    verify_resources(root, manifest, 'arm64')
                path.unlink()
                with self.subTest(missing=str(path)), self.assertRaises((ValueError, FileNotFoundError)):
                    verify_resources(root, manifest, 'arm64')
                path.write_bytes(original)
                if path == node:
                    path.chmod(0o755)
            workspace_alias = workspaces / 'domain'
            workspace_alias.unlink()
            workspace_alias.symlink_to('/etc')
            with self.assertRaises(ValueError):
                verify_resources(root, manifest, 'arm64')

    def test_inventory_controls(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary).resolve()
            package = root / 'web/node_modules/package'
            package.mkdir(parents=True)
            file = package / 'index.js'
            file.write_text('measured')
            roots = ['web/node_modules']
            expected = dependency_inventory(root, roots)
            self.assertEqual(dependency_inventory(root, roots), expected)
            file.write_text('changed')
            self.assertNotEqual(dependency_inventory(root, roots), expected)
            file.unlink()
            with self.assertRaises(ValueError):
                dependency_inventory(root, roots)
            file.write_text('measured')
            (package / 'extra.js').write_text('unmeasured')
            self.assertNotEqual(dependency_inventory(root, roots), expected)
            alias = package / 'alias'
            alias.symlink_to('/etc/passwd')
            with self.assertRaises(ValueError):
                dependency_inventory(root, roots)
            alias.unlink()
            alias.symlink_to('../../../missing')
            with self.assertRaises(FileNotFoundError):
                dependency_inventory(root, roots)
            alias.unlink()
            alias.symlink_to('index.js')
            linked = dependency_inventory(root, roots)
            alias.unlink()
            alias.symlink_to('extra.js')
            self.assertNotEqual(dependency_inventory(root, roots), linked)
        for bad in [None, {}, {'../escape': 'a'*64}, {'ok': 'invalid'}, {'/absolute': 'a'*64}]:
            with self.subTest(inventory=bad), self.assertRaises(ValueError):
                hash_map(bad)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--app', type=pathlib.Path)
    parser.add_argument('--manifest', type=pathlib.Path)
    parser.add_argument('--arch', choices=['arm64', 'x86_64'])
    parser.add_argument('--receipt', type=pathlib.Path)
    parser.add_argument('--self-test', action='store_true')
    args = parser.parse_args()
    if args.self_test:
        suite = unittest.defaultTestLoader.loadTestsFromTestCase(ParserTests)
        return 0 if unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful() else 1
    if not all((args.app, args.manifest, args.arch, args.receipt)):
        parser.error('--app, --manifest, --arch, and --receipt are required')
    receipt = {'status': 'failed', 'app': str(args.app), 'architecture': args.arch}
    try:
        receipt.update(verify(args.app, args.manifest, args.arch, receipt))
        receipt['status'] = 'passed'
    except Exception as error:
        receipt['error'] = str(error)
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps(receipt, indent=2, sort_keys=True)+'\n')
    print(json.dumps(receipt, sort_keys=True))
    return 0 if receipt['status'] == 'passed' else 1


if __name__ == '__main__':
    sys.exit(main())
