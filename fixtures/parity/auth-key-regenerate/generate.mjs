import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const check = process.argv.includes("--check");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith(".js") && context.parentURL?.startsWith(pathToFileURL(root).href)) {
      const url = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
      if (existsSync(url)) return { url: url.href, shortCircuit: true };
    }
    return next(specifier, { ...context, conditions: [...context.conditions, "development"] });
  },
  load(url, context, next) {
    if (url.startsWith(pathToFileURL(root).href) && url.endsWith(".ts")) {
      return { format: "module", source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { mode: "transform", sourceUrl: url }), shortCircuit: true };
    }
    return next(url, context);
  },
});
const load = (path) => import(pathToFileURL(join(root, path)).href);
const { default: Fastify } = await load("web/node_modules/fastify/fastify.js");
const { default: cookie } = await load("web/node_modules/@fastify/cookie/index.js");
const { default: Database } = await load("web/node_modules/better-sqlite3/lib/index.js");
const { SqliteDatabase, getDb } = await load("web/apps/server/src/db/client.ts");
const { AppRepository } = await load("web/apps/server/src/db/repository.ts");
const schema = await load("web/apps/server/src/db/schema.ts");
const { createAuthStore } = await load("web/apps/server/src/services/auth-store.ts");
const { registerAuthRoutes, registerTenantMiddleware } = await load("web/apps/server/src/routes/auth.ts");
const { setRequestTenantId } = await load("web/apps/server/src/middleware/tenant-context.ts");
const { registerApiKeyAuth, createAdminPreHandler } = await load("web/apps/server/src/middleware/api-key.ts");
const { validateApiKey } = await load("web/apps/server/src/services/api-key-manager.ts");
const { registerApiKeyManagementRoutes } = await load("web/apps/server/src/routes/api-key-management.ts");
const { registerPlanRoutes } = await load("web/apps/server/src/routes/plans.ts");

function assertSafe(value) {
  assert.ok(!/ppk_[a-f0-9]{64}|key_[a-f0-9]{16}|[a-f0-9]{64}/.test(JSON.stringify(value)), "unnormalized generated identity");
}

function identities() {
  const values = new Map();
  const labels = new Set();
  function bind(value, label) {
    assert.ok(typeof value === "string" && value.length > 0, `missing ${label}`);
    assert.ok(!values.has(value) && !labels.has(label), `identity collision for ${label}`);
    values.set(value, `<${label}>`);
    labels.add(label);
  }
  function known(value) {
    assert.ok(values.has(value), "unmapped generated identity");
    return values.get(value);
  }
  function timestamp(value) {
    if (value === null) return null;
    assert.ok(typeof value === "string" && Number.isFinite(Date.parse(value)), "invalid timestamp");
    return "<timestamp>";
  }
  function key(body, label) {
    assert.ok(/^key_[a-f0-9]{16}$/.test(body.id), "invalid key id");
    assert.ok(/^ppk_[a-f0-9]{64}$/.test(body.key), "invalid key secret");
    bind(body.id, `${label}-id`);
    bind(body.key, `${label}-secret`);
    bind(createHmac("sha256", "print-partner:settings-api-key:v1").update(body.key).digest("hex"), `${label}-digest`);
  }
  function keyRow(row) {
    const result = { ...row, id: known(row.id), createdAt: timestamp(row.createdAt), lastUsedAt: timestamp(row.lastUsedAt), expiresAt: timestamp(row.expiresAt) };
    if ("key" in result) result.key = known(result.key);
    if ("keyHash" in result) result.keyHash = known(result.keyHash);
    assertSafe(result);
    return result;
  }
  return { bind, known, key, keyRow };
}

