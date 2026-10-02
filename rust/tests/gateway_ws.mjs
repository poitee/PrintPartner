import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const require = createRequire(fileURLToPath(new URL('../../web/package.json', import.meta.url)));
const WebSocket = require('ws');
const input = JSON.parse(readFileSync(0, 'utf8'));
const base = input.origin.replace('http:', 'ws:');

function connection(path, { origin = input.origin, cookie = input.cookie, headers = {} } = {}) {
  return new WebSocket(base + path, { origin, headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers }, maxPayload: 65536 });
}
function denied(path, options, status) {
  return new Promise((resolve, reject) => {
    const ws = connection(path, options);
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('Denied handshake timed out')); }, 5000);
    ws.on('error', () => {});
    ws.on('open', () => { clearTimeout(timer); ws.terminate(); reject(new Error('Unexpected admitted handshake')); });
    ws.on('unexpected-response', (_request, response) => {
      clearTimeout(timer);
      response.resume();
      assert.equal(response.statusCode, status);
      ws.terminate();
      resolve(status);
    });
  });
}
function snapshot(path, options = {}) {
  return new Promise((resolve, reject) => {
    const ws = connection(path, options);
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('Snapshot timed out')); }, 5000);
    ws.once('error', reject);
    ws.once('message', bytes => { clearTimeout(timer); ws.close(); resolve(JSON.parse(bytes)); });
    ws.once('close', code => {
      clearTimeout(timer);
      if (code === 1008) resolve({ denied: code });
    });
  });
}
if (input.mode === 'hold') {
  const ws = connection('/ws/profile-sync');
  ws.once('open', () => process.stdout.write('{"ready":true}\n'));
  ws.once('error', error => { throw error; });
  const timer = setTimeout(() => { ws.terminate(); throw new Error('Shutdown did not close admitted upgrade'); }, 20000);
  ws.once('close', code => { clearTimeout(timer); process.stdout.write(JSON.stringify({ closed: true, code }) + '\n'); });
} else {
  const path = '/ws/jobs/' + encodeURIComponent(input.job_id);
  const missingCookie = await denied(path, { cookie: null }, 401);
  const foreignOrigin = await denied(path, { origin: 'http://foreign.invalid' }, 403);
  const first = await snapshot(path);
  const second = await snapshot(path);
  assert.deepEqual(second, first);
  assert.equal(first.job_id, input.job_id);
  assert.equal(first.status, 'done');
  const spoof = await snapshot(path, { headers: { 'x-tenant-id': 'foreign', 'x-pp-principal': '00', 'x-pp-signature': '00'.repeat(32), 'x-forwarded-user': 'foreign' } });
  assert.deepEqual(spoof, first);
  const missing = await snapshot('/ws/jobs/not-owned-or-missing');
  assert.equal(missing.denied, 1008);
  process.stdout.write(JSON.stringify({ job_id: input.job_id, snapshot: first.status, reconnect_snapshot_equal: true,
    missing_cookie_status: missingCookie, foreign_origin_status: foreignOrigin, caller_identity_spoof_ignored: true, missing_job_close: missing.denied }) + '\n');
}
