import argparse
import hashlib
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument('inventory', type=pathlib.Path)
parser.add_argument('--check', action='store_true')
parser.add_argument('--self-test', action='store_true')
args = parser.parse_args()
registered = json.loads(args.inventory.read_text())['routes']


def base(path):
    return re.sub(r'^/api/v[12](?=/|$)', '', path) or '/'


def denied(method, path):
    bare = base(path)
    if method == 'OPTIONS':
        return 'Cross-origin API access is disabled'
    if bare == '/mcp':
        return 'MCP requires separately verified API-key authorization'
    if path.startswith('/auth/') and path not in ['/auth/me', '/auth/logout']:
        return 'Native bootstrap owns desktop authentication; OAuth and development login are unavailable'
    if path.startswith('/api/v1/docs') or bare in ['/openapi.json', '/metrics']:
        return 'Server administration and API documentation are outside the desktop product'
    if bare.startswith('/admin/'):
        return 'Server-path administrative import is unavailable in desktop'
    if bare == '/settings/external-access' and method != 'GET' and method != 'HEAD':
        return 'LAN access remains disabled in desktop'
    if re.fullmatch(r'/slicer-instances/[^/]+/docker-[^/]+', bare):
        return 'Docker lifecycle and logs are unavailable in this native foundation'
    return None


PURE_READS = {
    '/printers': 'routes/printers.ts:160 -> services/printer-fleet.ts:103 loadFleet only parses repo.getSetting',
    '/integrations': 'routes/integrations.ts:26 -> integrations/store.ts:155 list projects stored settings and adapter capabilities without calling providers',
}


def effect(method, path):
    bare = base(path)
    if method in ['GET', 'HEAD']:
        if bare == '/settings/api-keys':
            return 'local_commit', 'services/api-key-manager.ts:46 loadKeys may migrate legacy key hashes and persist settings'
        if bare == '/settings/update-check':
            return 'local_commit', 'May reset the local update-check cache; desktop disables remote update checks'
        if bare == '/printer-checkoff':
            return 'local_commit', 'Repairs incomplete accepted printer links before returning them'
        if bare in PURE_READS:
            return 'observation', PURE_READS[bare]
        return 'external_effect', 'Conservatively guarded GET/HEAD: no audited pure-read exception; provider or local effects may occur'
    external = (
        bare.startswith(('/sources', '/assistant', '/slicer-instances', '/reference-shares/imports'))
        or bare in ['/jobs/sync', '/jobs/check-source-updates', '/jobs/extract-source-docs', '/jobs/printer-upload',
                    '/api/discord-digest', '/settings/discord-notify/test', '/integrations/:id/test',
                    '/printer-checkoff/verify', '/printer-checkoff/reconcile', '/printer-checkoff/:id/recheck-remote-file',
                    '/printer-send-queue/drain', '/printer-send-queue/:id/dispatch', '/bambu-connect/handoff']
    )
    return ('external_effect', 'May start provider work, background acquisition or external delivery') if external else (
        'local_commit', 'Node owns the complete local transaction or file publication')


if args.self_test:
    corrected = {'/integrations/:id/spoolman/filaments', '/integrations/:id/spoolman/spools',
                 '/plans/:id/review', '/plans/:id/role-filaments', '/plans/:id/checkoff'}
    observed = [route for route in registered if route['method'] in ['GET', 'HEAD'] and base(route['path']) in corrected]
    assert {base(route['path']) for route in observed} == corrected
    for route in observed:
        assert effect(route['method'], route['path'])[0] == 'external_effect', route
    for method in ['GET', 'HEAD']:
        for prefix in ['', '/api/v1', '/api/v2']:
            assert effect(method, prefix + '/future/unreviewed-provider-read')[0] == 'external_effect'
            assert effect(method, prefix + '/settings/api-keys')[0] == 'local_commit'
            for pure in PURE_READS:
                classification, evidence = effect(method, prefix + pure)
                assert classification == 'observation' and evidence == PURE_READS[pure]
    print(json.dumps({'corrected_registered_reads': len(observed), 'unknown_reads_guarded': 6,
                      'pure_exception_families': len(PURE_READS)}))

routes = []
exclusions = []
for registered_route in sorted(registered, key=lambda route: (route['path'], route['method'])):
    method, path = registered_route['method'], registered_route['path']
    reason = denied(method, path)
    if reason:
        exclusions.append({'method': method, 'path': path, 'reason': reason})
        continue
    classification, effect_reason = effect(method, path)
    contract = 'legacy-v1' if path.startswith('/api/v1/plans') else 'current'
    operation = ('GET' if method == 'HEAD' else method) + ' ' + re.sub(r':[^/]+', ':param', base(path)) + ' ' + contract
    routes.append({'method': method, 'path': path, 'owner': 'compat', 'effect': classification,
                   'operation': operation, 'contract': contract, 'websocket': registered_route['websocket'],
                   'effect_reason': effect_reason})
normalized = json.dumps(sorted(registered, key=lambda route: (route['path'], route['method'])), sort_keys=True, separators=(',', ':'))
result = {'scope': 'Observed desktop self-host registration; Node owns domain/background/file effects',
          'registry_sha256': hashlib.sha256(normalized.encode()).hexdigest(),
          'gateway_owned': [{'method': 'POST', 'path': '/auth/logout', 'reason': 'Revokes the desktop session locally'}],
          'routes': routes, 'denied': exclusions}
encoded = json.dumps(result, indent=2) + '\n'
output = ROOT / 'rust/crates/pp-gateway/operations.json'
if args.check:
    if output.read_text() != encoded:
        raise SystemExit('Gateway registry differs from actual registered routes and policy; regenerate and review')
else:
    output.write_text(encoded)
print(json.dumps({'registered': len(registered), 'admitted': len(routes), 'explicitly_denied': len(exclusions),
                  'registry_sha256': result['registry_sha256']}))
