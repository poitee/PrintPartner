import ctypes
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import time
import tempfile
import xml.etree.ElementTree as ET
import gi
gi.require_version('Gdk', '3.0')
from gi.repository import Gdk, Gio, GLib

root = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument('--repo', type=Path, default=Path.cwd())
repo = parser.parse_args().repo.resolve()
data = Path(tempfile.mkdtemp(prefix='native-data-', dir=root))
env = dict(os.environ, WEBKIT_DISABLE_COMPOSITING_MODE='1', LIBGL_ALWAYS_SOFTWARE='1')
services = [subprocess.Popen(['openbox'], env=env), subprocess.Popen(['tint2', '-c', str(root / 'tint2rc')], env=env)]
log = (root / 'native.stdout.log').open('w')
err = (root / 'native.stderr.log').open('w')
app = subprocess.Popen([str(repo / 'rust/target/debug/pp-desktop'), '--dev-stage', str(root / 'runtime'), '--data', str(data), '--test-exit-seconds', '3600'], env=env, stdout=log, stderr=err)
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
events = []
menu_address = None

def call(name, path, interface, method, args):
    return bus.call_sync(name, path, interface, method, args, None, Gio.DBusCallFlags.NONE, 3000, None).unpack()

def menu():
    global menu_address
    if menu_address:
        name, path = menu_address
        return str(call(name, path, 'com.canonical.dbusmenu', 'GetLayout', GLib.Variant('(iias)', (0, -1, []))))
    names = call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames', None)[0]
    for name in names:
        if 'StatusNotifierItem' in name or name.startswith(':1.'):
            pending = ['/']
            while pending:
                item_path = pending.pop()
                try:
                    xml = ET.fromstring(call(name, item_path, 'org.freedesktop.DBus.Introspectable', 'Introspect', None)[0])
                    pending.extend(item_path.rstrip('/') + '/' + n.attrib['name'] for n in xml.findall('node'))
                    if any(n.attrib['name'] == 'org.kde.StatusNotifierItem' for n in xml.findall('interface')):
                        props = call(name, item_path, 'org.freedesktop.DBus.Properties', 'GetAll', GLib.Variant('(s)', ('org.kde.StatusNotifierItem',)))[0]
                        menu_address = (name, props['Menu'])
                        return menu()
                except GLib.Error:
                    pass
    return ''

def shot(name):
    window = Gdk.get_default_root_window()
    pixbuf = Gdk.pixbuf_get_from_window(window, 0, 0, window.get_width(), window.get_height())
    pixbuf.savev(str(root / (name + '.png')), 'png', [], [])
    events.append({'screenshot': name + '.png', 'menu': menu(), 'seconds': round(time.monotonic() - start, 2)})
    (root / 'native-events.json').write_text(json.dumps(events, indent=2))

start = time.monotonic()
try:
    for attempt in range(90):
        if attempt == 8:
            shot('native-startup')
            (root / 'dbus-names.json').write_text(json.dumps(call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames', None)[0]))
        if 'Service ready' in menu():
            break
        if app.poll() is not None:
            raise RuntimeError('Native app exited before ready')
        time.sleep(1)
    else:
        raise RuntimeError('Native tray did not become ready')
    time.sleep(8)
    shot('native-ready')
    # Open the actual tray menu. The full root screenshot records its position.
    subprocess.run(['xdotool', 'mousemove', '1418', '982', 'click', '3'], check=True)
    time.sleep(1)
    shot('tray-ready')
    marker = json.loads((data / '.desktop-owner.json').read_text())
    runtime = Path(marker['runtime_dir'])
    children = {int(value) for task in Path(f'/proc/{app.pid}/task').glob('*/children') for value in task.read_text().split()}
    child = next(pid for pid in children if Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')[0] == os.fsencode(root / 'runtime/bin/node'))
    # Suspend only our compatibility child: three health misses cause real stopping.
    os.kill(child, signal.SIGSTOP)
    for _ in range(90):
        if 'Service stopping' in menu():
            shot('tray-stopping')
            break
        time.sleep(0.5)
    else:
        raise RuntimeError('Stopping state not observed')
    # Force the same isolated socket-cleanup failure as runtime_m0's regression.
    socket = next(runtime.glob('*.sock'))
    socket.rename(runtime / 'retained-socket')
    socket.mkdir()
    for _ in range(30):
        if 'Service failed' in menu():
            shot('tray-failed')
            break
        time.sleep(0.5)
    else:
        raise RuntimeError('Failed state not observed')
    socket.rmdir()
    (runtime / 'retained-socket').unlink(missing_ok=True)
    os.kill(app.pid, signal.SIGTERM)
    code = app.wait(timeout=30)
    assert code == 1, ('Intentional cleanup failure must fail exit', code)
    events.append({'exit': code, 'expected_failure': True, 'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip()})
    (root / 'native-events.json').write_text(json.dumps(events, indent=2))
finally:
    if app.poll() is None:
        app.terminate()
        try:
            app.wait(timeout=30)
        except subprocess.TimeoutExpired:
            app.kill()
    for service in services:
        service.terminate()
    log.close()
    err.close()
