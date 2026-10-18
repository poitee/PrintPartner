// Generates the reset-completion parity golden from Node's real Fastify auth
// routes over a disposable data dir. Run from the repo root after
// `npm --prefix web ci --ignore-scripts`:
//   node fixtures/parity/auth-reset-complete/generate.mjs          # write
//   node fixtures/parity/auth-reset-complete/generate.mjs --check  # verify, no writes
// Steps name tokens, passwords and sessions by label. The golden records no raw
// token, password or cookie; the Rust replay derives the same values per label.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const source = "web/apps/server/src/routes/auth.ts";
const output = join(here, "node.json");

const steps = [
  { id: "register", call: "register", password: "old" },
  { id: "request_a", call: "forgot", capture: "a" },
  { id: "reset_missing_token", call: "reset", token: null, password: "new" },
  { id: "reset_unknown_token", call: "reset", token: "unknown", password: "new" },
  { id: "reset_a_short_password", call: "reset", token: "a", password: "short" },
  { id: "login_new_before_reset", call: "login", password: "new" },
  { id: "reset_a", call: "reset", token: "a", password: "new" },
  { id: "me_registered_session", call: "me", session: "register" },
  { id: "me_reset_session", call: "me", session: "reset_a" },
  { id: "login_old_after_reset", call: "login", password: "old" },
  { id: "login_new_after_reset", call: "login", password: "new" },
  { id: "replay_a", call: "reset", token: "a", password: "other" },
  { id: "login_other_after_replay", call: "login", password: "other" },
  { id: "request_b", call: "forgot", capture: "b" },
  { id: "expire_b", call: "expire", token: "b" },
  { id: "reset_expired_b", call: "reset", token: "b", password: "other" },
  { id: "login_other_after_expiry", call: "login", password: "other" },
  { id: "login_new_after_expiry", call: "login", password: "new" },
];
const email = "reset-complete@example.test";
const password = (label) => (label === "short" ? "short" : `pp-fixture-${label}-password`);

if (process.argv.includes("--probe")) {
  const Database = createRequire(join(root, "web/apps/server/package.json"))("better-sqlite3");
  const { buildApp } = await import(pathToFileURL(join(root, "web/apps/server/src/app.ts")).href);
  const { createSelfHostPorts } = await import(pathToFileURL(join(root, "web/apps/server/src/adapters/self-host/index.ts")).href);
  const { loadConfig } = await import(pathToFileURL(join(root, "web/apps/server/src/config.ts")).href);
  const directory = mkdtempSync(join(tmpdir(), "pp-auth-reset-complete-"));
  try {
    const config = {
      ...loadConfig(),
      dataDir: directory,
      multiUser: true,
      singleUserAuth: false,
      authRequired: true,
      registrationOpen: true,
      sessionSecret: "fixture-session-secret",
      sessionCookieSecure: false,
      appPublicUrl: null,
      smtpConfigured: false,
      passwordResetDevExpose: true,
    };
    const ports = createSelfHostPorts(directory);
    await ports.db.connect();
    const app = await buildApp(config, ports);
    const db = new Database(join(directory, "print-partner.db"));
    const state = () => {
      const user = db.prepare("SELECT id, password_hash FROM users WHERE email = ?").get(email);
      const count = (table) => (user ? db.prepare(`SELECT count(*) AS n FROM ${table} WHERE user_id = ?`).get(user.id).n : 0);
      return { hash: user?.password_hash ?? null, sessions: count("sessions"), reset_tokens: count("password_reset_tokens") };
    };
    const tokens = { unknown: "fixture-unknown-reset-token" };
    const sessions = {};
    const observations = [];
    for (const step of steps) {
      const before = state();
      let response;
      if (step.call === "expire") {
        db.prepare("UPDATE password_reset_tokens SET expires_at = ? WHERE id = ?").run(
          "2000-01-01T00:00:00.000Z",
          db.prepare("SELECT id FROM password_reset_tokens").get().id,
        );
      } else if (step.call === "me") {
        response = await app.inject({ method: "GET", url: "/auth/me", cookies: { pp_session: sessions[step.session] } });
      } else {
        const payload = {
          register: () => ({ email, password: password(step.password) }),
          login: () => ({ email, password: password(step.password) }),
          forgot: () => ({ email }),
          reset: () => ({ ...(step.token ? { token: tokens[step.token] } : {}), password: password(step.password) }),
        }[step.call]();
        const url = { register: "/auth/register", login: "/auth/login", forgot: "/auth/forgot-password", reset: "/auth/reset-password" }[step.call];
        response = await app.inject({ method: "POST", url, payload });
      }
      const after = state();
      const observation = { id: step.id, identity_write: before.hash !== after.hash, sessions: after.sessions, reset_tokens: after.reset_tokens };
      if (response) {
        const body = response.json();
        if (body.user?.user_id) body.user.user_id = "<user_id>";
        if (body.dev_reset_url) {
          tokens[step.capture] = new URL(body.dev_reset_url).searchParams.get("token");
          body.dev_reset_url = "<reset_url>";
        }
        const session = response.cookies.find((cookie) => cookie.name === "pp_session")?.value;
        if (session) sessions[step.id] = session;
        Object.assign(observation, { status: response.statusCode, body, session_issued: Boolean(session) });
      }
      observations.push(observation);
    }
    db.close();
    await app.close();
    writeFileSync(process.argv.at(-1), JSON.stringify(observations));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  process.exit(0);
}

const tsx = join(root, "web/node_modules/tsx/dist/esm/index.mjs");
const scratch = mkdtempSync(join(tmpdir(), "pp-auth-reset-complete-out-"));
let observations;
try {
  const result = join(scratch, "observations.json");
  // The app logs to stdout, so the probe returns its result through a file.
  execFileSync(
    process.execPath,
    ["--conditions=development", "--import", pathToFileURL(tsx).href, fileURLToPath(import.meta.url), "--probe", result],
    { cwd: join(root, "web/apps/server"), stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, NODE_ENV: "test" } },
  );
  observations = JSON.parse(readFileSync(result, "utf8"));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
const generated = "@generated by fixtures/parity/auth-reset-complete/generate.mjs. Do not edit.";
const header = JSON.stringify({ generated, source, email });
const lines = (rows) => rows.map((row) => JSON.stringify(row)).join(",\n");
const text = `${header.slice(0, -1)},\n"steps":[\n${lines(steps)}\n],\n"observations":[\n${lines(observations)}\n]}\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(output, "utf8") !== text) throw new Error("node.json is out of date");
} else {
  writeFileSync(output, text);
}
console.log(JSON.stringify({ steps: steps.length, check: process.argv.includes("--check") }));
