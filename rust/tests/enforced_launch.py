import argparse
import http.client
import json
import os
from pathlib import Path
import select
import shutil
import signal
import sqlite3
import subprocess
import tempfile
import time

parser = argparse.ArgumentParser()
parser.add_argument('--binary', type=Path, required=True)
parser.add_argument('--stage', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
stage = args.stage.resolve(strict=True)
release = json.loads((stage / 'release.json').read_text())
web = stage / release['web']
node = stage / release['node']
preload = web / 'apps/server/dist/current/desktop-resolution.js'
fixture = Path(tempfile.mkdtemp(prefix='enforced-launch-', dir=args.output))
ambient_marker = fixture / 'ambient-ran'
module_marker = fixture / 'optional-ran'
ambient = fixture / 'ambient.mjs'
ambient.write_text('import {writeFileSync} from "node:fs";writeFileSync(' + json.dumps(str(ambient_marker)) + ',"ran");\n')
optional = fixture / 'optional.cjs'
optional.write_text('require("node:fs").writeFileSync(' + json.dumps(str(module_marker)) + ',"ran");module.exports={};\n')
node_path = fixture / 'node_path'
(node_path / 'bufferutil').mkdir(parents=True)
shutil.copy2(optional, node_path / 'bufferutil/index.js')
ancestor = stage.parent / 'node_modules/bufferutil'
assert not ancestor.exists()
records = []

def start(package, data, credentials, env):
    return subprocess.Popen([str(args.binary.resolve()), '--web', str(package / release['web']),
        '--node', str(package / release['node']), '--data', str(data), '--commit', release['commit'],
        '--test-credential-file', str(credentials)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)

for mode in ['node_path', 'ancestor', 'symlink_ancestor']:
    if mode != 'node_path':
        ancestor.mkdir(parents=True)
        if mode == 'symlink_ancestor':
            (ancestor / 'index.js').symlink_to(optional)
        else:
            shutil.copy2(optional, ancestor / 'index.js')
    env = dict(os.environ, NODE_OPTIONS='--import=' + ambient.as_uri(), NODE_PATH=str(node_path))
    env.pop('WS_NO_BUFFER_UTIL', None)
    control = subprocess.run([str(node), *([] if mode == 'node_path' else ['--no-global-search-paths']),
                              '-e', 'require("ws");'], cwd=web, env=env, capture_output=True, text=True)
    assert control.returncode == 0, control.stderr
    assert ambient_marker.exists() and module_marker.exists(), mode
    ambient_marker.unlink()
    module_marker.unlink()
    data = fixture / (mode + '-data')
    credentials = fixture / (mode + '-credentials.json')
    process = start(stage, data, credentials, env)
    try:
        assert select.select([process.stdout], [], [], 60)[0], 'Enforced startup timed out'
        origin = process.stdout.readline().strip()
        assert origin.startswith('http://127.0.0.1:'), process.stderr.read()
        launch = json.loads(credentials.read_text())['bootstrap_url']
        cookie = None
        def request(path, method='GET', body=None):
            connection = http.client.HTTPConnection(origin.removeprefix('http://'), timeout=15)
            headers = {'Origin': origin}
            if cookie:
                headers['Cookie'] = cookie
            if body is not None:
                body = json.dumps(body).encode()
                headers['Content-Type'] = 'application/json'
            connection.request(method, path, body, headers)
            response = connection.getresponse()
            payload = response.read()
            assert response.status in [200, 201, 303], (response.status, payload[:200])
            values = response.headers
            connection.close()
            return json.loads(payload) if payload else None, values
        _, headers = request(launch.removeprefix(origin))
        cookie = headers['Set-Cookie'].split(';', 1)[0]
        state, _ = request('/__runtime')
        generations = []
        for generation in range(2):
            pid = state['compat']['pid']
            argv = Path(f'/proc/{pid}/cmdline').read_bytes().decode().rstrip('\0').split('\0')
            assert argv[1:] == ['--no-global-search-paths', '--import', str(preload.resolve()),
                                str(web / 'apps/server/dist/current/desktop.js'), '--pp-desktop-package-root=' + str(stage)], argv
            environment = Path(f'/proc/{pid}/environ').read_bytes().split(b'\0')
            names = {field.split(b'=', 1)[0] for field in environment}
            assert b'NODE_OPTIONS' not in names and b'NODE_PATH' not in names
            assert not ambient_marker.exists() and not module_marker.exists(), mode
            plan, _ = request('/plans', 'POST', {'name': f'{mode} generation {generation}'})
            with sqlite3.connect(f'file:{data}/print-partner.db?mode=ro', uri=True) as db:
                assert db.execute('SELECT name FROM build_profiles WHERE id = ?', [plan['id']]).fetchone()[0] == f'{mode} generation {generation}'
            generations.append({'pid': pid, 'argv': argv, 'injected_environment_absent': True,
                                'sentinels_absent': True, 'outside_package_sqlite_plan_id': plan['id']})
            if generation == 0:
                os.kill(pid, signal.SIGKILL)
                deadline = time.monotonic() + 40
                while time.monotonic() < deadline:
                    state, _ = request('/__runtime')
                    if state['compat'].get('state') == 'ready' and state['compat'].get('pid') != pid:
                        break
                    time.sleep(.1)
                assert state['compat'].get('state') == 'ready' and state['compat'].get('pid') != pid
        records.append({'mode': mode, 'unguarded_control_sentinels': True, 'generations': generations})
    finally:
        process.terminate()
        process.wait(timeout=20)
        assert process.returncode == 0, process.stderr.read()
        assert not (data / '.desktop-owner.json').exists()
        credentials.unlink(missing_ok=True)
        if mode != 'node_path':
            shutil.rmtree(ancestor)

negative_stage = fixture / 'negative-runtime'
subprocess.run(['cp', '-a', '--reflink=auto', str(stage), str(negative_stage)], check=True)
negative_preload = negative_stage / release['web'] / 'apps/server/dist/current/desktop-resolution.js'
original = negative_preload.read_bytes()
negative = []
for mode in ['missing', 'changed', 'outside_symlink']:
    if mode == 'missing':
        negative_preload.unlink()
    elif mode == 'changed':
        negative_preload.write_bytes(original + b'\nthrow new Error("changed");\n')
    else:
        negative_preload.unlink()
        negative_preload.symlink_to(ambient)
    data = fixture / (mode + '-data')
    credentials = fixture / (mode + '-credentials.json')
    process = start(negative_stage, data, credentials, os.environ.copy())
    stdout, stderr = process.communicate(timeout=40)
    assert process.returncode != 0 and not stdout.strip(), (mode, stdout, stderr)
    assert not (data / '.desktop-owner.json').exists() and not credentials.exists()
    assert not (data / 'print-partner.db').exists()
    negative.append({'case': mode, 'exit': process.returncode, 'before_owner_and_database': True, 'error': stderr.strip()})
    if negative_preload.exists() or negative_preload.is_symlink():
        negative_preload.unlink()
    negative_preload.write_bytes(original)
result = {'fixture': str(fixture), 'stage': str(stage), 'initial_and_restart_launches': records, 'preload_negatives': negative,
          'native_or_rendered_ui': False}
args.output.joinpath('enforced-launch-receipt.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
