import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const canonicalNode = "v22.23.3";
const email = "admission@example.test";
const registration = { email, password: "fixture-admission-password", display_name: "Admission" };
const tables = { users: "users", sessions: "sessions", reset_tokens: "password_reset_tokens", identities: "auth_identities" };
const resetToken = "fixture-admission-reset-token";
const bodies = {
  register: registration, forgot: { email }, login: { email, password: registration.password }, logout: {},
  reset: { token: resetToken, password: "fixture-admission-password-reset" }, me: {}, create: {}, revoke: {}, regenerate: {},
  change: { current_password: registration.password, new_password: "fixture-admission-password-changed" },
};
const paths = { register: "register", forgot: "forgot-password", login: "login", logout: "logout", change: "change-password", reset: "reset-password", me: "me" };
const productive = {
  register: { users: 1, sessions: 1, reset_tokens: 0, identities: 0 }, forgot: { users: 0, sessions: 0, reset_tokens: 1, identities: 0 },
  login: { users: 0, sessions: 1, reset_tokens: 0, identities: 0 }, logout: { users: 0, sessions: -1, reset_tokens: 0, identities: 0 },
  change: { users: 0, sessions: 0, reset_tokens: 0, identities: 0 },
};
for (const route of ["reset", "me", "create", "revoke", "regenerate"]) productive[route] = { users: 0, sessions: 0, reset_tokens: route === "reset" ? -1 : 0, identities: 0 };
const guards = ["control", "foreign-origin", "missing-origin", "foreign-host"];
const extraHeaders = {
  "duplicate-host": ["host", "evil.example"], "duplicate-origin": ["origin", "http://evil.example"],
  "x-forwarded-host": ["x-forwarded-host", "evil.example"], "x-forwarded-for": ["x-forwarded-for", "203.0.113.9"],
  "x-forwarded-proto": ["x-forwarded-proto", "https"], forwarded: ["forwarded", "for=203.0.113.9;host=evil.example;proto=https"],
};
const cases = [
  ...guards.map((name) => ["register", name]),
  ...["control", "at-16384", "foreign-origin", "missing-origin", "foreign-host", "over-16384", "over-1048576", "malformed", "text-plain", "foreign-origin-over-1048576"].map((name) => ["forgot", name]),
  ...[...guards, ...Object.keys(extraHeaders)].map((name) => ["login", name]),
  ...guards.map((name) => ["logout", name]),
  ...guards.map((name) => ["change", name]),
  ...guards.map((name) => ["reset", name]),
  ...[...guards, ...Object.keys(extraHeaders), "cross-site"].map((name) => ["me", name]),
  ...["create", "revoke", "regenerate"].flatMap((route) => [...guards, ...Object.keys(extraHeaders)].map((name) => [route, name])),
].map(([route, name]) => ({
  id: `${route}/${name}`, route,
  origin: name.startsWith("foreign-origin") ? "foreign" : name === "missing-origin" ? "absent" : "listener",
  host: name === "foreign-host" ? "foreign" : "listener",
  content_type: name === "text-plain" ? "text/plain" : "application/json",
  body: name === "malformed" ? { kind: "raw", text: '{"email":' }
    : name === "at-16384" ? { kind: "exact_bytes", bytes: 16384 }
    : name === "over-16384" ? { kind: "exact_bytes", bytes: 16385 }
    : name.endsWith("over-1048576") ? { kind: "exact_bytes", bytes: 1048577 } : { kind: "valid" },
  ...((extraHeaders[name] || name === "cross-site") && { extra_header: extraHeaders[name] ?? ["sec-fetch-site", "cross-site"] }),
}));
function bodyFor(recipe) {
  const base = recipe.route === "me" ? "" : JSON.stringify(bodies[recipe.route]);
  if (recipe.body.kind === "raw") return Buffer.from(recipe.body.text);
  if (recipe.body.kind === "valid") return Buffer.from(base);
  assert(recipe.body.bytes >= Buffer.byteLength(base));
  const body = Buffer.from(base.slice(0, -1) + " ".repeat(recipe.body.bytes - Buffer.byteLength(base)) + "}");
  assert.equal(body.length, recipe.body.bytes);
  return body;
}
async function bounded(promise, ms, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); })]); }
  finally { clearTimeout(timer); }
}
function send(origin, recipe, cookie, keyId) {
  return new Promise((resolve, reject) => {
    let captured = false;
    const body = bodyFor(recipe);
    const headers = ["host", recipe.host === "foreign" ? "evil.example" : new URL(origin).host, "content-type", recipe.content_type, "content-length", String(body.length), "connection", "close"];
    if (recipe.origin !== "absent") headers.push("origin", recipe.origin === "foreign" ? "http://evil.example" : origin);
    if (recipe.extra_header) headers.push(...recipe.extra_header);
    if (cookie) headers.push("cookie", cookie);
    const path = ["create", "revoke", "regenerate"].includes(recipe.route)
      ? `/settings/api-keys${recipe.route === "create" ? "" : `/${keyId}${recipe.route === "regenerate" ? "/regenerate" : ""}`}`
      : `/auth/${paths[recipe.route]}`;
    const method = recipe.route === "me" ? "GET" : recipe.route === "revoke" ? "DELETE" : "POST";
    const req = request(`${origin}${path}`, { method, headers, agent: false }, (res) => {
      captured = true;
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()), cookie: res.headers["set-cookie"] ?? [] }); }
        catch (error) { reject(error); }
      });
    });
    req.setTimeout(10000, () => req.destroy(new Error("HTTP request timed out")));
    req.on("error", (error) => { if (!(captured && ["EPIPE", "ECONNRESET"].includes(error.code))) reject(error); });
    req.end(body);
  });
}
function smtpFixture() {
  const sockets = new Set();
  const counts = { connections: 0, messages: 0 };
  const server = createServer((socket) => {
    counts.connections++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.write("220 fixture ESMTP\r\n");
    let buffer = "", data = false;
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      while (buffer.includes("\r\n")) {
        const end = buffer.indexOf("\r\n");
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (data) {
          if (line === ".") { counts.messages++; data = false; socket.write("250 accepted\r\n"); }
        } else if (/^(EHLO|HELO)/.test(line)) socket.write("250 fixture\r\n");
        else if (line === "DATA") { data = true; socket.write("354 continue\r\n"); }
        else if (line === "QUIT") socket.end("221 bye\r\n");
        else socket.write("250 ok\r\n");
      }
    });
  });
  return { server, sockets, counts };
}

