import diagnostics from 'node:diagnostics_channel';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const output = process.argv[2];
if (!output) throw new Error('Usage: inspect-node-routes.mjs OUTPUT_JSON');
const fixture = await mkdtemp(join(tmpdir(), 'pp-route-inventory-'));
process.env.PRINT_PARTNER_DATA_DIR = fixture;
process.env.PRINT_PARTNER_UPDATE_CHECK = '0';
process.env.AI_ENABLED = '0';
process.env.DEPLOY_MODE = 'self-host';
delete process.env.DATABASE_URL;
const { loadConfig } = await import(pathToFileURL(join(root, 'web/apps/server/dist/current/config.js')));
const { buildApp, createPorts } = await import(pathToFileURL(join(root, 'web/apps/server/dist/current/app.js')));
const config = loadConfig();
Object.assign(config, { dataDir: fixture, authRequired: true, registrationOpen: false, multiUser: false,
  singleUserAuth: false, trustProxy: false, staticDir: null, databaseUrl: null, deployMode: 'self-host' });
const registered = new Map();
const initialized = ({ fastify }) => {
  fastify.addHook('onRoute', options => {
    for (const method of Array.isArray(options.method) ? options.method : [options.method]) {
      registered.set(method + ' ' + options.url, { method, path: options.url, websocket: options.websocket === true });
    }
  });
};
diagnostics.channel('fastify.initialization').subscribe(initialized);
const ports = createPorts(config);
let app;
try {
  await ports.db.connect();
  app = await buildApp(config, ports);
  await app.ready();
  const printed = app.printRoutes({ commonPrefix: false });
  await writeFile(output + '.txt', printed);
  const routes = [...registered.values()];
  if (!routes.some(route => route.path === '/printers' && route.method === 'GET')) {
    throw new Error('Router output format changed or printer registration is missing');
  }
  routes.sort((a, b) => a.path.localeCompare(b.path, 'en') || a.method.localeCompare(b.method, 'en'));
  await writeFile(output, JSON.stringify({ mode: 'desktop-self-host', fixture, evidence: 'Fastify onRoute observed through fastify.initialization diagnostics; printRoutes retained as cross-check', routes }, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ fixture, routes: routes.length }) + '\n');
} finally {
  diagnostics.channel('fastify.initialization').unsubscribe(initialized);
  await app?.close();
  await ports.db.close();
}
