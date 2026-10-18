import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const require = createRequire(join(root, "web/package.json"));
const source = "web/apps/server/src/routes/auth.ts";
const configuration = {
  deployMode: "self-host", singleUserAuth: true, multiUser: false,
  registrationOpen: true, sessionCookieSecure: false, claimDefaultTenantForFirstUser: false,
};
const account = {
  email: "  Fixture@Example.TEST  ", password: "fixture-password-1234", display_name: "  Fixture Owner  ",
};
const get = (path) => ({ method: "GET", path, body: null, cookie: "registered" });
const register = (body) => ({ method: "POST", path: "/auth/register", body, cookie: "none" });
const steps = [
  { id: "before", request: { ...get("/health"), cookie: "none" } },
  { id: "register", request: register(account) },
  { id: "after", request: get("/health") },
  { id: "me", request: get("/auth/me") },
  { id: "different-email", request: register({ ...account, email: "second@example.test" }) },
  { id: "same-email", request: register({ ...account, email: "fixture@example.test" }) },
];
const cookieSuffix = "; Max-Age=1209600; Path=/; HttpOnly; SameSite=Lax";
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const healthFields = ["authenticated", "registration_open", "multi_user", "authentication_required"];

function timestamp(value) {
  assert.equal(typeof value, "string");
  assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const ms = Date.parse(value);
  assert.equal(new Date(ms).toISOString(), value, "canonical timestamp");
  return ms;
}

function normalize(observation, facts, issuing) {
  const result = structuredClone(observation);
  assert.deepEqual(observation.db.auth_identities, []);
  assert.equal(observation.db.users.length, facts ? 1 : 0);
  assert.equal(observation.db.sessions.length, facts ? 1 : 0);
  if (issuing) {
    assert.deepEqual(observation.setCookie, [`pp_session=${facts.token}${cookieSuffix}`]);
    result.setCookie = [`pp_session=<token>${cookieSuffix}`];
  } else {
    assert.deepEqual(observation.setCookie, []);
  }
  if (!facts) return result;
  assert.match(facts.userId, uuidV4);
  assert.match(facts.token, /^[0-9a-f]{64}$/);
  if (observation.body.user) {
    assert.equal(observation.body.user.user_id, facts.userId);
    result.body.user.user_id = "<user:1>";
  }
  const user = observation.db.users[0];
  const session = observation.db.sessions[0];
  assert.equal(user.id, facts.userId);
  assert.equal(session.user_id, facts.userId);
  assert.equal(session.id, createHash("sha256").update(facts.token).digest("hex"));
  const created = timestamp(user.created_at);
  const expires = timestamp(session.expires_at);
  assert.ok(created >= facts.start && created <= facts.end, "creation inside registration request");
  assert.ok(Math.abs(expires - created - 14 * 86400000) <= 2000, "14-day session expiry");
  assert.equal(typeof user.password_hash, "string");
  const hash = user.password_hash.split(":");
  assert.deepEqual(hash.slice(0, 4), ["scrypt", "16384", "8", "1"]);
  assert.equal(hash.length, 6);
  for (const [encoded, size] of [[hash[4], 16], [hash[5], 64]]) {
    const bytes = Buffer.from(encoded, "base64url");
    assert.equal(bytes.length, size);
    assert.equal(bytes.toString("base64url"), encoded, "canonical credential encoding");
  }
  Object.assign(result.db.users[0], { id: "<user:1>", created_at: "<iso-ms>", password_hash: "scrypt" });
  Object.assign(result.db.sessions[0], { id: "sha256(token)", user_id: "<user:1>", expires_at: "<iso-ms>" });
  return result;
}

if (process.versions.node.split(".")[0] !== "22") {
  throw new Error("Capture auth fixtures with Node 22, matching web/package.json");
}

