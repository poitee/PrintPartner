// Generates the reset-request parity golden from Node's real Fastify auth routes.
// Run from the repo root with Node 22.23.3 after `npm --prefix web ci --ignore-scripts`:
//   node fixtures/parity/auth-reset/generate.mjs          # write
//   node fixtures/parity/auth-reset/generate.mjs --check  # verify, no writes
// SMTP stays on a loopback fake. The golden stores the shared public response,
// delivery and token counts, and the mail-failure error class. It stores no
// address, token, or provider message.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const source = "web/apps/server/src/routes/auth.ts";
const output = join(here, "node.json");
const canonicalNode = "v22.23.3";
const publicMessage = "If an account exists for that email, a reset link was sent.";
const allowedErrorClasses = [
  "client",
  "delivery_task",
  "invalid_recipient",
  "message_build",
  "smtp_permanent",
  "smtp_response",
  "smtp_transient",
  "timeout",
  "tls",
  "transport",
];
const cases = [
  { id: "known_account", mode: "accept", register: true },
  { id: "unknown_account", mode: "accept", register: false },
  { id: "mailer_failure", mode: "reject", register: true },
];

if (process.argv.includes("--probe")) {
  const stdoutChunks = [];
  const remember = (fd, data) => {
    if (fd === 1) stdoutChunks.push(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
  };
  const originalWrite = fs.write;
  const originalWriteSync = fs.writeSync;
  fs.write = function (fd, data, ...rest) {
    remember(fd, data);
    return originalWrite.call(this, fd, data, ...rest);
  };
  fs.writeSync = function (fd, data, ...rest) {
    remember(fd, data);
    return originalWriteSync.call(this, fd, data, ...rest);
  };
  const Database = createRequire(join(root, "web/apps/server/package.json"))("better-sqlite3");
  const { buildApp } = await import(pathToFileURL(join(root, "web/apps/server/src/app.ts")).href);
  const { createSelfHostPorts } = await import(
    pathToFileURL(join(root, "web/apps/server/src/adapters/self-host/index.ts")).href
  );
  const { loadConfig } = await import(pathToFileURL(join(root, "web/apps/server/src/config.ts")).href);
  const known = "known@reset.example.test";
  const unknown = "unknown@reset.example.test";
  const mailer = "fixture-mailer@example.test";
  const password = "pp-fixture-reset-password";
  const refuse = (message) => {
    throw new Error(message);
  };
  const publicBody = (status, body) =>
    status === 200 &&
    body?.ok === true &&
    body.message === publicMessage &&
    Object.keys(body).length === 2;

  function startSmtp(mode) {
    const messages = [];
    const server = createServer((socket) => {
      socket.write("220 fixture SMTP\r\n");
      let collecting = false;
      let pending = "";
      socket.on("data", (chunk) => {
        pending += chunk.toString("utf8");
        for (;;) {
          if (collecting) {
            const end = pending.indexOf("\r\n.\r\n");
            if (end < 0) return;
            messages.push(pending.slice(0, end));
            pending = pending.slice(end + 5);
            collecting = false;
            socket.write(mode === "reject" ? "550 rejected\r\n" : "250 queued\r\n");
            continue;
          }
          const split = pending.indexOf("\r\n");
          if (split < 0) return;
          const line = pending.slice(0, split);
          pending = pending.slice(split + 2);
          if (line.startsWith("EHLO") || line.startsWith("HELO")) {
            socket.write("250-fixture\r\n250 8BITMIME\r\n");
          } else if (line.startsWith("DATA")) {
            socket.write("354 send data\r\n");
            collecting = true;
          } else if (line.startsWith("QUIT")) {
            socket.write("221 bye\r\n");
          } else {
            socket.write("250 OK\r\n");
          }
        }
      });
    });
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        resolve({
          port: server.address().port,
          messages,
          close: () => new Promise((done) => server.close(() => done())),
        });
      });
    });
  }

  const observations = [];
  for (const spec of cases) {
    const smtp = await startSmtp(spec.mode);
    const directory = mkdtempSync(join(tmpdir(), "pp-auth-reset-"));
    const ports = createSelfHostPorts(directory);
    const logStart = stdoutChunks.length;
    try {
      const config = {
        ...loadConfig(),
        dataDir: directory,
        deployMode: "self-host",
        saasAllowAnonymous: false,
        saasBasicAuth: null,
        multiUser: true,
        singleUserAuth: false,
        authRequired: true,
        registrationOpen: true,
        sessionSecret: "fixture-session-secret",
        sessionCookieSecure: false,
        appPublicUrl: "https://canonical.example",
        smtpConfigured: true,
        smtpHost: "127.0.0.1",
        smtpPort: smtp.port,
        smtpUser: null,
        smtpPass: null,
        smtpFrom: `Print Partner <${mailer}>`,
        smtpSecure: false,
        passwordResetDevExpose: false,
      };
      await ports.db.connect();
      const app = await buildApp(config, ports);
      if (spec.register) {
        const registration = await app.inject({
          method: "POST",
          url: "/auth/register",
          payload: { email: known, password, display_name: "Reset" },
        });
        if (registration.statusCode !== 200) refuse(`${spec.id} registration status ${registration.statusCode}`);
      }
      const response = await app.inject({
        method: "POST",
        url: "/auth/forgot-password",
        payload: { email: spec.register ? known : unknown },
      });
      let body = null;
      try {
        body = response.json();
      } catch {
        body = null;
      }
      if (!publicBody(response.statusCode, body)) {
        refuse(`${spec.id} public response is not the shared non-enumerating body (status ${response.statusCode})`);
      }
      const db = new Database(join(directory, "print-partner.db"));
      let resetTokens = 0;
      try {
        resetTokens = db.prepare("SELECT count(*) AS n FROM password_reset_tokens").get().n;
      } finally {
        db.close();
      }
      const logText = stdoutChunks.slice(logStart).join("");
      const tokens = smtp.messages.flatMap((message) => {
        const match = message.match(/token=([^&\s]+)/);
        return match ? [decodeURIComponent(match[1])] : [];
      });
      const disclosed =
        logText.includes("@") ||
        logText.includes("token=") ||
        logText.includes(known) ||
        logText.includes(unknown) ||
        logText.includes(mailer) ||
        tokens.some((token) => token && logText.includes(token)) ||
        JSON.stringify(body).includes("@");
      if (disclosed) refuse(`${spec.id} log or response disclosed a fixture address or token`);
      const classes = [...logText.matchAll(/error_class=([a-z_]+)/g)].map((match) => match[1]);
      if (spec.mode === "reject") {
        if (classes.length !== 1 || !allowedErrorClasses.includes(classes[0])) {
          refuse(`${spec.id} did not log exactly one allowed error class`);
        }
      } else if (classes.length !== 0) {
        refuse(`${spec.id} logged an error class without a mail failure`);
      }
      if (smtp.messages.length !== (spec.id === "unknown_account" ? 0 : 1)) {
        refuse(`${spec.id} delivery count ${smtp.messages.length}`);
      }
      observations.push({
        id: spec.id,
        deliveries: smtp.messages.length,
        reset_tokens: resetTokens,
        error_class: classes[0] ?? null,
      });
      await app.close();
    } finally {
      await ports.db.close();
      await smtp.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
  writeFileSync(process.argv.at(-1), JSON.stringify(observations));
  process.exit(0);
}

if (process.version !== canonicalNode) {
  throw new Error(`auth-reset golden requires Node ${canonicalNode}`);
}
const tsx = join(root, "web/node_modules/tsx/dist/esm/index.mjs");
const probeEnv = { NODE_ENV: "test" };
for (const key of ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot", "USERPROFILE"]) {
  if (process.env[key] !== undefined) probeEnv[key] = process.env[key];
}
const scratch = mkdtempSync(join(tmpdir(), "pp-auth-reset-out-"));
let observations;
try {
  const result = join(scratch, "observations.json");
  execFileSync(
    process.execPath,
    ["--conditions=development", "--import", pathToFileURL(tsx).href, fileURLToPath(import.meta.url), "--probe", result],
    { cwd: join(root, "web/apps/server"), stdio: ["ignore", "ignore", "inherit"], env: probeEnv },
  );
  observations = JSON.parse(readFileSync(result, "utf8"));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
const generated = "generated by fixtures/parity/auth-reset/generate.mjs. Do not edit.";
const text = `${JSON.stringify(
  {
    generated,
    source,
    public_response: { status: 200, body: { ok: true, message: publicMessage } },
    allowed_error_classes: allowedErrorClasses,
    cases: observations,
  },
  null,
  2,
)}\n`;
if (text.includes("@") || text.includes("token=")) {
  throw new Error("golden would contain a fixture address or token");
}
if (process.argv.includes("--check")) {
  if (readFileSync(output, "utf8") !== text) throw new Error("node.json is out of date");
} else {
  writeFileSync(output, text);
}
console.log(JSON.stringify({ cases: observations.length, check: process.argv.includes("--check") }));
