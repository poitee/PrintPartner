// Records Node's settings API-key HTTP contract for the Rust auth_router parity test.
// Run from the repo root with Node 22 after `npm --prefix web ci`:
//   node fixtures/parity/auth-key/generate.mjs          # write node.json
//   node fixtures/parity/auth-key/generate.mjs --check  # verify, no writes
// Every key, ID and timestamp is generated in a temporary data directory. The
// golden stores only tokens for them, so it never holds a usable secret.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const server = join(root, "web/apps/server");
const output = join(here, "node.json");
const sources = [
  "web/apps/server/src/routes/api-key-management.ts",
  "web/apps/server/src/services/api-key-manager.ts",
];
const UNKNOWN = "key_0000000000000000";
const steps = [
  { op: "list" },
  { op: "create" },
  { op: "create" },
  { op: "list" },
  { op: "use", key: "<key:1>" },
  { op: "list" },
  { op: "revoke", id: "<id:1>" },
  { op: "revoke", id: "<id:1>" },
  { op: "use", key: "<key:1>" },
  { op: "rotate", id: "<id:2>" },
  { op: "use", key: "<key:2>" },
  { op: "use", key: "<key:3>" },
  { op: "use", key: "ppk_not-issued" },
  { op: "revoke", id: UNKNOWN },
  { op: "rotate", id: UNKNOWN },
  { op: "list" },
  { op: "reopen", expire: { "<id:3>": "2000-01-01T00:00:00.000Z" } },
  { op: "list" },
  { op: "use", key: "<key:1>" },
  { op: "use", key: "<key:3>" },
  { op: "create" },
  { op: "reopen", expire: { "<id:4>": "2999-01-01T00:00:00.000Z" } },
  { op: "use", key: "<key:4>" },
  { op: "list" },
];

// Accepts only a real UTC instant in the `toISOString` form both servers write.
const generatedTime = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString() === value;

// Mirrored by `Tokens` in rust/crates/pp-api/tests/auth_key_parity.rs.
class Tokens {
  ids = new Map();
  keys = new Map();
  times = new Map();
  raw(value) {
    for (const map of [this.ids, this.keys]) {
      for (const [raw, token] of map) if (token === value) return raw;
    }
    return value;
  }
  issue(body) {
    this.ids.set(body.id, `<id:${this.ids.size + 1}>`);
    this.keys.set(body.key, `<key:${this.keys.size + 1}>`);
  }
  // Runs on raw output: an issued key may appear only as the `key` field of
  // the response that created it.
  leaked(issuedNow, result) {
    const text = JSON.stringify(issuedNow ? { ...result, body: { ...result.body, key: null } } : result);
    return [...this.keys.keys()].some((key) => text.includes(key));
  }
  normalize(value) {
    if (typeof value === "string") return this.ids.get(value) ?? this.keys.get(value) ?? value;
    if (Array.isArray(value)) return value.map((item) => this.normalize(item));
    if (value === null || typeof value !== "object") return value;
    const result = Object.fromEntries(Object.entries(value).map(([name, item]) => [name, this.normalize(item)]));
    for (const field of ["createdAt", "lastUsedAt"]) {
      if (!generatedTime(value[field]) || !this.ids.has(value.id)) continue;
      const slot = `${this.ids.get(value.id).slice(1, -1)}.${field}`;
      const seen = this.times.get(slot) ?? [];
      if (!seen.includes(value[field])) seen.push(value[field]);
      this.times.set(slot, seen);
      result[field] = `<${slot}#${seen.indexOf(value[field]) + 1}>`;
    }
    return result;
  }
}

async function probe() {
  const require = createRequire(join(server, "package.json"));
  const { default: Fastify } = await import(pathToFileURL(require.resolve("fastify")).href);
  const load = (path) => import(pathToFileURL(join(server, path)).href);
  const { getDb, SqliteDatabase } = await load("src/db/client.ts");
  const { AppRepository } = await load("src/db/repository.ts");
  const { registerApiKeyManagementRoutes } = await load("src/routes/api-key-management.ts");
  const { validateApiKey } = await load("src/services/api-key-manager.ts");

  const directory = mkdtempSync(join(tmpdir(), "pp-auth-key-parity-"));
  const open = () => {
    const sqlite = new SqliteDatabase(directory);
    sqlite.connect();
    return { sqlite, repo: new AppRepository(getDb(sqlite), "default", sqlite.reposDir) };
  };
  let store = open();
  const deps = { get repo() { return store.repo; } };
  const app = Fastify();
  await registerApiKeyManagementRoutes(app, deps);
  const tokens = new Tokens();
  const http = async (method, url) => {
    const response = await app.inject({ method, url });
    return { status: response.statusCode, body: response.json() };
  };
  const results = [];
  try {
    for (const step of steps) {
      let result;
      if (step.op === "list") result = await http("GET", "/settings/api-keys");
      if (step.op === "create") result = await http("POST", "/settings/api-keys");
      if (step.op === "revoke") result = await http("DELETE", `/settings/api-keys/${tokens.raw(step.id)}`);
      if (step.op === "rotate") result = await http("POST", `/settings/api-keys/${tokens.raw(step.id)}/regenerate`);
      const issuedNow = (step.op === "create" || step.op === "rotate") && result.status === 201;
      if (issuedNow) tokens.issue(result.body);
      if (step.op === "use") result = { accepted: validateApiKey(deps.repo, tokens.raw(step.key)) };
      if (step.op === "reopen") {
        store.sqlite.close();
        store = open();
        const stored = JSON.parse(store.repo.getSetting("api_keys_v1"));
        for (const [id, expiresAt] of Object.entries(step.expire)) {
          stored.find((key) => key.id === tokens.raw(id)).expiresAt = expiresAt;
        }
        store.repo.setSetting("api_keys_v1", JSON.stringify(stored));
        store.sqlite.close();
        store = open();
        result = {};
      }
      if (tokens.leaked(issuedNow, result) || /"<(?:id|key):[^"]*>"/.test(JSON.stringify(result))) {
        throw new Error(`Node step ${results.length} leaks a key or carries a token`);
      }
      results.push(tokens.normalize(result));
    }
  } finally {
    await app.close();
    store.sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
  return results;
}

if (process.argv.includes("--probe")) {
  process.stdout.write(JSON.stringify(await probe()));
} else {
  const probed = execFileSync(process.execPath, [
    "--conditions=development", "--import", pathToFileURL(join(root, "web/node_modules/tsx/dist/loader.mjs")).href,
    fileURLToPath(import.meta.url), "--probe",
  ], { cwd: server, encoding: "utf8" });
  const results = JSON.parse(probed);
  const header = JSON.stringify({ generated: "@generated by fixtures/parity/auth-key/generate.mjs. Do not edit.", sources });
  const text = `${header.slice(0, -1)},\n"steps":[\n${steps
    .map((step, index) => JSON.stringify({ ...step, node: results[index] }))
    .join(",\n")}\n]}\n`;
  if (/ppk_[0-9a-f]{64}|key_(?!0{16})[0-9a-f]{16}|\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z(?<!(2000|2999)-01-01T00:00:00\.000Z)/.test(text)) {
    throw new Error("node.json would store a generated secret, ID or time");
  }
  if (process.argv.includes("--check")) {
    if (readFileSync(output, "utf8") !== text) throw new Error("node.json is out of date");
  } else {
    writeFileSync(output, text);
  }
}
