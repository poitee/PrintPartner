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
const transports = [
  { transport: "loopback", sessionCookieSecure: false },
  { transport: "https", sessionCookieSecure: true },
];
const operations = ["login", "login-rejected", "logout", "logout-absent"];
const loginAttributes = ["Max-Age=1209600", "Path=/", "HttpOnly", "SameSite=Lax"];
const clearAttributes = ["Max-Age=0", "Path=/", "Expires=Thu, 01 Jan 1970 00:00:00 GMT", "SameSite=Lax"];

if (process.versions.node.split(".")[0] !== "22") {
  throw new Error("Capture auth cookie fixtures with Node 22, matching web/package.json");
}

function splitCookie(header) {
  const parts = header.split(";").map((part) => part.trim());
  return { pair: parts[0], attributes: parts.slice(1) };
}

function redact(header) {
  const { pair, attributes } = splitCookie(header);
  const value = pair.slice("pp_session=".length);
  assert.equal(pair.slice(0, "pp_session=".length), "pp_session=", header);
  if (value.length === 0) return header;
  assert.match(value, /^[0-9a-f]{64}$/, "session token shape");
  return `pp_session=<token>${attributes.length ? `; ${attributes.join("; ")}` : ""}`;
}

function headersOf(response) {
  const raw = response.headers["set-cookie"];
  if (raw === undefined) return [];
  return Array.isArray(raw) ? raw : [raw];
}

function assertAttributes(header, expected) {
  assert.deepEqual(splitCookie(header).attributes, expected, header);
}

if (process.argv.includes("--probe")) {
  const { default: Fastify } = await import(pathToFileURL(require.resolve("fastify")).href);
  const { default: cookie } = await import(pathToFileURL(require.resolve("@fastify/cookie")).href);
  const { SqliteDatabase, getDb } = await import(pathToFileURL(join(root, "web/apps/server/src/db/client.ts")).href);
  const { AuthStore } = await import(pathToFileURL(join(root, "web/apps/server/src/services/auth-store.ts")).href);
  const { registerAuthRoutes, registerTenantMiddleware } = await import(pathToFileURL(join(root, source)).href);
  const cases = [];
  for (const transport of transports) {
    for (const operation of operations) {
      const directory = mkdtempSync(join(tmpdir(), "pp-auth-cookie-node-"));
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
          registrationOpen: true,
          sessionCookieSecure: transport.sessionCookieSecure,
          githubOAuthConfigured: false,
          discordOAuthConfigured: false,
        };
        await app.register(cookie);
        registerTenantMiddleware(app, config, store);
        registerAuthRoutes(app, config, store);
        const send = (path, body, session) => app.inject({
          method: "POST",
          url: path,
          headers: {
            "content-type": "application/json",
            ...(session ? { cookie: `pp_session=${session}` } : {}),
          },
          payload: JSON.stringify(body),
        });
        const registered = await send("/auth/register", account);
        assert.equal(registered.statusCode, 200, `${operation} ${transport.transport} setup`);
        const issued = headersOf(registered).map(redact);
        assert.equal(issued.length, 1);
        const loginExpected = transport.sessionCookieSecure
          ? ["Max-Age=1209600", "Path=/", "HttpOnly", "Secure", "SameSite=Lax"]
          : loginAttributes;
        assertAttributes(issued[0], loginExpected);
        let response;
        if (operation === "login") {
          response = await send("/auth/login", account);
          assert.equal(response.statusCode, 200);
        } else if (operation === "login-rejected") {
          response = await send("/auth/login", { ...account, password: "wrong-password" });
          assert.equal(response.statusCode, 401);
        } else if (operation === "logout") {
          const loggedIn = await send("/auth/login", account);
          assert.equal(loggedIn.statusCode, 200);
          const token = headersOf(loggedIn)[0].slice("pp_session=".length).split(";", 1)[0];
          assert.match(token, /^[0-9a-f]{64}$/);
          response = await send("/auth/logout", {}, token);
          assert.equal(response.statusCode, 200);
        } else {
          response = await send("/auth/logout", {});
          assert.equal(response.statusCode, 200);
        }
        const setCookie = headersOf(response).map(redact);
        if (operation === "login") {
          assert.equal(setCookie.length, 1);
          assertAttributes(setCookie[0], loginExpected);
          assert.equal(splitCookie(setCookie[0]).pair, "pp_session=<token>");
        } else if (operation === "login-rejected") {
          assert.deepEqual(setCookie, []);
        } else {
          assert.equal(setCookie.length, 1);
          assertAttributes(setCookie[0], clearAttributes);
          assert.equal(splitCookie(setCookie[0]).pair, "pp_session=");
          assert.equal(setCookie[0].includes("HttpOnly"), false);
          assert.equal(setCookie[0].includes("Secure"), false);
        }
        cases.push({
          id: `${operation}-${transport.transport}`,
          transport: transport.transport,
          sessionCookieSecure: transport.sessionCookieSecure,
          node: { status: response.statusCode, setCookie },
        });
      } finally {
        await app.close();
        database.close();
        rmSync(directory, { recursive: true, force: true });
      }
    }
  }
  const encoded = JSON.stringify(cases);
  assert.equal(encoded.match(/[0-9a-f]{64}/g), null, "raw session values must not be recorded");
  process.stdout.write(encoded);
} else {
  const probe = execFileSync(process.execPath, [
    "--conditions=development",
    "--import",
    pathToFileURL(require.resolve("tsx/esm")).href,
    fileURLToPath(import.meta.url),
    "--probe",
  ], {
    cwd: root,
    env: { PATH: process.env.PATH, NODE_ENV: "production" },
    encoding: "utf8",
  });
  const cases = JSON.parse(probe);
  assert.deepEqual(cases.map((entry) => entry.id), transports.flatMap((transport) => (
    operations.map((operation) => `${operation}-${transport.transport}`)
  )));
  const text = `${JSON.stringify({
    generated: "@generated by fixtures/parity/auth-cookie/generate.mjs. Do not edit.",
    source,
    account,
    cases,
  }, null, 2)}\n`;
  assert.equal(text.match(/[0-9a-f]{64}/g), null, "raw session values must not be written");
  const check = process.argv.includes("--check");
  if (check) {
    assert.equal(readFileSync(output, "utf8"), text, "auth-cookie/node.json is out of date");
  } else {
    writeFileSync(output, text);
  }
  console.log(JSON.stringify({ cases: cases.length, check }));
}
