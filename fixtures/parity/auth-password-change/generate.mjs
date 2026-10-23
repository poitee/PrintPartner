import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const output = join(here, "node.json");
const originalPassword = "original-password-873";
const replacementPassword = "replacement-password-873";
const email = "password-parity@example.test";
const valid = { current_password: originalPassword, new_password: replacementPassword };
const empty = {};
/** @typedef {"absent"|"valid"|"invalid"|"revoked"} SessionKind */
const inputs = [
  { id: "missing_session", session: "absent", body: valid },
  { id: "wrong_current", session: "valid", body: { ...valid, current_password: "incorrect-password-873" } },
  { id: "valid_change", session: "valid", body: valid },
  { id: "missing_both", session: "valid", body: empty },
  { id: "missing_current", session: "valid", body: { new_password: replacementPassword } },
  { id: "missing_new", session: "valid", body: { current_password: originalPassword } },
  ...["current_password", "new_password"].flatMap((field) => [
    ...[["null", null], ["number", 873], ["boolean", true], ["array", []], ["object", {}]]
      .map(([kind, value]) => ({
        id: `${field}_${kind}`,
        session: "valid",
        body: { ...valid, [field]: value },
      })),
    { id: `${field}_empty`, session: "valid", body: { ...valid, [field]: "" } },
    { id: `${field}_short`, session: "valid", body: { ...valid, [field]: "short" } },
  ]),
  // Stale cookies must 401 before field validation (Node onRequest resolve).
  { id: "invalid_session_valid_body", session: "invalid", body: valid },
  { id: "invalid_session_missing_both", session: "invalid", body: empty },
  { id: "revoked_session_valid_body", session: "revoked", body: valid },
  { id: "revoked_session_missing_both", session: "revoked", body: empty },
].map((input) => ({
  ...input,
  proposed_password:
    typeof input.body.new_password === "string" && input.body.new_password.length > 0
      ? input.body.new_password
      : replacementPassword,
}));

if (process.argv.includes("--probe")) {
  const require = createRequire(join(root, "web/apps/server/package.json"));
  const Fastify = require("fastify");
  const cookie = require("@fastify/cookie");
  const load = (path) => import(pathToFileURL(join(root, "web/apps/server/src", path)).href);
  const { createSelfHostPorts } = await load("adapters/self-host/index.ts");
  const { getDb } = await load("db/client.ts");
  const { AuthStore } = await load("services/auth-store.ts");
  const { registerAuthRoutes, registerTenantMiddleware } = await load("routes/auth.ts");
  const cases = [];
  for (const input of inputs) {
    const directory = mkdtempSync(join(tmpdir(), "pp-password-parity-"));
    const ports = createSelfHostPorts(directory);
    const app = Fastify();
    try {
      await ports.db.connect();
      await app.register(cookie);
      const auth = new AuthStore(getDb(ports.db.sqlite));
      const config = {
        deployMode: "self-host", multiUser: true, singleUserAuth: false,
        authRequired: true, registrationOpen: true, sessionCookieSecure: false,
        githubOAuthConfigured: false, discordOAuthConfigured: false,
        saasBasicAuth: null, saasAllowAnonymous: false,
      };
      registerTenantMiddleware(app, config, auth);
      registerAuthRoutes(app, config, auth);
      const registration = await app.inject({
        method: "POST", url: "/auth/register",
        payload: { email, password: originalPassword, display_name: "Password parity" },
      });
      assert.equal(registration.statusCode, 200, input.id);
      const issued = registration.cookies.find((entry) => entry.name === "pp_session");
      assert.ok(issued?.value, input.id);
      /** @type {Record<string, string>|undefined} */
      let cookies;
      if (input.session === "valid") {
        cookies = { pp_session: issued.value };
      } else if (input.session === "invalid") {
        cookies = { pp_session: "invalid-session-token-873" };
      } else if (input.session === "revoked") {
        const logout = await app.inject({
          method: "POST", url: "/auth/logout", payload: {},
          cookies: { pp_session: issued.value },
        });
        assert.equal(logout.statusCode, 200, input.id);
        cookies = { pp_session: issued.value };
      } else {
        cookies = undefined;
      }
      const login = async (password) => {
        const response = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
        assert.ok([200, 400, 401].includes(response.statusCode), response.body);
        if (response.statusCode === 200) {
          assert.equal(response.json().user.email, email);
          assert.ok(response.cookies.find((entry) => entry.name === "pp_session")?.value);
        }
        return response.statusCode === 200;
      };
      const logins = async () => ({
        old: await login(originalPassword),
        new: await login(input.proposed_password),
      });
      const before = await logins();
      const changed = await app.inject({
        method: "POST", url: "/auth/change-password", payload: input.body,
        cookies,
      });
      const observation = {
        before,
        change: { status: changed.statusCode, body: changed.json() },
        after: await logins(),
      };
      const success = input.id === "valid_change";
      assert.deepEqual(before, { old: true, new: false }, input.id);
      assert.equal(changed.statusCode === 200, success, input.id);
      assert.deepEqual(observation.after, { old: !success, new: success }, input.id);
      if (input.session === "invalid" || input.session === "revoked" || input.session === "absent") {
        assert.equal(changed.statusCode, 401, input.id);
        assert.deepEqual(changed.json(), { detail: "Authentication required" }, input.id);
      }
      cases.push({ ...input, observation });
    } finally {
      await app.close();
      await ports.db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
  process.stdout.write(JSON.stringify({ original_password: originalPassword, email, cases }));
} else {
  const probe = execFileSync(process.execPath, [
    "--conditions=development", "--import", pathToFileURL(join(root, "web/node_modules/tsx/dist/esm/index.mjs")).href,
    fileURLToPath(import.meta.url), "--probe",
  ], { cwd: join(root, "web/apps/server"), encoding: "utf8", env: { NODE_ENV: "production" } });
  const recorded = JSON.parse(probe);
  assert.ok(recorded.cases.length > 0, "No password-change cases recorded");
  assert.equal(recorded.cases.length, inputs.length);
  assert.deepEqual(recorded.cases.map(({ observation, ...input }) => input), inputs);
  const text = `${JSON.stringify({
    generated: "@generated by fixtures/parity/auth-password-change/generate.mjs. Do not edit.",
    source: "web/apps/server/src/routes/auth.ts",
    ...recorded,
  }, null, 2)}\n`;
  const check = process.argv.includes("--check");
  if (check) assert.equal(readFileSync(output, "utf8"), text, "node.json is out of date");
  else writeFileSync(output, text);
  console.log(JSON.stringify({ cases: recorded.cases.length, check }));
}
