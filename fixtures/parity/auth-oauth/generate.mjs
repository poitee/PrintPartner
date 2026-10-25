// Records Node's OAuth callback contract for the Rust auth_router parity test.
// Run from the repo root with Node 22 after `npm --prefix web ci`:
//   node fixtures/parity/auth-oauth/generate.mjs
//   node fixtures/parity/auth-oauth/generate.mjs --check
// Provider HTTP stays on a loopback fake. The golden stores statuses, redirects,
// cookie attributes, and session counts. It does not store client secrets,
// access tokens, authorization codes, or raw state and session values.
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const output = join(here, "node.json");
const source = "web/apps/server/src/routes/auth.ts";
const secret = "fixture-secret";
const callbackOrigin = "http://127.0.0.1:48884";
const providers = [
  { provider: "github", callback: "/auth/callback", clientId: "fixture-github-client" },
  { provider: "discord", callback: "/auth/discord/callback", clientId: "fixture-discord-client" },
];
const recipes = [
  { suffix: "missing-state", steps: ["missing-state"] },
  { suffix: "changed-state", steps: ["changed-state"] },
  { suffix: "denied", steps: ["denied", "replay"] },
  { suffix: "consumed-replay", steps: ["allow", "replay"] },
];
const require = createRequire(new URL("../../../web/apps/server/package.json", import.meta.url));
const demand = (condition, message) => {
  if (!condition) throw new Error(message);
};

function cookieList(headers) {
  const raw = headers["set-cookie"];
  const list = raw ? (Array.isArray(raw) ? raw : [raw]) : [];
  return list.map((header) => {
    const [pair, ...parts] = header.split(";").map((part) => part.trim());
    const split = pair.indexOf("=");
    demand(split > 0, "malformed set-cookie");
    const attributes = {};
    for (const part of parts) {
      const [key, ...value] = part.split("=");
      const name = key.toLowerCase();
      demand(!(name in attributes), "duplicate cookie attribute");
      attributes[name] = value.length ? value.join("=") : null;
    }
    return { name: pair.slice(0, split), value: pair.slice(split + 1), attributes };
  });
}

function publicBody(response) {
  if (!response.body) return null;
  try {
    return JSON.parse(response.body);
  } catch {
    return response.body;
  }
}

function counts(databasePath) {
  const Database = require("better-sqlite3");
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return {
      sessions: db.prepare("select count(*) as n from sessions").get().n,
      users: db.prepare("select count(*) as n from users").get().n,
    };
  } finally {
    db.close();
  }
}

function parsedBody(call) {
  if (!call.raw) return {};
  if ((call.contentType ?? "").includes("application/json")) return JSON.parse(call.raw);
  return Object.fromEntries(new URLSearchParams(call.raw));
}

function assertToken(call, provider, clientId, code) {
  const body = parsedBody(call);
  const keys = Object.keys(body).sort();
  const expected = provider === "github"
    ? ["client_id", "client_secret", "code", "redirect_uri"]
    : ["client_id", "client_secret", "code", "grant_type", "redirect_uri"];
  demand(keys.join() === expected.sort().join(), "token request fields changed");
  demand(body.client_id === clientId, "token client id changed");
  demand(body.client_secret === secret, "token request dropped the configured client secret");
  demand(body.code === code, "token code does not match the callback");
  demand(body.redirect_uri === `${callbackOrigin}${provider === "github" ? "/auth/callback" : "/auth/discord/callback"}`, "token redirect_uri changed");
  demand(!("code_verifier" in body), "node sent a pkce verifier");
  if (provider === "discord") demand(body.grant_type === "authorization_code", "discord grant_type changed");
  const type = call.contentType ?? "";
  demand(provider === "github" ? type.includes("application/json") : type.includes("application/x-www-form-urlencoded"), "token content type changed");
}

function assertProfile(call, code) {
  demand(call.method === "GET", "profile request method changed");
  demand(call.authorization === `Bearer token:${code}`, "profile authorization changed");
}

