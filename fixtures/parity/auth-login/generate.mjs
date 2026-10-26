import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const require = createRequire(join(root, "web/package.json"));
const source = "web/apps/server/src/routes/auth.ts";
const output = join(here, "node.json");
const account = {
  email: "fixture@example.test",
  password: "fixture-password-1234",
  display_name: "Fixture",
};
const request = (path, body) => ({ path, body: JSON.stringify(body) });
const cases = [
  { id: "unknown-account", request: request("/auth/login", { email: "unknown@example.test", password: account.password }) },
  { id: "bad-password", seedAccount: true, request: request("/auth/login", { email: account.email, password: "wrong-password" }) },
  { id: "empty-object", request: request("/auth/login", {}) },
  { id: "missing-email", request: request("/auth/login", { password: account.password }) },
  { id: "missing-password", request: request("/auth/login", { email: account.email }) },
  { id: "email-wrong-type", request: request("/auth/login", { email: 42, password: account.password }) },
  { id: "password-wrong-type", request: request("/auth/login", { email: account.email, password: [account.password] }) },
  { id: "array-body", request: request("/auth/login", []) },
  { id: "null-body", request: request("/auth/login", null) },
  { id: "malformed-json", request: { path: "/auth/login", body: '{"email":' } },
  { id: "registration-closed", registrationOpen: false, request: request("/auth/register", account) },
  { id: "administrator-exists", seedAccount: true, request: request("/auth/register", { ...account, email: "second@example.test" }) },
  { id: "registration-invalid-email", request: request("/auth/register", { ...account, email: "invalid" }) },
  { id: "registration-short-password", request: request("/auth/register", { ...account, password: "short" }) },
].map((entry) => ({ registrationOpen: true, seedAccount: false, ...entry }));

if (process.versions.node.split(".")[0] !== "22") {
  throw new Error("Capture auth fixtures with Node 22, matching web/package.json");
}

if (process.argv.includes("--probe")) {
  const { default: Fastify } = await import(pathToFileURL(require.resolve("fastify")).href);
  const { default: cookie } = await import(pathToFileURL(require.resolve("@fastify/cookie")).href);
  const { SqliteDatabase, getDb } = await import(pathToFileURL(join(root, "web/apps/server/src/db/client.ts")).href);
  const { AuthStore } = await import(pathToFileURL(join(root, "web/apps/server/src/services/auth-store.ts")).href);
  const { registerAuthRoutes, registerTenantMiddleware } = await import(pathToFileURL(join(root, source)).href);
  const responses = [];
  for (const entry of cases) {
    const directory = mkdtempSync(join(tmpdir(), "pp-auth-login-node-"));
    const database = new SqliteDatabase(directory);
    const app = Fastify({ logger: false });
    try {
      database.connect();
      const store = new AuthStore(getDb(database), undefined, false);
      const config = {
        deployMode: "self-host",
        multiUser: false,
        singleUserAuth: true,
        authRequired: true,
        registrationOpen: entry.registrationOpen,
        sessionCookieSecure: false,
        githubOAuthConfigured: false,
        discordOAuthConfigured: false,
      };
      await app.register(cookie);
      registerTenantMiddleware(app, config, store);
      registerAuthRoutes(app, config, store);
      const send = (input) => app.inject({
        method: "POST",
        url: input.path,
        // Same-origin, as the Rust replay sends its listener's own origin.
        headers: { host: "127.0.0.1", origin: "http://127.0.0.1", "content-type": "application/json" },
        payload: input.body,
      });
      if (entry.seedAccount) {
        const registered = await send(request("/auth/register", account));
        assert.equal(registered.statusCode, 200, `${entry.id} setup registration`);
        const login = await send(request("/auth/login", account));
        assert.equal(login.statusCode, 200, `${entry.id} positive login control`);
        assert.deepEqual(login.json(), registered.json());
        const cookies = login.cookies;
        assert.equal(cookies.length, 1);
        assert.equal(cookies[0].name, "pp_session");
        assert.ok(cookies[0].value.length > 0);
        assert.equal(cookies[0].httpOnly, true);
        assert.equal(cookies[0].path, "/");
        assert.equal(cookies[0].sameSite, "Lax");
        assert.equal(cookies[0].maxAge, 1209600);
        assert.equal(cookies[0].secure, undefined);
      }
      const response = await send(entry.request);
      const setCookie = response.headers["set-cookie"];
      responses.push({
        ...entry,
        node: {
          status: response.statusCode,
          body: response.json(),
          setCookie: setCookie === undefined ? [] : Array.isArray(setCookie) ? setCookie : [setCookie],
        },
      });
    } finally {
      await app.close();
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
  process.stdout.write(JSON.stringify(responses));
} else {
  const probe = execFileSync(process.execPath, [
    "--conditions=development", "--import", pathToFileURL(require.resolve("tsx/esm")).href,
    fileURLToPath(import.meta.url), "--probe",
  ], {
    cwd: root,
    env: { PATH: process.env.PATH, NODE_ENV: "production" },
    encoding: "utf8",
  });
  const recorded = JSON.parse(probe);
  const text = `${JSON.stringify({
    generated: "@generated by fixtures/parity/auth-login/generate.mjs. Do not edit.",
    source,
    configuration: { deployMode: "self-host", singleUserAuth: true, multiUser: false, sessionCookieSecure: false, sameOriginRequests: true },
    account,
    cases: recorded,
  }, null, 2)}\n`;
  const check = process.argv.includes("--check");
  if (check) {
    assert.equal(readFileSync(output, "utf8"), text, "auth-login/node.json is out of date");
  } else {
    writeFileSync(output, text);
  }
  console.log(JSON.stringify({ cases: recorded.length, check }));
}
