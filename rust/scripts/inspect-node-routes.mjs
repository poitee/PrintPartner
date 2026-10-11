import diagnostics from 'node:diagnostics_channel';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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
// Inventory development-only routes too; never inherit workstation auth settings.
process.env.NODE_ENV = 'test';
const { loadConfig } = await import(pathToFileURL(join(root, 'web/apps/server/dist/current/config.js')));
const { buildApp, createPorts } = await import(pathToFileURL(join(root, 'web/apps/server/dist/current/app.js')));
// Static asset filenames belong to the web build, not the Node API inventory.
// Probe every auth mode separately: a route's auth can differ per mode (e.g. MCP
// is open on loopback, 401 with an API key configured, 503 when exposed unkeyed).
const modes = [
  { name: 'self-host/single-user', deployMode: 'self-host', multiUser: false, host: '127.0.0.1', integrationApiKey: null },
  { name: 'self-host/multi-user', deployMode: 'self-host', multiUser: true, host: '127.0.0.1', integrationApiKey: null },
  { name: 'saas/multi-user', deployMode: 'saas', multiUser: true, host: '127.0.0.1', integrationApiKey: null },
  { name: 'self-host/api-key', deployMode: 'self-host', multiUser: false, host: '127.0.0.1', integrationApiKey: 'route-inventory-probe-key' },
  { name: 'self-host/non-loopback', deployMode: 'self-host', multiUser: false, host: '0.0.0.0', integrationApiKey: null },
];
const registered = new Map();
const completedModes = [];
let modeKeys = new Set();
Error.stackTraceLimit = Infinity;
const initialized = ({ fastify }) => {
  fastify.addHook('onRoute', options => {
    const frames = new Error().stack.split('\n');
    const frame = frames.find(line => line.includes('/web/apps/server/dist/'))
      ?? frames.find(line => line.includes('/node_modules/@fastify/'));
    if (!frame) throw new Error(`Missing route owner: ${options.url}`);
    let owner = frame.match(/(?:file:\/\/)?([^ ()]+\.js):\d+:\d+/)?.[1]
      .replace(root + '/', '');
    if (owner?.startsWith('web/apps/server/dist/')) {
      owner = owner.replace(/dist\/(?:current|releases\/[^/]+)\//, 'src/').replace(/\.js$/, '.ts');
    }
    if (!owner) throw new Error(`Unrecognized route owner: ${frame}`);
    for (const method of Array.isArray(options.method) ? options.method : [options.method]) {
      const key = method + ' ' + options.url;
      modeKeys.add(key);
      // A route first seen in a later mode is absent from every earlier one; record that
      // explicitly so collapse cannot mistake the sparse map for a uniform result.
      if (!registered.has(key)) registered.set(key, {
        method, path: options.url, owner, websocket: options.websocket === true,
        probes: Object.fromEntries(completedModes.map(name => [name, null])),
      });
    }
  });
};
diagnostics.channel('fastify.initialization').subscribe(initialized);
try {
  for (const mode of modes) {
    const dataDir = join(fixture, mode.name.replace('/', '-'));
    await mkdir(dataDir, { recursive: true });
    const config = loadConfig();
    Object.assign(config, { dataDir, authRequired: true, registrationOpen: true, multiUser: mode.multiUser,
      singleUserAuth: !mode.multiUser, trustProxy: false, staticDir: null, databaseUrl: null,
      deployMode: mode.deployMode, host: mode.host, integrationApiKey: mode.integrationApiKey,
      basicAuthUser: null, basicAuthPass: null, saasBasicAuth: null, saasAllowAnonymous: false,
      sessionSecret: 'route-inventory-only', githubOAuthConfigured: true, discordOAuthConfigured: true });
    const ports = createPorts(config);
    let app;
    modeKeys = new Set();
    try {
      await ports.db.connect();
      app = await buildApp(config, ports);
      await app.ready();
      await writeFile(output + '.' + mode.name.replace('/', '-') + '.txt', app.printRoutes({ commonPrefix: false }));
      for (const [key, route] of registered) {
        if (!modeKeys.has(key)) {
          route.probes[mode.name] = null;
          continue;
        }
        // Probe without credentials against the isolated app. Protected routes
        // stop at the real auth hooks; public auth handlers get an empty body.
        const url = (route.path === '*' ? '/*' : route.path).replace(/:[^/]+/g, '1').replace(/\*/g, 'inventory-probe');
        if (route.path !== '*' && !app.hasRoute({ method: route.method, url: route.path })) {
          route.probes[mode.name] = null;
          continue;
        }
        const response = await app.inject({ method: route.method, url,
          ...(route.method === 'POST' ? { payload: {} } : {}) });
        // 503 is a fail-closed refusal (MCP without an API key on a non-loopback host).
        if ((response.statusCode >= 500 && response.statusCode !== 503) || response.statusCode === 429) {
          throw new Error(`Auth probe failed: ${mode.name} ${route.method} ${route.path}: ${response.statusCode}`);
        }
        route.probes[mode.name] = {
          status: response.statusCode,
          authRequired: [401, 403, 503].includes(response.statusCode),
        };
      }
      completedModes.push(mode.name);
    } finally {
      await app?.close();
      await ports.db.close();
    }
  }
  for (const route of registered.values()) {
    const observed = Object.values(route.probes).filter(Boolean);
    const uniform = Object.values(route.probes).every(probe => probe !== null)
      && new Set(observed.map(probe => probe.authRequired)).size === 1;
    if (uniform) {
      route.authRequired = observed[0].authRequired;
    } else {
      route.authRequired = 'mode-dependent';
      route.authByMode = route.probes;
    }
    delete route.probes;
  }
  const routes = [...registered.values()];
  if (!routes.some(route => route.path === '/printers' && route.method === 'GET')) {
    throw new Error('Router output format changed or printer registration is missing');
  }
  routes.sort((a, b) => a.path.localeCompare(b.path, 'en') || a.method.localeCompare(b.method, 'en'));
  await writeFile(output, JSON.stringify({
    evidence: 'Fastify onRoute union probed without credentials per auth mode (' + modes.map(mode => mode.name).join(', ') + '); authRequired=true for 401/403/503, mode-dependent routes carry authByMode with observed status; static build assets excluded',
    routes,
  }, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ routes: routes.length }) + '\n');
} finally {
  diagnostics.channel('fastify.initialization').unsubscribe(initialized);
  await rm(fixture, { recursive: true, force: true });
}