function assertCalls(calls, provider, steps) {
  const sequence = [];
  let previous = null;
  for (const step of steps) {
    const code = step === "replay"
      ? (previous === "denied" ? "deny" : "allow")
      : step === "denied" ? "deny" : step === "allow" ? "allow" : null;
    previous = step === "replay" ? previous : step;
    if (!code) continue;
    sequence.push(["token", code]);
    if (code === "allow") {
      sequence.push(["profile", code]);
      // A second GitHub login for an identity that already exists skips email enrichment.
      if (provider === "github" && !(step === "replay" && previous === "allow")) {
        sequence.push(["emails", code]);
      }
    }
  }
  demand(
    calls.length === sequence.length,
    `provider call count changed: saw ${calls.map((call) => `${call.method} ${call.path}`).join(", ")}`,
  );
  calls.forEach((call, index) => {
    const [phase, code] = sequence[index];
    if (phase === "token") {
      demand(call.method === "POST", "token method changed");
      const path = provider === "github" ? "/login/oauth/access_token" : "/api/oauth2/token";
      demand(call.path === path, "token path changed");
      assertToken(call, provider, providers.find((item) => item.provider === provider).clientId, code);
    } else if (phase === "profile") {
      const path = provider === "github" ? "/user" : "/api/users/@me";
      demand(call.path === path, "profile path changed");
      assertProfile(call, code);
    } else {
      demand(call.path === "/user/emails", "email path changed");
      assertProfile(call, code);
    }
  });
}

