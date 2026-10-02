import { chmodSync, existsSync, readFileSync, rmdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { installDesktopContext, desktopContext } from "./desktop-context.js";

async function setupFromParent(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const timer = setTimeout(() => reject(new Error("Desktop setup timed out")), 5000);
    const read = (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      if (buffered.length > 8192) { clearTimeout(timer); reject(new Error("Desktop setup rejected")); return; }
      const end = buffered.indexOf("\n");
      if (end < 0) return;
      process.stdin.off("data", read);
      clearTimeout(timer);
      try { resolve(JSON.parse(buffered.slice(0, end))); } catch { reject(new Error("Desktop setup rejected")); }
    };
    process.stdin.on("data", read);
    process.stdin.once("end", () => { clearTimeout(timer); reject(new Error("Desktop parent disconnected")); });
  });
}

let stopping = false;
let runtime: Awaited<ReturnType<typeof import("./app.js").startServer>> | null = null;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.kill(-process.pid, "SIGKILL"), 9000);
  try {
    await runtime?.app.close();
    await runtime?.ports.db.close();
  } finally {
    clearTimeout(deadline);
    const setup = desktopContext();
    if (setup && process.ppid !== setup.parent_pid) {
      const marker = join(setup.data_dir, ".desktop-owner.json");
      try {
        const owner: unknown = JSON.parse(readFileSync(marker, "utf8"));
        if (typeof owner === "object" && owner !== null && "pid" in owner && owner.pid === setup.parent_pid) {
          rmSync(setup.socket_path, { force: true });
          rmdirSync(dirname(setup.socket_path));
          rmSync(marker);
        }
      } catch { /* Owner cleanup can race a normal Rust shutdown. */ }
    }
    process.kill(-process.pid, "SIGKILL");
  }
};

try {
  installDesktopContext(await setupFromParent());
  process.stdin.once("end", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
  process.once("SIGINT", () => { void stop(); });
  const setup = desktopContext();
  if (!setup) throw new Error("Desktop setup missing");
  const dbPath = join(setup.data_dir, "print-partner.db");
  if (existsSync(dbPath)) {
    const db = new Database(dbPath, { readonly: true });
    try {
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();
      if (table && db.prepare("SELECT 1 FROM users LIMIT 1").get()) throw new Error("Existing accounts require explicit desktop owner mapping");
    } finally { db.close(); }
  }
  process.env.PRINT_PARTNER_DATA_DIR = setup.data_dir;
  process.env.PRINT_PARTNER_UPDATE_CHECK = "0";
  const { loadConfig } = await import("./config.js");
  const { startServer } = await import("./app.js");
  const config = loadConfig();
  config.port = setup.port;
  config.authRequired = true;
  config.registrationOpen = false;
  config.multiUser = false;
  config.singleUserAuth = false;
  config.trustProxy = false;
  config.staticDir = null;
  config.databaseUrl = null;
  config.deployMode = "self-host";
  runtime = await startServer(config);
  chmodSync(setup.socket_path, 0o600);
  if (stopping) await stop();
} catch {
  process.stderr.write('{"event":"desktop_start_failed"}\n');
  await stop();
}
