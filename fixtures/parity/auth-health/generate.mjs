import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const require = createRequire(join(root, "web/package.json"));
const { register } = require("tsx/esm/api");
register();
const Fastify = require("fastify");
const cookie = require("@fastify/cookie");
const source = (path) => import(pathToFileURL(join(root, "web/apps/server/src", path)).href);
for (const key of Object.keys(process.env)) {
  if (/^(PP_|SAAS_|GITHUB_|DISCORD_|GOOGLE_|SMTP_|MULTI_USER$|SINGLE_USER_AUTH$|DEPLOY_MODE$)/.test(key)) delete process.env[key];
}
process.env.NODE_ENV = "production";
const { SqliteDatabase, getDb } = await source("db/client.ts");
const { AuthStore } = await source("services/auth-store.ts");
const { loadConfig } = await source("config.ts");
const { registerTenantMiddleware, registerAuthRoutes } = await source("routes/auth.ts");
const { registerHealthRoutes } = await source("routes/health.ts");
const cases = [];
for (const name of ["anonymous", "valid", "expired", "policy-rejected", "closed-owner", "anonymous-closed-owner"]) {
  const directory = mkdtempSync(join(tmpdir(), "pp-auth-health-"));
  const database = new SqliteDatabase(directory);
  const app = Fastify();
  try {
    database.connect();
    const db = getDb(database);
    const auth = new AuthStore(db);
    const user = auth.createUser({ email: "health@example.test", displayName: "Health" });
    const token = auth.createSession(user.id, "email");
    if (name === "expired") db.run("UPDATE sessions SET expires_at='2000-01-01T00:00:00.000Z'");
    const single = name === "policy-rejected";
    if (single) auth.createUser({ email: "second@example.test", displayName: "Second" });
    const config = {
      ...loadConfig(), dataDir: "<temporary>", port: 18765,
      multiUser: !single, singleUserAuth: single, authRequired: true,
      registrationOpen: true, saasBasicAuth: null, saasAllowAnonymous: false,
      githubOAuthConfigured: false, discordOAuthConfigured: false,
      smtpConfigured: false, googleClientId: null,
    };
    await app.register(cookie);
    registerTenantMiddleware(app, config, auth);
    registerAuthRoutes(app, config, auth);
    await registerHealthRoutes(app, config, { db: database }, auth);
    await app.ready();
    if (name.endsWith("closed-owner")) database.close();
    const response = await app.inject({ method: "GET", url: "/health", headers: name.startsWith("anonymous") ? {} : { cookie: `pp_session=${token}` } });
    const body = response.json();
    if (body.build) body.build.nodeVersion = "<node-version>";
    if (name === "closed-owner") {
      assert.equal(response.statusCode, 500, "closed Node database must remain fatal");
      assert.equal(body.statusCode, 500);
    } else {
      assert.equal(response.statusCode, 200, name);
      assert.equal(body.authenticated, name === "valid" || single, name);
      assert.equal(body.ok, true, name);
    }
    cases.push({ name, node: { status: response.statusCode, body } });
  } finally {
    await app.close();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
const fixture = {
  generated: "node --conditions=development fixtures/parity/auth-health/generate.mjs",
  sources: ["web/apps/server/src/routes/auth.ts", "web/apps/server/src/routes/health.ts"],
  cases,
};
const path = join(here, "node.json");
if (process.argv.includes("--check")) assert.deepEqual(fixture, JSON.parse(readFileSync(path, "utf8")));
else writeFileSync(path, JSON.stringify(fixture, null, 2) + "\n");
console.log(`auth health: ${cases.length} registered-handler cases passed`);