if (process.argv.includes("--probe")) {
  const Database = createRequire(join(root, "web/apps/server/package.json"))("better-sqlite3");
  const { buildApp } = await import(pathToFileURL(join(root, "web/apps/server/src/app.ts")).href);
  const { createSelfHostPorts } = await import(pathToFileURL(join(root, "web/apps/server/src/adapters/self-host/index.ts")).href);
  const { loadConfig } = await import(pathToFileURL(join(root, "web/apps/server/src/config.ts")).href);
  const observations = [];
  for (const recipe of cases) {
    const directory = mkdtempSync(join(tmpdir(), "pp-admission-"));
    const ports = createSelfHostPorts(directory);
    const mail = smtpFixture();
    let app, db, result, failure;
    const cleanupErrors = [];
    const deadline = Date.now() + 45000;
    const within = (promise, ms, label) => bounded(promise, Math.max(1, Math.min(ms, deadline - Date.now())), label);
    try {
      await within(new Promise((resolve, reject) => { mail.server.once("error", reject); mail.server.listen(0, "127.0.0.1", resolve); }), 5000, "SMTP listen");
      await within(ports.db.connect(), 5000, "database setup");
      app = await within(buildApp({ ...loadConfig(), dataDir: directory, deployMode: "self-host", saasAllowAnonymous: false, saasBasicAuth: null,
        multiUser: true, singleUserAuth: false, authRequired: true, registrationOpen: true, sessionSecret: "fixture-session-secret",
        sessionCookieSecure: false, trustProxy: false, corsOrigin: true, passwordResetDevExpose: false,
        appPublicUrl: "https://admission.example.test", smtpConfigured: true, smtpHost: "127.0.0.1", smtpPort: mail.server.address().port,
        smtpSecure: false, smtpFrom: "fixture@example.test", smtpUser: null, smtpPass: null }, ports), 10000, "app setup");
      await within(app.listen({ host: "127.0.0.1", port: 0 }), 5000, "HTTP listen");
      const origin = `http://127.0.0.1:${app.server.address().port}`;
      db = new Database(join(directory, "print-partner.db"));
      let cookie, keyId;
      if (recipe.route !== "register") {
        const seed = await within(send(origin, cases[0]), 10000, "seed request");
        assert.equal(seed.status, 200, "seed registration");
        if (["logout", "change", "me", "create", "revoke", "regenerate"].includes(recipe.route)) cookie = seed.cookie.find((value) => value.startsWith("pp_session=")).split(";")[0];
      }
      if (recipe.route === "reset") {
        const user = db.prepare("SELECT id FROM users WHERE email=?").get(email);
        db.prepare("INSERT INTO password_reset_tokens(id,user_id,expires_at,created_at) VALUES(?,?,?,?)").run(
          createHash("sha256").update(resetToken).digest("hex"), user.id, "2099-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
      }
      if (["create", "revoke", "regenerate"].includes(recipe.route)) {
        const seed = await within(send(origin, cases.find((row) => row.id === "create/control"), cookie), 10000, "seed API key");
        assert.equal(seed.status, 201, "seed API key");
        keyId = seed.body.id;
        assert.equal(typeof keyId, "string");
      }
      const snapshot = () => {
        const state = Object.fromEntries(Object.entries(tables).map(([key, table]) => [key, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
        state.settings = db.prepare("SELECT * FROM app_settings ORDER BY rowid").all();
        state.sequence = db.prepare("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").get() ? db.prepare("SELECT * FROM sqlite_sequence ORDER BY name").all() : null;
        return state;
      };
      const before = snapshot();
      const response = await within(send(origin, recipe, cookie, keyId), 10000, "case request");
      await within(app.close(), 10000, "HTTP stop");
      app = undefined;
      await within(ports.db.close(), 5000, "database stop");
      const after = snapshot();
      result = { before, after, response, keyId, mail: { ...mail.counts } };
    } catch (error) { failure = error; }
    finally {
      for (const clean of [async () => { if (app) { app.server.closeAllConnections(); await within(app.close(), 10000, "HTTP cleanup"); } },
        async () => { for (const socket of mail.sockets) socket.destroy(); if (mail.server.listening) await within(new Promise((resolve, reject) => mail.server.close((error) => error ? reject(error) : resolve())), 5000, "SMTP stop"); },
        async () => { await within(ports.db.close(), 5000, "database cleanup"); }, async () => { db?.close(); }, async () => { rmSync(directory, { recursive: true, force: true }); }]) {
        try { await clean(); } catch (error) { cleanupErrors.push(error); }
      }
    }
    if (failure) { if (cleanupErrors.length) console.error(cleanupErrors); throw failure; }
    const { before, after, response, keyId } = result;
    const rows = Object.fromEntries(Object.keys(tables).map((key) => [key, after[key].length - before[key].length]));
    const session_issued = response.cookie.some((cookie) => /^pp_session=[^;]+;/.test(cookie));
    const admitted = response.status < 400;
    const state_changed = JSON.stringify(after) !== JSON.stringify(before);
    try {
      assert(Date.now() <= deadline, `${recipe.id}: case exceeded 45 seconds`);
      if (!admitted) {
        assert.deepEqual(after, before, `${recipe.id}: complete refusal snapshot`);
        assert.equal(result.mail.connections, 0, `${recipe.id}: refusal mail`);
        assert.equal(result.mail.messages, 0);
        assert.equal(session_issued, false);
      } else {
        assert.deepEqual(rows, productive[recipe.route], `${recipe.id}: productive rows`);
        assert.equal(state_changed, recipe.route !== "me", `${recipe.id}: productive state change`);
        assert.equal(session_issued, ["register", "login", "change", "reset"].includes(recipe.route));
        assert.equal(result.mail.connections, recipe.route === "forgot" ? 1 : 0);
        assert.equal(result.mail.messages, recipe.route === "forgot" ? 1 : 0);
        if (["register", "login", "reset", "me"].includes(recipe.route)) {
          assert.equal(response.body.user.user_id, after.users[0].id);
          assert.equal(response.body.user.email, email);
          assert.equal(response.body.user.display_name, "Admission");
          if (recipe.route === "me") assert.equal(response.body.multi_user, true);
        } else if (recipe.route === "forgot") assert.deepEqual(response.body, { ok: true, message: "If an account exists for that email, a reset link was sent." });
        else if (["create", "regenerate"].includes(recipe.route)) {
          assert.equal(response.status, 201);
          assert.equal(typeof response.body.id, "string");
          assert.equal(typeof response.body.key, "string");
          assert(!JSON.stringify(after).includes(response.body.key), "plaintext key persisted");
          const keys = (state) => JSON.parse(state.settings.find((row) => row.key === "api_keys_v1").value);
          assert.equal(keys(after).length, keys(before).length + 1);
          assert(keys(after).some((key) => key.id === response.body.id && key.isActive === true
            && key.keyHash === createHmac("sha256", "print-partner:settings-api-key:v1").update(response.body.key).digest("hex")));
          if (recipe.route === "regenerate") assert.equal(keys(after).find((key) => key.id === keyId).isActive, false);
        } else if (recipe.route === "revoke") {
          assert.deepEqual(response.body, { success: true });
          assert.equal(JSON.parse(after.settings.find((row) => row.key === "api_keys_v1").value).find((key) => key.id === keyId).isActive, false);
        } else assert.deepEqual(response.body, { ok: true });
        if (["change", "reset"].includes(recipe.route)) assert.notEqual(after.users[0].password_hash, before.users[0].password_hash);
        if (recipe.route === "reset") {
          assert.equal(after.reset_tokens.length, 0);
          assert.equal(after.sessions.length, 1);
          assert.notEqual(after.sessions[0].id, before.sessions[0].id);
        }
      }
    } catch (error) {
      if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], "comparison and cleanup failed");
      throw error;
    }
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "cleanup failed");
    const body = bodyFor(recipe);
    observations.push({ ...recipe, body_len: body.length, body_sha256: createHash("sha256").update(body).digest("hex"),
      node: { status: response.status, public_error: admitted ? null : response.body, rows, state_changed, mail_connections: result.mail.connections, session_issued } });
  }
  writeFileSync(process.argv.at(-1), JSON.stringify(observations));
} else {
  const check = process.argv.includes("--check");
  if (process.version !== canonicalNode && !(check && process.argv.includes("--additional-runtime"))) {
    console.error(`auth admission: Node ${process.version} cannot ${check ? "check" : "capture"} the golden. Use Node ${canonicalNode} with native modules installed by it, or pass --check --additional-runtime to compare this runtime against the canonical golden.`);
    process.exit(2);
  }
  const env = { NODE_ENV: "test" };
  for (const key of ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot", "USERPROFILE"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  const directory = mkdtempSync(join(tmpdir(), "pp-admission-output-"));
  let observations;
  try {
    const result = join(directory, "result.json");
    execFileSync(process.execPath, ["--conditions=development", "--import", pathToFileURL(join(root, "web/node_modules/tsx/dist/esm/index.mjs")).href,
      fileURLToPath(import.meta.url), "--probe", result], { cwd: join(root, "web/apps/server"), env, stdio: ["ignore", "ignore", "inherit"], timeout: 180000 });
    observations = JSON.parse(readFileSync(result, "utf8"));
  } finally { rmSync(directory, { recursive: true, force: true }); }
  const text = `{"version":1,"cors_origin":true,"cases":[\n${observations.map((row) => JSON.stringify(row)).join(",\n")}\n]}\n`;
  if (check) assert.equal(readFileSync(join(here, "node.json"), "utf8"), text, "Node fixture is stale");
  else writeFileSync(join(here, "node.json"), text);
  console.log(`auth admission: ${observations.length} real-listener cases passed on ${process.version === canonicalNode ? "canonical" : "additional runtime"} Node ${process.version}`);
}
