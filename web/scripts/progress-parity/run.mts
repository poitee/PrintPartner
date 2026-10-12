import assert from "node:assert/strict";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mock } from "node:test";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Fastify from "fastify";
import { parseReconcilePlanDraftRequest } from "@print-partner/contracts";
import * as schema from "../../apps/server/src/db/schema.js";
import { SqliteDatabase } from "../../apps/server/src/db/client.js";
import { AppRepository } from "../../apps/server/src/db/repository.js";
import { PlanDraftWorkspaceService } from "../../apps/server/src/services/plan-draft-workspace.js";
import { registerPartRoutes } from "../../apps/server/src/routes/parts.js";
import { registerPlanDraftRoutes } from "../../apps/server/src/routes/plan-drafts.js";
import { canonical, digest, json, object, type Json } from "../desktop-parity/model.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixtures = join(repo, "rust/crates/pp-storage/tests/fixtures");
const target = process.env.CARGO_TARGET_DIR;
assert(target, "CARGO_TARGET_DIR must identify the owned target directory");
const binaryDirectory = join(target, "debug");
const runtime = object(json(JSON.parse(readFileSync(new URL("./runtime.json", import.meta.url), "utf8"))));
assert.equal(process.version, runtime.version, "Use the pinned Node22.23.3 runtime");
assert.equal(process.platform, runtime.platform); assert.equal(process.arch, runtime.arch);
assert.equal(digest(readFileSync(process.execPath)), runtime.executableSha256, "Pinned official Linux x64 Node binary hash");
const output = resolve(process.argv[2] ?? "progress-parity-receipts");
mkdirSync(output, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "pp-current-progress-parity-"));

function command(binary: string, args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(join(binaryDirectory, binary), args, {
    encoding: "utf8", env: { ...process.env, ...env }, timeout: 30_000,
  });
  assert.equal(result.status, 0, `${binary}: ${result.stderr}`);
  const receipt = object(json(JSON.parse(result.stdout)));
  assert.equal(receipt.writer_opens, binary === "progress-parity-prepare" ? 1 : 2, `${binary}: measured lifecycle opens`);
  return receipt;
}
function graph(directory: string): Json {
  const db = new Database(join(directory, "print-partner.db"), { readonly: true });
  try {
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    return Object.fromEntries(names.map((entry) => {
      const { name } = object(json(entry));
      assert(typeof name === "string" && /^[a-zA-Z0-9_]+$/.test(name));
      const columns = db.prepare(`PRAGMA table_info("${name}")`).all().map((entry) => object(json(entry)));
      const pk = columns.filter((c) => typeof c.pk === "number" && c.pk > 0).sort((a, b) => Number(a.pk) - Number(b.pk));
      const order = (pk.length ? pk : columns).map((c) => `"${c.name}"`).join(",");
      const rows = db.prepare(`SELECT * FROM "${name}" ORDER BY ${order}`).safeIntegers().all().map((entry) => object(sqliteValue(entry)));
      return [name, rows];
    }));
  } finally { db.close(); }
}
function sqliteValue(value: unknown): Json {
  if (typeof value === "bigint") return { sqlite_integer: value.toString() };
  if (Buffer.isBuffer(value)) return { sqlite_blob_hex: value.toString("hex") };
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sqliteValue(item)]));
  return json(value);
}
function files(directory: string): Json {
  const base = join(directory, "repos");
  function walk(path: string): Json[] {
    return readdirSync(path).sort().flatMap((name) => {
      const full = join(path, name);
      return statSync(full).isDirectory() ? walk(full) : [{ path: relative(base, full), sha256: digest(readFileSync(full)) }];
    });
  }
  return walk(base);
}
function open(directory: string) {
  const raw = new Database(join(directory, "print-partner.db"));
  raw.pragma("foreign_keys=ON");
  return { raw, repository: new AppRepository(drizzle(raw, { schema }), "default", join(directory, "repos")) };
}
function equal(left: Json, right: Json, name: string) {
  if (Array.isArray(left)) {
    assert(Array.isArray(right), `${name}: expected array`);
    assert.equal(left.length, right.length, `${name}: length`);
    left.forEach((value, index) => equal(value, right[index], `${name}[${index}]`));
  } else if (left !== null && typeof left === "object") {
    const actual = object(right);
    assert.deepEqual(Object.keys(left).sort(), Object.keys(actual).sort(), `${name}: keys`);
    for (const [key, value] of Object.entries(left)) equal(value, actual[key], `${name}.${key}`);
  } else assert.equal(left, right, name);
}
function seed(name: string) {
  const prepared = join(root, `${name}-prepared`);
  mkdirSync(join(prepared, "repos"), { recursive: true });
  cpSync(join(fixtures, `${name}.db`), join(prepared, "print-partner.db"));
  if (name === "checkoff-progress/node") cpSync(join(fixtures, "checkoff-progress/repos"), join(prepared, "repos"), { recursive: true });
  assert.equal(command("progress-parity-prepare", [prepared]).schema, 35);
  return prepared;
}
const records: Json[] = [];
function coverage(cases: Json[]) {
  assert.equal(cases.length, 29, "Current corpus requires all29 distinct cases");
  assert.equal(cases.filter((r) => object(r).family === "required").length, 12);
  assert.equal(cases.filter((r) => object(r).family === "progress").length, 17);
  assert.equal(new Set(cases.map((r) => object(r).id)).size, 29);
}
function forks(prepared: string, id: string) {
  const node = join(root, `${id}-node`), rust = join(root, `${id}-rust`);
  cpSync(prepared, node, { recursive: true }); cpSync(prepared, rust, { recursive: true });
  return { node, rust };
}

