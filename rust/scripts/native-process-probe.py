import argparse
import json
import pathlib
import subprocess
import tempfile
import os
import signal

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
assert process.returncode == 0, {'exit': process.returncode, 'stderr': stderr[-2000:]}
records = [json.loads(line) for line in stdout.strip().splitlines()]
receipt = records[-1]
window = next(record['native_window'] for record in records if 'native_window' in record)
assert window['close_hid'] and window['show_visible'], window
assert receipt['compat_reaped'] and receipt['storage_released'] and receipt['gateway_stopped'] and not receipt['errors'], receipt
assert not (data / '.desktop-owner.json').exists()
args.receipt.write_text(json.dumps({'proof_class': 'native_linux_unsigned_process', 'fixture': str(fixture),
    'command': command, 'exit_code': process.returncode, 'shutdown': receipt, 'native_window': window,
    'rendered_ui': False, 'macos': False}, indent=2)+'\n')
print(args.receipt.read_text())
