import json
import argparse
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import time
import urllib.request
import urllib.error
import gi
gi.require_version('Gdk', '3.0')
from gi.repository import Gdk

root = Path(__file__).resolve().parent
repo = Path.cwd()
parser = argparse.ArgumentParser()
parser.add_argument('--seed-binary', default='/tmp/pr125-evidence/pp-server-stage')
parser.add_argument('--seed-stage', type=Path, default=Path('/tmp/pr125-evidence/runtime'))
parser.add_argument('--seed-commit', default='9fea133c96f161cff4a7cc4ddb1504dd1862251d')
args = parser.parse_args()
home = root / 'isolated-home'
data = home / '.print-partner'
home.mkdir(exist_ok=True)
(root / 'tmp').mkdir(exist_ok=True)
(root / 'tmp').chmod(0o700)
credentials = root / 'seed-credentials.json'
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
seed_errors = (root / 'legacy-seed.stderr.log').open('w')
# The preceding source head's verified server models the existing installation.
server = subprocess.Popen([args.seed_binary, '--data', str(data),
    '--web', str(args.seed_stage/'web'), '--node', str(args.seed_stage/'bin/node'),
    '--commit', args.seed_commit,
    '--test-credential-file', str(credentials)], stdout=subprocess.PIPE, stderr=seed_errors, text=True)
try:
    origin = server.stdout.readline().strip()
    assert origin.startswith('http://127.0.0.1:'), origin
    launch = json.loads(credentials.read_text())['bootstrap_url']
    try:
        response = opener.open(urllib.request.Request(launch, headers={'Origin': origin}))
    except urllib.error.HTTPError as error:
        response = error
    assert response.status == 303
    cookie = response.headers['Set-Cookie'].split(';', 1)[0]
    request = urllib.request.Request(origin + '/plans', data=json.dumps({'name':'Saved desktop Build'}).encode(),
        headers={'Cookie':cookie, 'Origin':origin, 'Content-Type':'application/json'}, method='POST')
    with opener.open(request) as response:
        saved = json.load(response)
    assert saved['name'] == 'Saved desktop Build', saved
finally:
    server.terminate()
    assert server.wait(timeout=30) == 0
    credentials.unlink(missing_ok=True)
    seed_errors.close()
assert not (data / '.desktop-owner.json').exists()
database = data / 'print-partner.db'
assert database.is_file()
before_inode = database.stat().st_ino
env = dict(os.environ, WEBKIT_DISABLE_COMPOSITING_MODE='1', LIBGL_ALWAYS_SOFTWARE='1')
services = [subprocess.Popen(['openbox'], env=env), subprocess.Popen(['tint2','-c',str(root/'tint2rc')],env=env)]
stdout = (root / 'legacy-native.stdout.log').open('w')
stderr = (root / 'legacy-native.stderr.log').open('w')
# Mount our fresh home over the real home without changing HOME or touching
# developer data. The app receives no --data override.
app = subprocess.Popen(['bwrap','--ro-bind','/','/','--bind',str(root),str(root),
    '--bind',str(home),str(Path(os.environ['HOME']).resolve()),'--dev-bind','/dev','/dev','--proc','/proc',
    '--setenv','TMPDIR',str(root/'tmp'),'--setenv','XDG_RUNTIME_DIR',str(root/'tmp'),
    str(repo/'rust/target/debug/pp-desktop'),
    '--dev-stage',str(root/'runtime'),'--test-exit-seconds','30'],
    env=env,stdout=stdout,stderr=stderr)
try:
    for _ in range(150):
        if (data/'.desktop-owner.json').exists():
            break
        assert app.poll() is None, 'Native app exited before opening legacy data'
        time.sleep(.1)
    assert (data/'.desktop-owner.json').exists()
    for _ in range(300):
        if 'close_hid' in (root/'legacy-native.stdout.log').read_text():
            break
        assert app.poll() is None, 'Native app exited before window readiness'
        time.sleep(.1)
    else:
        raise RuntimeError('Native window readiness timed out')
    time.sleep(6)
    assert database.stat().st_ino == before_inode
    window = Gdk.get_default_root_window()
    Gdk.pixbuf_get_from_window(window,0,0,window.get_width(),window.get_height()).savev(
        str(root/'native-legacy-build.png'),'png',[],[])
    assert app.wait(timeout=45) == 0
    assert not (data/'.desktop-owner.json').exists()
    assert not list(home.glob('.local/share/**/core/print-partner.db'))
    with sqlite3.connect(database) as db:
        tables = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")]
        found = []
        for table in tables:
            quoted = '"' + table.replace('"','""') + '"'
            for row in db.execute('SELECT * FROM '+quoted):
                if 'Saved desktop Build' in row:
                    found.append(table)
        assert found, 'Saved Build disappeared'
    (root/'legacy-home-receipt.json').write_text(json.dumps({
        'head':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),
        'default_data_override':False,'legacy_directory': '~/.print-partner',
        'saved_build':saved,'same_database_inode':True,'saved_row_tables':found,
        'normal_exit':0,'owner_marker_removed':True,'new_platform_store_created':False,
        'screenshot':'native-legacy-build.png'},indent=2))
finally:
    if app.poll() is None:
        app.terminate()
        app.wait(timeout=30)
    for service in services:
        service.terminate()
    stdout.close()
    stderr.close()