try {
  const precision = join(root, "precision-control"); mkdirSync(precision);
  const precisionDb = new Database(join(precision, "print-partner.db"));
  precisionDb.exec("CREATE TABLE precise(value INTEGER, bytes BLOB); INSERT INTO precise VALUES(9223372036854775806,X'00ff'),(9223372036854775807,X'ff00')"); precisionDb.close();
  const preciseRows = object(graph(precision)).precise; assert(Array.isArray(preciseRows));
  assert.notDeepEqual(object(preciseRows[0]).value, object(preciseRows[1]).value, "Full-state comparator must retain adjacent SQLite i64 values");
  assert.deepEqual(object(preciseRows[0]).bytes, { sqlite_blob_hex: "00ff" });
  if (process.argv[3] === "--startup-control") {
    const prepared = seed("required-units/unchanged");
    const { node, rust } = forks(prepared, "startup-control");
    const request = join(root, "startup-control.json");
    const fixture = object(json(JSON.parse(readFileSync(join(fixtures, "required-units/unchanged.json"), "utf8"))));
    writeFileSync(request, canonical(fixture.request));
    const result = command("required-unit-fixture", [rust, "999999", "2", "startup-control", request], { PP_RECONCILIATION_SESSION: "required-unit-fixture-secret" });
    assert.equal(object(result.first).kind, "profile_not_found");
    for (let i = 0; i < 2; i++) {
      const connection = open(node);
      assert.equal(connection.repository.getOwnedProfileIdentity(999999), null);
      connection.raw.close();
    }
    writeFileSync(join(output, "startup-mismatch.json"), JSON.stringify({ node: graph(node), rust: graph(rust), rustWriterOpens: 2, rawNodeConnections: 2, nodePublicStartup: "not executed: schema35 is unsupported" }, null, 2));
    equal(graph(node), graph(rust), "original startup metadata parity control");
    throw new Error("Startup mismatch control unexpectedly passed");
  }
  for (const seedName of ["unchanged", "shrink", "unsafe"]) {
    const prepared = seed(`required-units/${seedName}`);
    const fixture = object(json(JSON.parse(readFileSync(join(fixtures, `required-units/${seedName}.json`), "utf8"))));
    for (const variant of ["selection", "stale", "missing-profile", "missing-draft"]) {
      const id = `required-${seedName}-${variant}`;
      const { node, rust } = forks(prepared, id);
      const input = object(structuredClone(fixture.request));
      if (variant === "stale") input.expected_snapshot_digest = "0".repeat(64);
      const profile = variant === "missing-profile" ? 999999 : Number(fixture.profile);
      const draft = variant === "missing-draft" ? 999999 : Number(fixture.draft);
      const request = join(root, `${id}.json`); writeFileSync(request, canonical(input));
      const started = Date.now();
      const result = command("required-unit-fixture", [rust, String(profile), String(draft), id, request], { PP_RECONCILIATION_SESSION: "required-unit-fixture-secret" });
      const finished = Date.now();
      const db = new Database(join(rust, "print-partner.db"), { readonly: true });
      const created = object(json(db.prepare("SELECT created_at FROM plan_draft_required_unit_reconciliations WHERE idempotency_key=?").get(id) ?? {})).created_at;
      db.close();
      if (typeof created === "string") {
        const clock = Date.parse(created);
        assert(clock >= started - 1000 && clock <= finished + 1000, "Rust mutation timestamp outside observed run");
        mock.timers.enable({ apis: ["Date"], now: clock });
      }
      let nodeWriterOpens = Number(command("progress-parity-prepare", [node]).writer_opens);
      let connection = open(node);
      const invoke = () => new PlanDraftWorkspaceService(connection.repository).reconcile({ profileId: profile, draftId: draft, actorId: "default", idempotencyKey: id, request: parseReconcilePlanDraftRequest(input) });
      const first = json(invoke()); connection.raw.close();
      nodeWriterOpens += Number(command("progress-parity-prepare", [node]).writer_opens);
      connection = open(node); const restart = json(invoke()); connection.raw.close();
      mock.timers.reset();
      assert.equal(object(first).kind, variant === "selection" ? "ready" : variant === "stale" ? "draft_changed" : variant === "missing-profile" ? "profile_not_found" : "draft_not_found");
      equal(first, result.first, `${id}: first response`); equal(restart, result.restart, `${id}: restarted response`);
      equal(graph(node), graph(rust), `${id}: entire ordered database`); equal(files(node), files(rust), `${id}: files`);
      assert.equal(nodeWriterOpens, result.writer_opens, `${id}: target lifecycle count`);
      records.push({ id, family: "required", first, restart, writerOpens: { nodeFixtureTarget: nodeWriterOpens, rust: result.writer_opens }, database: graph(node), files: files(node) });
    }
  }
  const prepared = seed("checkoff-progress/node");
  const startup = new SqliteDatabase(prepared);
  let startupRefusal: Json = null;
  try { startup.connect(); }
  catch (error) {
    assert(error instanceof Error);
    assert.match(error.message, /schema|version|newer|upgrade/i);
    startupRefusal = { name: error.name, message: error.message };
  }
  assert(startupRefusal !== null, "Node public startup must reject unsupported schema35");
  const identity = object(json(JSON.parse(readFileSync(join(fixtures, "checkoff-progress/identity.json"), "utf8"))));
  const basis = object(identity.basis);
  const rows = identity.parts; assert(Array.isArray(rows));
  const part = rows.map(object).find((p) => p.included === true); assert(part);
  const partId = Number(part.projectionPartId);
  type ProgressCase = { id: string; status: number } & (
    | { operation: "import"; request: { expected: { [key: string]: Json }; rows: { part_id: number; printed_count: number }[] } }
    | { operation: "completion_coordinate" | "assembly_coordinate"; part_id: number; body: { [key: string]: Json } }
  );
  const progressCases: ProgressCase[] = [
    { id: "complete-first", operation: "completion_coordinate", part_id: partId, body: { unit_index: 0, completed: true }, status: 200 },
    { id: "complete-third", operation: "completion_coordinate", part_id: partId, body: { unit_index: 2, completed: true }, status: 200 },
    { id: "uncomplete", operation: "completion_coordinate", part_id: partId, body: { unit_index: 0, completed: false }, status: 200 },
    { id: "complete-range", operation: "completion_coordinate", part_id: partId, body: { unit_index: 4, completed: true }, status: 400 },
    { id: "complete-missing", operation: "completion_coordinate", part_id: 999999, body: { unit_index: 0, completed: true }, status: 404 },
    { id: "complete-type", operation: "completion_coordinate", part_id: partId, body: { unit_index: 0, completed: "true" }, status: 400 },
    { id: "assemble-incomplete", operation: "assembly_coordinate", part_id: partId, body: { unit_index: 0, assembled: true }, status: 200 },
    { id: "unassemble", operation: "assembly_coordinate", part_id: partId, body: { unit_index: 0, assembled: false }, status: 200 },
    { id: "assembly-range", operation: "assembly_coordinate", part_id: partId, body: { unit_index: 4, assembled: true }, status: 400 },
    { id: "assembly-type", operation: "assembly_coordinate", part_id: partId, body: { unit_index: 0, assembled: 1 }, status: 400 },
    ...[0, 1, 4, 5].map((count): ProgressCase => ({ id: `import-${count}`, operation: "import", request: { expected: basis, rows: [{ part_id: partId, printed_count: count }] }, status: count <= 4 ? 200 : 422 })),
    { id: "import-missing-last", operation: "import", request: { expected: basis, rows: [{ part_id: partId, printed_count: 1 }, { part_id: 999999, printed_count: 1 }] }, status: 404 },
    { id: "import-stale", operation: "import", request: { expected: { ...basis, plan_version: Number(basis.plan_version) + 1 }, rows: [{ part_id: partId, printed_count: 1 }] }, status: 409 },
    { id: "import-late-rollback", operation: "import", request: { expected: basis, rows: [{ part_id: partId, printed_count: 3 }] }, status: 500 },
  ];
  for (const scenario of progressCases) {
    const { id, status, ...requestBody } = scenario;
    const { node, rust } = forks(prepared, id);
    if (id === "import-late-rollback") {
      for (const directory of [node, rust]) {
        const db = new Database(join(directory, "print-partner.db"));
        db.exec(`CREATE TRIGGER parity_late_failure BEFORE UPDATE ON print_progress WHEN NEW.part_id=${partId} AND NEW.unit_index=2 BEGIN SELECT RAISE(ABORT,'parity late failure'); END`); db.close();
      }
    }
    let nodeWriterOpens = Number(command("progress-parity-prepare", [node]).writer_opens);
    const before = graph(node);
    const prelude: Json[] = id === "uncomplete"
      ? [{ operation: "completion_coordinate", part_id: partId, body: { unit_index: 2, completed: true } }]
      : id === "unassemble"
        ? [{ operation: "completion_coordinate", part_id: partId, body: { unit_index: 0, completed: true } }, { operation: "assembly_coordinate", part_id: partId, body: { unit_index: 0, assembled: true } }]
        : [];
    const requests = [...prelude, json(requestBody), json(requestBody)];
    const input = join(root, `${id}.json`); writeFileSync(input, JSON.stringify({ profiles: [1], requests }));
    const result = command("checkoff-progress-fixture", [rust, input], { PP_CHECKOFF_CREDENTIAL: "read-fixture-secret" });
    const connection = open(node); const app = Fastify();
    await registerPartRoutes(app, { repo: connection.repository, reposDir: join(node, "repos"), thumbsDir: join(node, "thumbs") });
    await registerPlanDraftRoutes(app, { repo: connection.repository, reposDir: join(node, "repos"), thumbsDir: join(node, "thumbs"), dataDir: node });
    const nodeResults: Json[] = [];
    for (const [index, value] of requests.entries()) {
      const request = object(value);
      const response = await app.inject(request.operation === "import"
        ? { method: "POST", url: "/plans/1/progress/import", payload: object(request.request) }
        : { method: "PATCH", url: `/parts/${request.part_id}/${request.operation === "completion_coordinate" ? "progress" : "assembled"}`, payload: object(request.body) });
      assert.equal(response.statusCode, index < prelude.length ? 200 : status, `${id}: expected status`);
      nodeResults.push({ status: response.statusCode, body: json(response.json()) });
    }
    if (id === "uncomplete") {
      assert.equal(object(object(nodeResults[0]).body).printed_count, 3);
      assert.equal(object(object(nodeResults[1]).body).printed_count, 0);
    }
    if (id === "unassemble") {
      assert.equal(object(object(nodeResults[1]).body).assembled_count, 1);
      assert.equal(object(object(nodeResults[2]).body).assembled_count, 0);
    }
    await app.close(); connection.raw.close();
    const domainAfter = graph(node);
    nodeWriterOpens += Number(command("progress-parity-prepare", [node]).writer_opens);
    const reopened = open(node); reopened.raw.close();
    const rustResults = result.results; assert(Array.isArray(rustResults));
    equal(nodeResults, rustResults.map((r) => object(r).response), `${id}: actual registered-handler responses/replay`);
    equal(graph(node), graph(rust), `${id}: entire ordered database/restart`); equal(files(node), files(rust), `${id}: files`);
    if (status !== 200) equal(before, domainAfter, `${id}: refusal/rollback preserves all tables`);
    assert.equal(nodeWriterOpens, result.writer_opens, `${id}: target lifecycle count`);
    records.push({ id, family: "progress", responses: nodeResults, writerOpens: { nodeFixtureTarget: nodeWriterOpens, rust: result.writer_opens }, database: graph(node), files: files(node) });
  }
  coverage(records);
  const operations = records.reduce<number>((total, record) => {
    const row = object(record);
    if (row.family === "required") return total + 2;
    assert(Array.isArray(row.responses));
    return total + row.responses.length;
  }, 0);
  assert.equal(operations, 61, "Each replay and real completion/assembly precondition must execute");
  const changed = structuredClone(records); object(changed[0]).first = { kind: "fabricated" };
  assert.throws(() => equal(records, changed, "planted response mismatch"));
  const stateDrift = structuredClone(records); object(stateDrift[0]).database = {};
  assert.throws(() => equal(records, stateDrift, "planted database mismatch"));
  const fileDrift = structuredClone(records); object(fileDrift[0]).files = [];
  // Required-unit seed has no local artifacts; use a real completion fixture file graph.
  object(fileDrift[12]).files = [];
  assert.throws(() => equal(records, fileDrift, "planted file mismatch"));
  assert.throws(() => coverage(records.slice(1)), /28/);
  const sourceHashes: Record<string, string> = {};
  function hashTree(path: string) {
    for (const name of readdirSync(path).sort()) {
      const full = join(path, name);
      if (statSync(full).isDirectory()) hashTree(full);
      else sourceHashes[relative(repo, full)] = digest(readFileSync(full));
    }
  }
  for (const path of ["web/apps/server/src", "web/packages/contracts/src", "web/packages/domain/src", "web/scripts/desktop-parity", "web/scripts/progress-parity", "rust/crates/pp-storage/src", "rust/crates/pp-storage/data", "rust/crates/pp-contracts/src", "rust/crates/pp-api-types/src", "rust/crates/pp-storage/tests/fixtures"]) hashTree(join(repo, path));
  for (const path of ["web/package.json", "web/package-lock.json", "web/tsconfig.base.json", "web/packages/contracts/package.json", "web/packages/domain/package.json", "web/apps/server/package.json", "rust-toolchain.toml", "rust/Cargo.toml", "rust/Cargo.lock", "rust/crates/pp-storage/Cargo.toml", "rust/crates/pp-contracts/Cargo.toml", "rust/crates/pp-api-types/Cargo.toml"]) sourceHashes[path] = digest(readFileSync(join(repo, path)));
  const binaryHashes = Object.fromEntries(["progress-parity-prepare", "required-unit-fixture", "checkoff-progress-fixture"].map((name) => [name, digest(readFileSync(join(binaryDirectory, name)))]));
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }); assert.equal(head.status, 0);
  const report = process.report.getReport();
  assert(typeof report === "object" && report !== null && "sharedObjects" in report);
  assert(Array.isArray(report.sharedObjects));
  const sqliteAddonPath = report.sharedObjects.find((path: unknown) => typeof path === "string" && path.includes("/better-sqlite3/") && path.endsWith(".node"));
  assert(typeof sqliteAddonPath === "string", "Receipt must hash the actual loaded SQLite addon");
  const sqliteAddonSha256 = digest(readFileSync(sqliteAddonPath));
  writeFileSync(join(output, "parity.json"), JSON.stringify({ format: "current-required-progress-domain-v1", head: head.stdout.trim(), sourceHashes, binaryHashes, node: process.version, nodeSha256: digest(readFileSync(process.execPath)), sqliteAddonSha256, cases: 29, operations, records, controls: ["response", "database", "files", "case-count"], nodeStartup35: "refused", startupRefusal, clockPolicy: "Only Node Date uses bounded observed Rust creation timestamp; no timestamp excluded", lifecycle: "one shared prepared seed before clone; two real target writer opens per side, first and reopen" }, null, 2));
  process.stdout.write("PASS: 12 current Required-unit cases,17 current registered-handler cases;61 paired operations including clearing preconditions; restart/state/file parity and4 drift controls\n");
} finally { mock.timers.reset(); rmSync(root, { recursive: true, force: true }); }
