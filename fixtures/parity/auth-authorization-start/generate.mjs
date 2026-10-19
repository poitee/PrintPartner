import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const output = join(here, "node.json");
const source = "web/apps/server/src/routes/auth.ts";
const providers = [
  { provider: "github", path: "/auth/github", callback: "/auth/callback" },
  { provider: "discord", path: "/auth/discord", callback: "/auth/discord/callback" },
];
const inputs = [false, true].flatMap((secure) => providers.flatMap((provider) =>
  [true, false].map((enabled) => ({
    id: `${provider.provider}-${enabled ? "enabled" : "disabled"}-${secure ? "secure" : "http"}`,
    ...provider,
    enabled,
    secure,
    origin: `${secure ? "https" : "http"}://127.0.0.1:${secure ? 48885 : 48884}`,
    client_id: `fixture ${provider.provider}+id/&=é`,
  })),
));
const require = createRequire(new URL("../../../web/apps/server/package.json", import.meta.url));
const demand = (condition, message) => { if (!condition) throw new Error(message); };

async function probe() {
  const Fastify = require("fastify");
  const cookie = require("@fastify/cookie");
  const { SqliteDatabase, getDb } = await import(pathToFileURL(join(root, "web/apps/server/src/db/client.ts")).href);
  const { AuthStore } = await import(pathToFileURL(join(root, "web/apps/server/src/services/auth-store.ts")).href);
  const { loadConfig } = await import(pathToFileURL(join(root, "web/apps/server/src/config.ts")).href);
  const { registerAuthRoutes } = await import(pathToFileURL(join(root, source)).href);
  const seen = new Set();
  const cases = [];
  for (const input of inputs) {
    const directory = mkdtempSync(join(tmpdir(), "pp-auth-start-node-"));
    const database = new SqliteDatabase(directory);
    const app = Fastify({ logger: false });
    try {
      database.connect();
      await app.register(cookie);
      const config = {
        ...loadConfig(), dataDir: directory, multiUser: true, singleUserAuth: false,
        sessionCookieSecure: input.secure,
        githubOAuthConfigured: input.enabled && input.provider === "github",
        discordOAuthConfigured: input.enabled && input.provider === "discord",
        githubClientId: input.client_id, discordClientId: input.client_id,
        githubClientSecret: "fixture-secret", discordClientSecret: "fixture-secret",
        githubCallbackUrl: `${input.origin}/auth/callback`,
        discordCallbackUrl: `${input.origin}/auth/discord/callback`,
      };
      registerAuthRoutes(app, config, new AuthStore(getDb(database)));
      await app.listen({ host: "127.0.0.1", port: 0 });
      let node;
      for (let repeat = 0; repeat < 2; repeat++) {
        const response = await app.inject({ method: "GET", url: input.path });
        const headers = response.headers["set-cookie"];
        const cookies = (headers ? Array.isArray(headers) ? headers : [headers] : []).map((header) => {
          const [pair, ...parts] = header.split(";").map((part) => part.trim());
          const split = pair.indexOf("=");
          const attributes = {};
          for (const part of parts) {
            const [key, ...value] = part.split("=");
            demand(!(key.toLowerCase() in attributes), "duplicate cookie attribute");
            attributes[key.toLowerCase()] = value.length ? value.join("=") : null;
          }
          return { name: pair.slice(0, split), value: pair.slice(split + 1), attributes };
        });
        let redirect = null;
        if (input.enabled) {
          demand(response.statusCode === 302, "configured start must redirect");
          demand(cookies.length === 1 && cookies[0].name === "oauth_state", "missing state cookie binding");
          let url;
          try { url = new URL(response.headers.location); } catch { throw new Error("invalid authorization URL"); }
          demand(!url.hash && !url.username && !url.password, "unexpected redirect URL component");
          const states = url.searchParams.getAll("state");
          demand(states.length === 1 && /^[0-9a-f]{32}$/.test(states[0]), "invalid generated state");
          demand(cookies[0].value === states[0], "Node cookie must equal redirect state");
          demand(!seen.has(states[0]), "authorization state must be fresh");
          seen.add(states[0]);
          demand(!response.body.includes(states[0]), "state echoed in redirect body");
          demand(!url.origin.includes(states[0]) && !url.pathname.includes(states[0]), "state echoed in redirect address");
          for (const [key, value] of url.searchParams) {
            demand(!key.includes(states[0]) && (key === "state" || !value.includes(states[0])), "state echoed outside its normalized field");
          }
          for (const [key, value] of Object.entries(cookies[0].attributes)) {
            demand(!key.includes(states[0]) && !(value ?? "").includes(states[0]), "state echoed in cookie attributes");
          }
          url.searchParams.set("state", "<state>");
          cookies[0].value = "<state>";
          const parameters = {};
          for (const [key, value] of url.searchParams) (parameters[key] ??= []).push(value);
          redirect = { origin: url.origin, path: url.pathname, parameters };
        } else {
          demand(response.statusCode === 501, "disabled start must return 501");
          demand(!response.headers.location && cookies.length === 0, "disabled start must not redirect or bind state");
        }
        const observed = { status: response.statusCode, redirect, cookies, body: input.enabled ? response.body : response.json() };
        if (node) demand(JSON.stringify(node) === JSON.stringify(observed), "normalized starts must be stable");
        node = observed;
      }
      cases.push({ ...input, node });
    } finally {
      await app.close();
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
  process.stdout.write(JSON.stringify({ cases }));
}

if (Number(process.versions.node.split(".")[0]) !== 22) throw new Error("Node 22 is required");
if (process.argv.includes("--probe")) {
  await probe();
} else {
  const probeEnv = { NODE_ENV: "test" };
  for (const key of ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot", "USERPROFILE"]) {
    if (process.env[key] !== undefined) probeEnv[key] = process.env[key];
  }
  const result = execFileSync(process.execPath, [
    "--conditions=development", "--import", pathToFileURL(join(root, "web/node_modules/tsx/dist/esm/index.mjs")).href,
    fileURLToPath(import.meta.url), "--probe",
  ], { cwd: join(root, "web/apps/server"), encoding: "utf8", env: probeEnv });
  const { cases } = JSON.parse(result.trim().split("\n").at(-1));
  const text = `${JSON.stringify({ generated: "@generated by fixtures/parity/auth-authorization-start/generate.mjs. Do not edit.", source, cases }, null, 2)}\n`;
  if (process.argv.includes("--check")) {
    demand(readFileSync(output, "utf8") === text, "auth-authorization-start/node.json is out of date");
  } else {
    writeFileSync(output, text);
  }
  console.log(JSON.stringify({ cases: cases.length, requests: cases.length * 2, check: process.argv.includes("--check") }));
}
