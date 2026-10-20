"""Bounded, best-effort receipts for the disposable native image test."""
import json
from pathlib import Path
import plistlib
import shutil
import subprocess


def probe(directory, name, command, timeout=3):
    directory.mkdir(parents=True, exist_ok=True)
    receipt = {'command': command}
    output = b''
    try:
        result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                timeout=timeout)
        receipt['status'] = result.returncode
        output = result.stdout
    except subprocess.TimeoutExpired as error:
        receipt['error'] = 'TimeoutExpired'
        output = error.output or b''
    except OSError as error:
        receipt['error'] = str(error)
    receipt['output_bytes'] = len(output)
    receipt['truncated'] = len(output) > 1024 * 1024
    (directory / f'{name}.out').write_bytes(output[:1024 * 1024])
    (directory / f'{name}.json').write_text(json.dumps(receipt, indent=2) + '\n')
    return output


def census(root, real, phase):
    directory = root / 'diagnostics' / phase
    pid = root / 'holder.pid'
    if pid.exists():
        probe(directory, 'holder', ['ps', '-p', pid.read_text(), '-o', 'pid,ppid,state,command'])
    probe(directory, 'diskimage-iokit', ['ioreg', '-r', '-l', '-w', '0', '-c', 'IOHDIXHDDrive'])
    probe(directory, 'media-iokit', ['ioreg', '-r', '-l', '-w', '0', '-c', 'IOMedia'])
    raw = probe(directory, 'images', [real['hdiutil'], 'info', '-plist'])
    images = list(root.glob('pp-source-case.*/fixtures.sparseimage'))
    owned = []
    try:
        owned = [image for image in plistlib.loads(raw).get('images', [])
                 if any(Path(image['image-path']).resolve() == path.resolve() for path in images)]
    except (ValueError, plistlib.InvalidFileException, KeyError, TypeError):
        pass
    (directory / 'owned.json').write_text(json.dumps(owned, indent=2, default=str) + '\n')
    return owned


def before_force(root, real):
    if not (root / 'diagnostics' / 'before').exists():
        try:
            census(root, real, 'before')
        except (OSError, ValueError) as error:
            print(f'Native diagnostic receipt failed: {error}', flush=True)


def force_status(root, command, status):
    try:
        with (root / 'diagnostics' / 'force-status.jsonl').open('a') as output:
            output.write(json.dumps({'command': command, 'status': status}) + '\n')
    except OSError as error:
        print(f'Native force receipt failed: {error}', flush=True)


def after_workflow(root, real):
    census(root, real, 'after')
    directory = root / 'diagnostics' / 'after'
    before = root / 'diagnostics' / 'before' / 'owned.json'
    owned = json.loads(before.read_text()) if before.exists() else []
    devices = sorted({entity['dev-entry'] for image in owned
                      for entity in image.get('system-entities', []) if 'dev-entry' in entity})
    nodes = sorted(set(devices + [device.replace('/dev/disk', '/dev/rdisk', 1)
                                  for device in devices if device.startswith('/dev/disk')]))
    paths = [str(path) for path in root.glob('pp-source-case.*/fixtures.sparseimage')]
    if paths:
        probe(directory, 'holders', [real['lsof'], '-nP', *paths, *nodes])
        probe(directory, 'privileged-holders', ['sudo', '-n', real['lsof'], '-nP', *paths, *nodes])
    for device in devices:
        name = Path(device).name
        probe(directory, f'{name}-diskutil', ['diskutil', 'info', device])
    if devices:
        identifiers = ' OR '.join(f'eventMessage CONTAINS "{Path(d).name}"' for d in devices)
        sources = ('process == "kernel" OR process == "diskarbitrationd" OR '
                   'process == "diskimages-helper" OR process CONTAINS[c] "fskit" OR '
                   'subsystem CONTAINS[c] "DiskImages" OR subsystem CONTAINS[c] "FSKit"')
        probe(directory, 'system-log', ['sudo', '-n', '/usr/bin/log', 'show', '--last', '2m',
                                     '--style', 'compact', '--predicate',
                                     f'({sources}) AND ({identifiers})'], timeout=10)


def retain(root, destination, output):
    """Copy receipts before assertions or disposable-fixture cleanup can fail."""
    destination = Path(destination) / root.name
    shutil.copytree(root / 'diagnostics', destination, dirs_exist_ok=True)
    (destination / 'workflow.txt').write_text(output)
    shutil.copy2(root / 'trace', destination / 'trace')
    return destination
