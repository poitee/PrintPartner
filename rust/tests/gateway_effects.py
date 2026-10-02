import http.client
import json
from pathlib import Path
import re
import select
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[2]
COMMIT = json.loads((ROOT / 'rust/bundle-manifest.json').read_text())['commit']
FAMILIES = {'/integrations/:id/spoolman/filaments', '/integrations/:id/spoolman/spools',
            '/plans/:id/review', '/plans/:id/role-filaments', '/plans/:id/checkoff'}


def main():
    hits = []
    class Spoolman(BaseHTTPRequestHandler):
        def do_GET(self):
            hits.append(self.path)
            if self.path == '/api/v1/filament':
                result = [{'id': 7, 'name': 'Local witness PLA', 'material': 'PLA', 'color_hex': '12ab34'}]
            elif self.path == '/api/v1/spool':
                result = [{'id': 3, 'filament_id': 7, 'remaining_weight': 412.5, 'location': 'Local fixture'}]
            else:
                raise AssertionError(self.path)
            body = json.dumps(result).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            return

    fixture = Path(tempfile.mkdtemp(prefix='pp-gateway-effects-'))
    credentials = fixture / 'credentials.json'
    witness = ThreadingHTTPServer(('127.0.0.1', 0), Spoolman)
    thread = threading.Thread(target=witness.serve_forever)
    thread.start()
    process = subprocess.Popen([
        str(ROOT / 'rust/target/debug/pp-server'), '--data', str(fixture / 'data'),
        '--web', str(ROOT / 'web'), '--node', '/usr/bin/node', '--commit', COMMIT,
        '--test-credential-file', str(credentials),
    ], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    cookie = None
    origin = None
    def request(path, method='GET', body=None, origin_header=True, site=None, allowed=(200, 201), key=None):
        headers = {}
        if cookie:
            headers['Cookie'] = cookie
        if origin_header:
            headers['Origin'] = origin
        if site:
            headers['Sec-Fetch-Site'] = site
        if key:
            headers['Idempotency-Key'] = key
        if isinstance(body, dict):
            headers['Content-Type'] = 'application/json'
            body = json.dumps(body).encode()
        if isinstance(body, tuple):
            headers['Content-Type'], body = body
        connection = http.client.HTTPConnection(origin.removeprefix('http://'), timeout=20)
        try:
            connection.request(method, path, body, headers)
            response = connection.getresponse()
            data = response.read()
            assert response.status in allowed, (method, path, response.status, data[:300])
            return json.loads(data) if data else None, response.headers
        finally:
            connection.close()

    try:
        assert select.select([process.stdout], [], [], 40)[0]
        origin = process.stdout.readline().strip()
        launch = json.loads(credentials.read_text())['bootstrap_url']
        _, headers = request(launch.removeprefix(origin), origin_header=False, allowed=(303,))
        cookie = headers['Set-Cookie'].split(';', 1)[0]
        integration, _ = request('/api/v1/integrations', 'POST', {'type': 'spoolman', 'name': 'Local witness',
                    'config': {'base_url': f'http://127.0.0.1:{witness.server_port}', 'enabled': True}})
        source, _ = request('/sources', 'POST', {'name': 'Local policy fixture', 'source_kind': 'local'})
        stl = (ROOT / 'rust/tests/fixtures/part.stl').read_bytes()
        boundary = 'policy-local-upload'
        body = (f'--{boundary}\r\nContent-Disposition: form-data; name="files"; filename="part.stl"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode() + stl +
                f'\r\n--{boundary}\r\nContent-Disposition: form-data; name="relative_paths"\r\n\r\n["part.stl"]\r\n--{boundary}--\r\n'.encode())
        request(f'/sources/{source["id"]}/upload-files', 'POST', (f'multipart/form-data; boundary={boundary}', body))
        plan, _ = request('/plans', 'POST', {'name': 'Local policy proof'})
        plan_id = plan['id']
        request(f'/plans/{plan_id}/layers/base', 'PUT', {'project_id': source['id']})
        workspace, _ = request(f'/plans/{plan_id}/drafts/recompute', 'POST', {'apply_manifest': True}, key='policy-prepare')
        draft = workspace['draft']
        request(f'/plans/{plan_id}/drafts/{draft["draft_id"]}/apply', 'POST', {
            'expected_snapshot_digest': draft['snapshot_digest'], 'expected_lifecycle_version': draft['lifecycle_version'],
            'expected_base': draft['base']}, key='policy-publish')
        parts, _ = request(f'/plans/{plan_id}/parts')
        assignment, _ = request(f'/plans/{plan_id}/role-filament', 'PUT', {
            'role': parts['parts'][0].get('role') or 'primary',
            'filament_color_id': f'spoolman:{integration["id"]}:filament:7', 'refresh_thumbnails': False})
        assert assignment['updated'] >= 1, assignment
        registry = json.loads((ROOT / 'rust/crates/pp-gateway/operations.json').read_text())
        routes = [route for route in registry['routes'] if route['method'] in ['GET', 'HEAD']
                  and re.sub(r'^/api/v[12](?=/|$)', '', route['path']) in FAMILIES]
        assert {re.sub(r'^/api/v[12](?=/|$)', '', route['path']) for route in routes} == FAMILIES
        receipts = []
        for route in routes:
            identity = integration['id'] if '/integrations/' in route['path'] else str(plan_id)
            path = route['path'].replace(':id', identity)
            for site in [None, 'same-site']:
                before = len(hits)
                request(path, route['method'], origin_header=False, site=site, allowed=(403,))
                assert len(hits) == before, (path, site, hits[before:])
                receipts.append({'method': route['method'], 'path': path, 'origin': None,
                                 'sec_fetch_site': site, 'status': 403, 'provider_hits': []})
            before = len(hits)
            request(path, route['method'])
            actual = hits[before:]
            assert actual, ('authorized request missed witness', route)
            receipts.append({'method': route['method'], 'path': path, 'origin': 'exact', 'status': 200, 'provider_hits': actual})
            if route['method'] == 'GET':
                before = len(hits)
                request(path, origin_header=False, site='same-origin')
                actual = hits[before:]
                assert actual, ('browser request missed witness', route)
                receipts.append({'method': 'GET', 'path': path, 'origin': None,
                                 'sec_fetch_site': 'same-origin', 'status': 200, 'provider_hits': actual})
        pure = []
        for path in ['/printers', '/api/v1/printers', '/api/v1/integrations']:
            before = len(hits)
            request(path, origin_header=False, site='same-site')
            assert len(hits) == before
            pure.append({'path': path, 'status': 200, 'provider_hits': []})
        guarded_key_listing = []
        for method in ['GET', 'HEAD']:
            request('/settings/api-keys', method, origin_header=False, site='same-site', allowed=(403,))
            request('/settings/api-keys', method)
            guarded_key_listing.append({'method': method, 'same_site_status': 403, 'exact_origin_status': 200})
        result = {'guarded_key_listing': guarded_key_listing, 'fixture': str(fixture), 'corrected_registered_reads': len(routes),
                  'denied_requests': sum(row['status'] == 403 for row in receipts),
                  'authorized_requests': sum(row['status'] == 200 for row in receipts),
                  'witness_hits_total': len(hits), 'requests': receipts, 'pure_observations': pure}
        (fixture / 'receipt.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result))
    finally:
        process.terminate()
        process.wait(timeout=20)
        witness.shutdown()
        thread.join(timeout=5)
        witness.server_close()
        credentials.unlink(missing_ok=True)
        assert process.returncode == 0, process.stderr.read()
        assert not (fixture / 'data/.desktop-owner.json').exists()


if __name__ == '__main__':
    main()
