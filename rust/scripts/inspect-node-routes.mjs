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
// Observe the union of the single-user, multi-user and hosted API surfaces.
const registered = new Map();
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
      if (!registered.has(key)) registered.set(key, {
        method, path: options.url, authRequired: null, owner, websocket: options.websocket === true,
      });
    }
  });
};
diagnostics.channel('fastify.initialization').subscribe(initialized);
try {
  for (const [mode, multiUser] of [['self-host', false], ['self-host', true], ['saas', true]]) {
    const dataDir = join(fixture, `${mode}-${multiUser}`);
    await mkdir(dataDir, { recursive: true });
    const config = loadConfig();
    Object.assign(config, { dataDir, authRequired: true, registrationOpen: true, multiUser,
      singleUserAuth: !multiUser, trustProxy: false, staticDir: null, databaseUrl: null, deployMode: mode,
      basicAuthUser: null, basicAuthPass: null, saasBasicAuth: null, saasAllowAnonymous: false,
      integrationApiKey: null, sessionSecret: 'route-inventory-only',
      githubOAuthConfigured: true, discordOAuthConfigured: true });
    const ports = createPorts(config);
    let app;
    try {
      await ports.db.connect();
      app = await buildApp(config, ports);
      await app.ready();
      await writeFile(output + '.' + mode + '-' + multiUser + '.txt', app.printRoutes({ commonPrefix: false }));
      for (const route of registered.values()) {
        if (route.authRequired !== null) continue;
        // Probe without credentials against the isolated app. Protected routes
        // stop at the real auth hooks; public auth handlers get an empty body.
        const url = (route.path === '*' ? '/*' : route.path).replace(/:[^/]+/g, '1').replace(/\*/g, 'inventory-probe');
        if (route.path !== '*' && !app.hasRoute({ method: route.method, url: route.path })) continue;
        const response = await app.inject({ method: route.method, url,
          ...(route.method === 'POST' ? { payload: {} } : {}) });
        if (response.statusCode >= 500 || response.statusCode === 429) {
          throw new Error(`Auth probe failed: ${route.method} ${route.path}: ${response.statusCode}`);
        }
        route.authRequired = response.statusCode === 401 || response.statusCode === 403;
      }
    } finally {
      await app?.close();
      await ports.db.close();
    }
  }
  const routes = [...registered.values()];
  if (!routes.some(route => route.path === '/printers' && route.method === 'GET')) {
    throw new Error('Router output format changed or printer registration is missing');
  }
  if (routes.some(route => route.authRequired === null)) throw new Error('Unprobed routes: ' + JSON.stringify(routes.filter(route => route.authRequired === null)));
  routes.sort((a, b) => a.path.localeCompare(b.path, 'en') || a.method.localeCompare(b.method, 'en'));
  await writeFile(output, JSON.stringify({
    evidence: 'Fastify onRoute union: self-host single-user, self-host multi-user, SaaS; authRequired observed without credentials with authRequired=true; static build assets excluded',
    routes,
  }, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ routes: routes.length }) + '\n');
} finally {
  diagnostics.channel('fastify.initialization').unsubscribe(initialized);
  await rm(fixture, { recursive: true, force: true });
}