function listen(calls) {
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url, "http://127.0.0.1");
      const raw = Buffer.concat(chunks).toString("utf8");
      const call = {
        method: request.method,
        path: url.pathname,
        contentType: request.headers["content-type"] ?? "",
        authorization: request.headers.authorization ?? "",
        raw,
      };
      calls.push(call);
      const code = call.path.endsWith("access_token") || call.path.endsWith("/token")
        ? parsedBody(call).code
        : (call.authorization.startsWith("Bearer token:") ? call.authorization.slice("Bearer token:".length) : "");
      if (call.path.endsWith("access_token") || call.path.endsWith("/token")) {
        if (code === "deny") {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "access_denied" }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ access_token: `token:${code}` }));
        return;
      }
      if (call.path.endsWith("/emails")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify([{ email: "primary@example.com", verified: true, primary: true }]));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(call.path === "/user"
        ? JSON.stringify({ id: 123, login: "octocat", name: "Octo Cat" })
        : JSON.stringify({
          id: "123",
          username: "discord-user",
          global_name: "Discord User",
          email: "primary@example.com",
          verified: true,
        }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function probe() {
  const Fastify = require("fastify");
  const cookie = require("@fastify/cookie");
  const { SqliteDatabase, getDb } = await import(pathToFileURL(join(root, "web/apps/server/src/db/client.ts")).href);
  const { AuthStore } = await import(pathToFileURL(join(root, "web/apps/server/src/services/auth-store.ts")).href);
  const { loadConfig } = await import(pathToFileURL(join(root, "web/apps/server/src/config.ts")).href);
  const { registerAuthRoutes } = await import(pathToFileURL(join(root, source)).href);
  const calls = [];
  const fake = await listen(calls);
  const fakeOrigin = `http://127.0.0.1:${fake.address().port}`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const target = new URL(raw);
    demand(["github.com", "api.github.com", "discord.com"].includes(target.hostname), "unexpected provider host");
    return originalFetch(new URL(target.pathname + target.search, fakeOrigin), init);
  };
  const cases = [];
  try {
    for (const provider of providers) {
      for (const recipe of recipes) {
        const directory = mkdtempSync(join(tmpdir(), "pp-auth-oauth-node-"));
        const database = new SqliteDatabase(directory);
        const app = Fastify({ logger: false });
        calls.length = 0;
        try {
          database.connect();
          await app.register(cookie);
          const config = {
            ...loadConfig(),
            dataDir: directory,
            multiUser: true,
            singleUserAuth: false,
            registrationOpen: true,
            sessionCookieSecure: false,
            authSuccessRedirect: "/",
            githubOAuthConfigured: true,
            discordOAuthConfigured: true,
            githubClientId: providers[0].clientId,
            discordClientId: providers[1].clientId,
            githubClientSecret: secret,
            discordClientSecret: secret,
            githubCallbackUrl: `${callbackOrigin}/auth/callback`,
            discordCallbackUrl: `${callbackOrigin}/auth/discord/callback`,
          };
          registerAuthRoutes(app, config, new AuthStore(getDb(database)));
          const issuedSessions = [];
          const start = async () => {
            const response = await app.inject({ method: "GET", url: provider.provider === "github" ? "/auth/github" : "/auth/discord" });
            demand(response.statusCode === 302, "authorization start did not redirect");
            const location = new URL(response.headers.location);
            demand(location.hostname === (provider.provider === "github" ? "github.com" : "discord.com"), "start left the public provider");
            const state = location.searchParams.get("state");
            demand(/^[0-9a-f]{32}$/.test(state ?? ""), "node state must be 16 lowercase hex bytes");
            demand(!location.searchParams.has("code_challenge"), "node start must not send pkce");
            const cookies = cookieList(response.headers);
            demand(cookies.length === 1 && cookies[0].name === "oauth_state" && cookies[0].value === state, "node state cookie must equal the redirect state");
            return state;
          };
          const send = async (url, stateCookie) => {
            const response = await app.inject({
              method: "GET",
              url,
              cookies: stateCookie === undefined ? undefined : { oauth_state: stateCookie },
              headers: { "sec-fetch-site": "cross-site" },
            });
            const location = response.headers.location ?? null;
            demand(!Array.isArray(location), "duplicate location");
            const body = publicBody(response);
            const rawCookies = cookieList(response.headers);
            const persisted = counts(database.dbPath);
            const rendered = JSON.stringify({ location, body, cookies: rawCookies });
            for (const secretValue of [secret, ...issuedSessions]) {
              demand(!rendered.includes(secretValue), "response retained a generated secret");
            }
            const cookies = rawCookies.map((item) => {
              if (item.name === "pp_session") {
                demand(item.value.length > 16 && !issuedSessions.includes(item.value), "session cookie missing or reused");
                issuedSessions.push(item.value);
                return { ...item, value: `<session:${issuedSessions.length}>` };
              }
              if (item.name === "oauth_state") return { ...item, value: item.value === "" ? "" : "<state>" };
              throw new Error("unexpected callback cookie");
            });
            return { status: response.statusCode, location, cookies, body, sessions: persisted.sessions, users: persisted.users };
          };
          const steps = [];
          let previous = null;
          for (const kind of recipe.steps) {
            let url;
            let stateCookie;
            if (kind === "missing-state") {
              stateCookie = await start();
              url = `${provider.callback}?code=allow`;
            } else if (kind === "changed-state") {
              stateCookie = await start();
              url = `${provider.callback}?code=allow&state=changed-state`;
            } else if (kind === "denied" || kind === "allow") {
              stateCookie = await start();
              url = `${provider.callback}?code=${kind === "denied" ? "deny" : "allow"}&state=${stateCookie}`;
            } else {
              demand(previous, "replay has no callback");
              url = previous.url;
              stateCookie = previous.stateCookie;
            }
            const node = await send(url, stateCookie);
            const successful = kind === "allow" || (kind === "replay" && previous?.kind === "allow");
            demand(node.users === (successful ? 1 : 0), "callback user count changed");
            demand(node.sessions === (kind === "allow" ? 1 : successful ? 2 : 0), "callback session count changed");
            demand(successful ? node.status === 302 && node.location === "/" : node.status === (kind === "denied" || (kind === "replay" && previous?.kind === "denied") ? 401 : 400), "callback status changed");
            const { users, ...publicNode } = node;
            steps.push({ name: kind, kind, node: publicNode });
            previous = { kind: kind === "replay" ? previous.kind : kind, url, stateCookie };
          }
          assertCalls(calls, provider.provider, recipe.steps);
          cases.push({
            id: `${provider.provider}-${recipe.suffix}`,
            provider: provider.provider,
            callback: provider.callback,
            client_id: provider.clientId,
            steps,
          });
        } finally {
          await app.close();
          database.close();
          rmSync(directory, { recursive: true, force: true });
        }
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise((resolve, reject) => fake.close((error) => error ? reject(error) : resolve()));
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
    "--conditions=development",
    "--import",
    pathToFileURL(join(root, "web/node_modules/tsx/dist/esm/index.mjs")).href,
    fileURLToPath(import.meta.url),
    "--probe",
  ], { cwd: join(root, "web/apps/server"), encoding: "utf8", env: probeEnv, maxBuffer: 8 * 1024 * 1024 });
  const { cases } = JSON.parse(result.trim().split("\n").at(-1));
  const text = `${JSON.stringify({
    generated: "@generated by fixtures/parity/auth-oauth/generate.mjs. Do not edit.",
    source,
    cases,
  }, null, 2)}\n`;
  if (process.argv.includes("--check")) {
    demand(readFileSync(output, "utf8") === text, "auth-oauth/node.json is out of date");
  } else {
    writeFileSync(output, text);
  }
  console.log(JSON.stringify({ cases: cases.length, check: process.argv.includes("--check") }));
}