if (process.argv.includes("--probe")) {
  const load = (path) => import(pathToFileURL(join(root, path)).href);
  const { default: Fastify } = await import(pathToFileURL(require.resolve("fastify")).href);
  const { default: cookie } = await import(pathToFileURL(require.resolve("@fastify/cookie")).href);
  const { default: Database } = await import(pathToFileURL(require.resolve("better-sqlite3")).href);
  const { SqliteDatabase, getDb } = await load("web/apps/server/src/db/client.ts");
  const { loadConfig } = await load("web/apps/server/src/config.ts");
  const { AuthStore } = await load("web/apps/server/src/services/auth-store.ts");
  const { registerAuthRoutes, registerTenantMiddleware } = await load(source);
  const { registerHealthRoutes } = await load("web/apps/server/src/routes/health.ts");
  const directory = mkdtempSync(join(tmpdir(), "pp-registration-node-"));
  const database = new SqliteDatabase(directory);
  const app = Fastify({ logger: false });
  let raw;
  try {
    database.connect();
    raw = new Database(join(directory, "print-partner.db"));
    assert.deepEqual(raw.prepare("SELECT 1 AS connected").get(), { connected: 1 });
    const snapshot = () => Object.fromEntries(["users", "sessions", "auth_identities"].map(
      (table) => [table, raw.prepare(`SELECT * FROM ${table} ORDER BY id`).all()],
    ));
    const store = new AuthStore(getDb(database), undefined, configuration.claimDefaultTenantForFirstUser);
    const config = { ...loadConfig(), ...configuration, dataDir: directory, authRequired: true };
    await app.register(cookie);
    registerTenantMiddleware(app, config, store);
    registerAuthRoutes(app, config, store);
    await registerHealthRoutes(app, config, { db: database }, store);
    let facts;
    const recorded = [];
    for (const step of steps) {
      const before = snapshot();
      const start = Date.now();
      const response = await app.inject({
        method: step.request.method,
        url: step.request.path,
        headers: {
          ...(step.request.body ? { "content-type": "application/json" } : {}),
          ...(step.request.cookie === "registered" ? { cookie: `pp_session=${facts.token}` } : {}),
        },
        ...(step.request.body ? { payload: JSON.stringify(step.request.body) } : {}),
      });
      const end = Date.now();
      const headers = response.headers["set-cookie"];
      const setCookie = headers === undefined ? [] : Array.isArray(headers) ? headers : [headers];
      let body = response.json();
      const db = snapshot();
      if (step.id === "register") {
        assert.equal(setCookie.length, 1);
        const match = /^pp_session=([0-9a-f]{64}); Max-Age=1209600; Path=\/; HttpOnly; SameSite=Lax$/.exec(setCookie[0]);
        assert.ok(match, "exact issuance cookie");
        facts = { userId: body.user.user_id, token: match[1], start, end };
      }
      if (step.request.path === "/health") {
        body = Object.fromEntries(healthFields.map((key) => [key, body[key]]));
        assert.deepEqual(body, {
          authenticated: Boolean(facts), registration_open: !facts,
          multi_user: false, authentication_required: true,
        });
      }
      const refused = step.id === "different-email" || step.id === "same-email";
      assert.equal(response.statusCode, refused ? 403 : 200);
      if (refused) {
        assert.deepEqual(body, { detail: "The single-user administrator already exists" });
        assert.deepEqual(db, before, `${step.id} leaves every raw row unchanged`);
      }
      recorded.push({ ...step, node: normalize({ status: response.statusCode, body, setCookie, db }, facts, step.id === "register") });
    }
    process.stdout.write(JSON.stringify(recorded));
  } finally {
    try { await app.close(); } finally {
      try { raw?.close(); } finally {
        try { database.close(); } finally { rmSync(directory, { recursive: true, force: true }); }
      }
    }
  }
} else {
  const probe = execFileSync(process.execPath, [
    "--conditions=development", "--import", pathToFileURL(require.resolve("tsx/esm")).href,
    fileURLToPath(import.meta.url), "--probe",
  ], { cwd: root, env: { PATH: process.env.PATH, NODE_ENV: "production" }, encoding: "utf8" });
  const recorded = JSON.parse(probe);
  const fixture = {
    generated: "@generated by fixtures/parity/auth-registration/generate.mjs. Do not edit.",
    source, configuration, steps: recorded,
  };
  const text = `${JSON.stringify(fixture, null, 2)}\n`;
  const output = join(here, "node.json");
  const check = process.argv.includes("--check");
  if (check) assert.equal(readFileSync(output, "utf8"), text, "auth-registration/node.json is out of date");
  else writeFileSync(output, text);
  console.log(JSON.stringify({ steps: recorded.length, check }));
}
