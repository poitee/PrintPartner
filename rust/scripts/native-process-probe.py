import argparse
import json
import pathlib
import subprocess
import tempfile
import os
import signal
import sys


def validate(returncode, stdout, stderr, data):
    assert returncode == 0, {'exit': returncode, 'stderr': stderr[-2000:]}
    records = [json.loads(line) for line in stdout.strip().splitlines()]
    receipt = records[-1]
    window = next(record['native_window'] for record in records if 'native_window' in record)
    assert window.get('close_hid') is True and window.get('show_visible') is True, window
    assert (
        receipt.get('compat_reaped') is True
        and receipt.get('storage_released') is True
        and receipt.get('gateway_stopped') is True
        and receipt.get('marker_removed') is True
        and receipt.get('runtime_removed') is True
        and receipt.get('errors') == []
    ), receipt
    assert not (data / '.desktop-owner.json').exists()
    return receipt, window


def self_test():
    window = {'close_hid': True, 'show_visible': True}
    receipt = {
        'compat_reaped': True,
        'storage_released': True,
        'gateway_stopped': True,
        'marker_removed': True,
        'runtime_removed': True,
        'errors': [],
    }
    with tempfile.TemporaryDirectory(prefix='pp-native-self-test-') as fixture:
        data = pathlib.Path(fixture)

        def check(code=0, native=window, shutdown=receipt):
            stdout = json.dumps({'native_window': native}) + '\n' + json.dumps(shutdown) + '\n'
            return validate(code, stdout, 'fixture stderr', data)

        assert check() == (receipt, window)
        failures = [lambda: check(code=1)]
        for key in ('close_hid', 'show_visible'):
            for value in (False, None, 0, 1, 'true', [True], {'ok': True}):
                failures.append(lambda key=key, value=value: check(native={**window, key: value}))
            failures.append(lambda key=key: check(native={name: value for name, value in window.items() if name != key}))
        for key in ('compat_reaped', 'storage_released', 'gateway_stopped', 'marker_removed', 'runtime_removed'):
            for value in (False, None, 0, 1, 'true', [True], {'ok': True}):
                failures.append(lambda key=key, value=value: check(shutdown={**receipt, key: value}))
            failures.append(lambda key=key: check(shutdown={name: value for name, value in receipt.items() if name != key}))
        for value in (['fixture error'], None, False, '', {}):
            failures.append(lambda value=value: check(shutdown={**receipt, 'errors': value}))
        failures.append(lambda: check(shutdown={name: value for name, value in receipt.items() if name != 'errors'}))
        for failure in failures:
            try:
                failure()
            except AssertionError:
                pass
            else:
                raise AssertionError('Invalid native process evidence was accepted')
        (data / '.desktop-owner.json').touch()
        try:
            check()
        except AssertionError:
            pass
        else:
            raise AssertionError('Leaked desktop owner was accepted')
    print(f'PASS: native-process-probe self-tests (valid receipt and {len(failures) + 1} rejected failures)')


if '--self-test' in sys.argv[1:]:
    parser = argparse.ArgumentParser()
    parser.add_argument('--self-test', action='store_true')
    parser.parse_args()
    self_test()
    raise SystemExit(0)

parser = argparse.ArgumentParser()
parser.add_argument('--binary', type=pathlib.Path, required=True)
parser.add_argument('--stage', type=pathlib.Path, required=True)
parser.add_argument('--sdk', type=pathlib.Path, required=True)
parser.add_argument('--receipt', type=pathlib.Path, required=True)
args = parser.parse_args()
fixture = pathlib.Path(tempfile.mkdtemp(prefix='pp-native-'))
data = fixture / 'data'
data.mkdir()
(fixture / 'runtime').mkdir(mode=0o700)
sdk = args.sdk.resolve(strict=True)
helpers = sdk / 'usr/lib/x86_64-linux-gnu/webkit2gtk-4.1'
aliases = fixture / 'system-libraries'
aliases.mkdir()
command = ['xvfb-run', '-a', 'bwrap', '--ro-bind', '/', '/', '--dev-bind', '/dev', '/dev',
    '--proc', '/proc', '--bind', str(fixture), str(fixture),
    '--ro-bind', '/usr/lib/x86_64-linux-gnu', str(aliases), '--tmpfs', '/usr/lib/x86_64-linux-gnu',
    '--ro-bind', '/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2', '/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2',
    '--dir', '/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1', '--ro-bind', str(helpers), '/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1',
    '--setenv', 'XDG_DATA_HOME', str(fixture / 'share'), '--setenv', 'XDG_CACHE_HOME', str(fixture / 'cache'),
    '--setenv', 'TMPDIR', str(fixture / 'runtime'),
    '--setenv', 'XDG_RUNTIME_DIR', str(fixture / 'runtime'),
    '--setenv', 'LD_LIBRARY_PATH', str(aliases)+':'+str(sdk / 'usr/lib/x86_64-linux-gnu'),
    '--setenv', 'WEBKIT_DISABLE_COMPOSITING_MODE', '1', '--setenv', 'WEBKIT_DISABLE_DMABUF_RENDERER', '1',
    '--setenv', 'WEBKIT_DMABUF_RENDERER_FORCE_SHM', '1', '--setenv', 'WEBKIT_SKIA_ENABLE_CPU_RENDERING', '1',
    '--setenv', 'LIBGL_ALWAYS_SOFTWARE', '1', str(args.binary.resolve(strict=True)),
    '--dev-stage', str(args.stage.resolve(strict=True)), '--data', str(data), '--test-exit-seconds', '3']
process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
try:
    stdout, stderr = process.communicate(timeout=75)
except subprocess.TimeoutExpired:
    os.killpg(process.pid, signal.SIGTERM)
    try:
        stdout, stderr = process.communicate(timeout=20)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        stdout, stderr = process.communicate()
    args.receipt.with_suffix('.stderr.log').write_text(stderr)
    args.receipt.with_suffix('.stdout.log').write_text(stdout)
    raise AssertionError('Native process probe timed out')
args.receipt.with_suffix('.stderr.log').write_text(stderr)
args.receipt.with_suffix('.stdout.log').write_text(stdout)
receipt, window = validate(process.returncode, stdout, stderr, data)
args.receipt.write_text(json.dumps({'proof_class': 'native_linux_unsigned_process', 'fixture': str(fixture),
    'command': command, 'exit_code': process.returncode, 'shutdown': receipt, 'native_window': window,
    'rendered_ui': False, 'macos': False}, indent=2)+'\n')
print(args.receipt.read_text())