async function run(id) {
  const directory = mkdtempSync(join(tmpdir(), "pp-key-regenerate-"));
  const database = new SqliteDatabase(directory);
  const app = Fastify({ logger: false });
  let raw;
  try {
    database.connect();
    raw = new Database(join(directory, "print-partner.db"));
    const repo = new AppRepository(getDb(database), "default", database.reposDir, schema);
    const auth = createAuthStore(getDb(database), "sqlite");
    const config = {
      deployMode: "self-host", multiUser: true, singleUserAuth: false,
      authRequired: true, trustProxy: false, registrationOpen: true,
      sessionCookieSecure: false, basicAuthUser: null, basicAuthPass: null,
      saasBasicAuth: null, saasAllowAnonymous: false, integrationApiKey: null,
    };
    await app.register(cookie);
    registerTenantMiddleware(app, config, auth);
    app.addHook("onRequest", async (request) => setRequestTenantId(request.tenantId));
    registerAuthRoutes(app, config, auth);
    let resolvedKeyId = null;
    const validate = registerApiKeyAuth(app, config, (key) => {
      resolvedKeyId = validateApiKey(repo, key);
      return resolvedKeyId !== null;
    });
    const admin = createAdminPreHandler(config, validate);
    app.addHook("preHandler", async (request, reply) => {
      if (request.url.startsWith("/settings/api-keys")) return admin(request, reply);
    });
    await registerApiKeyManagementRoutes(app, { repo });
    await app.register(async (versioned) => registerPlanRoutes(versioned, {
      repo, dataDir: directory, reposDir: database.reposDir, thumbsDir: join(directory, "thumbs"),
    }), { prefix: "/api/v1" });
    const names = identities();
    const sessions = {};
    const transcript = [];
    async function request(method, url, actor, key) {
      return app.inject({ method, url, remoteAddress: "203.0.113.10",
        ...(actor ? { cookies: { pp_session: sessions[actor] } } : {}),
        ...(key ? { headers: { authorization: `Bearer ${key}` } } : {}),
        ...(method === "POST" ? { payload: {} } : {}),
      });
    }
    for (const actor of ["owner", "foreign"]) {
      const response = await app.inject({ method: "POST", url: "/auth/register", payload: {
        email: `${actor}@example.test`, password: "temporary-password-1234", display_name: actor,
      } });
      assert.equal(response.statusCode, 200, "registration setup failed");
      const user = response.json().user.user_id;
      names.bind(user, `${actor}-user`);
      sessions[actor] = response.cookies.find((item) => item.name === "pp_session")?.value;
      assert.ok(sessions[actor], "registration omitted session");
      names.bind(createHash("sha256").update(sessions[actor]).digest("hex"), `${actor}-session-digest`);
      if (actor === "foreign") raw.prepare("UPDATE users SET is_admin=1 WHERE id=?").run(user);
    }
    const keys = {};
    for (const actor of ["owner", "foreign"]) {
      const response = await request("POST", "/settings/api-keys", actor);
      assert.equal(response.statusCode, 201, "key setup failed");
      keys[actor] = response.json();
      names.key(keys[actor], actor === "owner" ? "old-key" : "foreign-key");
    }
    function snapshot() {
      return {
        users: raw.prepare("SELECT id,email,is_admin FROM users ORDER BY email").all().map((row) => ({ ...row, id: names.known(row.id) })),
        sessions: raw.prepare("SELECT id,user_id,provider FROM sessions ORDER BY user_id").all().map((row) => ({ ...row, id: names.known(row.id), user_id: names.known(row.user_id) })).sort((a, b) => a.id.localeCompare(b.id)),
        settings: raw.prepare("SELECT tenant_id,key,value FROM app_settings WHERE key='api_keys_v1'").all().map((row) => ({ tenant_id: names.known(row.tenant_id), key: row.key, value: JSON.parse(row.value).map(names.keyRow) })).sort((a, b) => a.tenant_id.localeCompare(b.tenant_id)),
      };
    }
    async function authenticate(label, actor, key) {
      resolvedKeyId = null;
      const response = await request("GET", "/api/v1/plans", actor, key);
      const principal = resolvedKeyId === null ? null : { tenant_id: `<${actor}-user>`, key_id: names.known(resolvedKeyId) };
      const entry = { id: label, transport: "node-http", method: "GET", path: "/api/v1/plans", actor, credential: names.known(key), status: response.statusCode, body: response.json(), rustClient: { request: "ResolveKey", principal } };
      assertSafe(entry);
      const expected = label === "old-after" ? 401 : 200;
      assert.equal(entry.status, expected, `${label} HTTP authentication`);
      if (expected === 401) assert.deepEqual(entry.body, { detail: "Valid API key required", title: "Unauthorized", status: 401 });
      transcript.push(entry);
    }
    if (id === "owner-session-rotation") await authenticate("old-before", "owner", keys.owner.key);
    const before = snapshot();
    const storedSettings = () => raw.prepare("SELECT tenant_id,value FROM app_settings WHERE key='api_keys_v1' ORDER BY tenant_id").all();
    const storedBefore = storedSettings();
    const target = id === "foreign-tenant" ? keys.foreign.id : id === "missing-key" ? "key_missing" : keys.owner.id;
    const path = `/settings/api-keys/${target}/regenerate`;
    const response = await request("POST", path, "owner");
    const body = response.json();
    if (id === "owner-session-rotation") names.key(body, "new-key");
    else assertSafe(body);
    assert.equal(response.statusCode, id === "owner-session-rotation" ? 201 : 404, `${id} rotation status`);
    transcript.push({ id: "rotate", transport: "shared-http", method: "POST", path: path.replace(target, target === "key_missing" ? target : names.known(target)), actor: "owner", status: response.statusCode, body: response.statusCode === 201 ? names.keyRow(body) : body });
    const afterRotation = snapshot();
    const storedAfter = storedSettings();
    const foreignValue = (rows) => rows.find((row) => names.known(row.tenant_id) === "<foreign-user>").value;
    const rotationEffects = {
      foreignSettingUnchanged: foreignValue(storedBefore) === foreignValue(storedAfter),
      allSettingsUnchanged: JSON.stringify(storedBefore) === JSON.stringify(storedAfter),
    };
    assert.ok(rotationEffects.foreignSettingUnchanged, "rotation changed raw foreign setting");
    assert.equal(rotationEffects.allSettingsUnchanged, id !== "owner-session-rotation", "unexpected raw setting change");
    if (id === "owner-session-rotation") {
      const ownerRows = afterRotation.settings.find((row) => row.tenant_id === "<owner-user>").value;
      assert.deepEqual(ownerRows.map((row) => [row.id, row.isActive]), [["<old-key-id>", false], ["<new-key-id>", true]]);
      await authenticate("old-after", "owner", keys.owner.key);
      await authenticate("new-after", "owner", body.key);
    } else {
      assert.deepEqual(body, { detail: "API key not found", title: "Not Found", status: 404 });
      assert.deepEqual(afterRotation, before, `${id} changed persisted rows`);
      await authenticate("owner-still-usable", "owner", keys.owner.key);
      await authenticate("foreign-still-usable", "foreign", keys.foreign.key);
    }
    const after = snapshot();
    assert.deepEqual(afterRotation.settings.find((row) => row.tenant_id === "<foreign-user>"), before.settings.find((row) => row.tenant_id === "<foreign-user>"), "rotation changed foreign rows");
    return { id, before, transcript, afterRotation, after, rotationEffects };
  } finally {
    await app.close();
    raw?.close();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

const cases = [];
for (const id of ["owner-session-rotation", "foreign-tenant", "missing-key"]) cases.push(await run(id));
const output = {
  _generated: "@generated by fixtures/parity/auth-key-regenerate/generate.mjs",
  authentication: { node: "real tenant and API-key middleware plus public /api/v1/plans HTTP", rust: "real RebuildAuthClient ResolveKey; no Rust bearer HTTP parity" },
  cases,
};
const text = "{\n" + Object.entries(output).map(([key, value]) => `  ${JSON.stringify(key)}: ${key === "cases" ? "[\n" + value.map((row) => "    " + JSON.stringify(row)).join(",\n") + "\n  ]" : JSON.stringify(value)}`).join(",\n") + "\n}\n";
assert.ok(!/ppk_[a-f0-9]{64}|key_[a-f0-9]{16}|[a-f0-9]{64}/.test(text), "fixture contains an unnormalized generated identity");
const path = join(here, "node.json");
if (check) assert.equal(readFileSync(path, "utf8"), text, "Node regeneration fixtures are stale");
else { mkdirSync(here, { recursive: true }); writeFileSync(path, text); }
console.log(JSON.stringify({ cases: cases.length, check }));
