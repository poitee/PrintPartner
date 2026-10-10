import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
const root = process.env.GRE510_REPO;
const { loadConfig } = await import(pathToFileURL(join(root, 'web/apps/server/src/config.ts')));
const { startServer, buildApp } = await import(pathToFileURL(join(root, 'web/apps/server/src/app.ts')));
const nativeFetch = globalThis.fetch;
// Make an actual public GitHub update check long enough to restart the API.
// Neither its response nor any job/socket/poll response is substituted.
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (new URL(url).hostname === 'api.github.com') await new Promise(r => setTimeout(r, 25000));
  return nativeFetch(input, init);
};
const config = loadConfig();
let { app, ports } = await startServer(config);
const localPath = join(config.dataDir, 'evidence-source');
await mkdir(localPath, { recursive: true });
if (!ports.repository.listSources().some(s => s.name === 'Reconnect evidence')) ports.repository.createSource({ name: 'Reconnect evidence', source_kind: 'github', url: 'https://github.com/poitee/PrintPartner', branch: 'main', local_path: localPath });
if (!ports.repository.listSources().some(s => s.name === 'Reconnect evidence 2')) ports.repository.createSource({ name: 'Reconnect evidence 2', source_kind: 'github', url: 'https://github.com/poitee/PrintPartner', branch: 'main', local_path: localPath });
await writeFile('/tmp/gre510-api.pid', String(process.pid));
let restarting = false;
process.on('SIGUSR2', async () => {
  if (restarting) return;
  restarting = true;
  console.log('EVIDENCE ' + new Date().toISOString() + ' API close requested');
  await app.close(); // Real @fastify/websocket graceful close: no close code.
  await new Promise(r => setTimeout(r, 3500));
  app = await buildApp(config, ports); // Keep the real in-process job runner alive.
  await app.listen({ host: config.host, port: config.port });
  console.log('EVIDENCE ' + new Date().toISOString() + ' API listener restarted; worker retained');
  restarting = false;
});
process.on('SIGTERM', async () => { await app.close(); await ports.db.close(); process.exit(0); });
