import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const output = join(here, "node.json");
const token = "gre863-disposable-session-credential";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const transitions = [
  { name: "valid_me", method: "GET", path: "/auth/me", credential: "original", storage: "current" },
  { name: "absent_me", method: "GET", path: "/auth/me", credential: "absent", storage: "current" },
  { name: "absent_logout", method: "POST", path: "/auth/logout", credential: "absent", storage: "current" },
  { name: "logout", method: "POST", path: "/auth/logout", credential: "original", storage: "current" },
  { name: "repeated_logout", method: "POST", path: "/auth/logout", credential: "original", storage: "current" },
  { name: "revoked_me", method: "GET", path: "/auth/me", credential: "original", storage: "current" },
  { name: "reopened_revoked_me", method: "GET", path: "/auth/me", credential: "original", storage: "reopen" },
];

function clearingCookies(headers) {
  return headers.map((header) => {
    const [pair, ...attributes] = header.split(";").map((part) => part.trim());
    const equals = pair.indexOf("=");
    const attrs = new Map(attributes.map((attribute) => {
      const [name, ...value] = attribute.split("=");
      return [name.toLowerCase(), value.join("=")];
    }));
    const maxAge = attrs.get("max-age");
    const expires = attrs.get("expires");
    return {
      name: pair.slice(0, equals),
      value: pair.slice(equals + 1),
      path: attrs.get("path") ?? null,
      domain: attrs.get("domain") ?? null,
      same_site: attrs.get("samesite")?.toLowerCase() ?? null,
      secure: attrs.has("secure"),
      expires_immediately: maxAge !== undefined
        ? Number(maxAge) <= 0
        : expires !== undefined && Date.parse(expires) <= 0,
    };
  });
}

if (process.argv.includes("--probe")) {
  const load = (source) => import(pathToFileURL(join(root, source)).href);
  const require = createRequire(join(root, "web/package.json"));
  const Fastify = require("fastify");
  const cookie = require("@fastify/cookie");
  const Database = require("better-sqlite3");
  const { SqliteDatabase, getDb } = await load("web/apps/server/src/db/client.ts");
  const { AuthStore } = await load("web/apps/server/src/services/auth-store.ts");
  const { loadConfig } = await load("web/apps/server/src/config.ts");
  const { registerAuthRoutes, registerTenantMiddleware } = await load("web/apps/server/src/routes/auth.ts");
  const directory = mkdtempSync(join(tmpdir(), "pp-auth-session-node-"));
  const sqlite = new SqliteDatabase(directory);
  let app;
  let inspection;
  try {
    sqlite.connect();
    const auth = new AuthStore(getDb(sqlite));
    const user = auth.createUser({ email: "session@example.test", displayName: "Session Fixture" });
    const generatedToken = auth.createSession(user.id, "email");
    inspection = new Database(sqlite.dbPath);
    inspection.prepare("UPDATE users SET created_at=? WHERE id=?")
      .run("2026-01-01T00:00:00.000Z", user.id);
    inspection.prepare("UPDATE sessions SET id=?, expires_at=? WHERE id=?")
      .run(digest(token), "2999-01-01T00:00:00.000Z", digest(generatedToken));
    const seed = {
      user: inspection.prepare("SELECT * FROM users WHERE id=?").get(user.id),
      session: { token, ...inspection.prepare("SELECT * FROM sessions WHERE id=?").get(digest(token)) },
    };
    const config = {
      ...loadConfig(), deployMode: "self-host", multiUser: true, singleUserAuth: false,
      authRequired: true, saasAllowAnonymous: false, saasBasicAuth: null,
      sessionCookieSecure: false,
    };
    const openApp = async (store) => {
      const server = Fastify({ logger: false });
      await server.register(cookie);
      registerTenantMiddleware(server, config, store);
      registerAuthRoutes(server, config, store);
      await server.ready();
      return server;
    };
    app = await openApp(auth);
    const cases = [];
    for (const transition of transitions) {
      if (transition.storage === "reopen") {
        await app.close();
        inspection.close();
        sqlite.close();
        sqlite.connect();
        inspection = new Database(sqlite.dbPath);
        app = await openApp(new AuthStore(getDb(sqlite)));
      }
      const response = await app.inject({
        method: transition.method,
        url: transition.path,
        headers: transition.credential === "original" ? { cookie: `pp_session=${token}` } : {},
      });
      const raw = response.headers["set-cookie"];
      const setCookie = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
      cases.push({
        ...transition,
        expected: {
          status: response.statusCode,
          body: response.json(),
          clearing_cookies: clearingCookies(setCookie),
          session_rows: inspection.prepare("SELECT COUNT(*) AS n FROM sessions").get().n,
        },
        node_set_cookie: setCookie,
      });
    }
    assert.equal(cases[0].expected.status, 200, "the initial session authenticates");
    assert.equal(cases[0].expected.session_rows, 1, "the initial session exists");
    assert.equal(cases.at(-1).expected.status, 401, "logout survives storage reopen");
    assert.equal(cases.at(-1).expected.session_rows, 0, "logout removes the stored session");
    process.stdout.write(`\n${JSON.stringify({ seed, cases })}\n`);
  } finally {
    await app?.close();
    inspection?.close();
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
} else {
  const probe = execFileSync(process.execPath, [
    "--conditions=development", "--import",
    pathToFileURL(join(root, "web/node_modules/tsx/dist/esm/index.mjs")).href,
    fileURLToPath(import.meta.url), "--probe",
  ], { cwd: join(root, "web/apps/server"), encoding: "utf8", env: {
    ...process.env, NODE_ENV: "production",
  } });
  const captured = JSON.parse(probe.trim().split("\n").at(-1));
  const text = `${JSON.stringify({
    generated: "@generated by fixtures/parity/auth-session/generate.mjs. Do not edit.",
    sources: ["web/apps/server/src/routes/auth.ts", "web/apps/server/src/services/auth-store.ts"],
    ...captured,
  }, null, 2)}\n`;
  if (process.argv.includes("--check")) {
    assert.equal(readFileSync(output, "utf8"), text, "node.json is out of date");
  } else {
    writeFileSync(output, text);
  }
  console.log(JSON.stringify({ transitions: captured.cases.length, check: process.argv.includes("--check") }));
}
