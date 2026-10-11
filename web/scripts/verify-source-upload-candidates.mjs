import assert from "node:assert/strict";
import { Buffer, Blob } from "node:buffer";
import console from "node:console";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { chmodSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, writeFile, lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { zipSync, strToU8 } from "fflate";
import { encodeAcceptedPlate3mf } from "@print-partner/domain";
import { startServer } from "../apps/server/dist/current/app.js";
import { loadConfig } from "../apps/server/dist/current/config.js";

import { measureTenantDiskUsage, runWithTenantDiskQuota, chargeTenantDiskBytes } from "../apps/server/dist/current/lib/tenant-disk-quota.js";

const { fetch, FormData } = globalThis;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const evidence = resolve(process.argv[2] ?? join(root, ".gre288-evidence", "http"));
await mkdir(evidence, { recursive: true });
const dataDir = await mkdtemp(join(evidence, "data-"));
const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const trackedChanges = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root, encoding: "utf8" });
assert.equal(trackedChanges, "", "commit tracked changes before collecting SHA-specific evidence");
const transcript = [];
function record(event, details) {
  const line = JSON.stringify({ event, ...details });
  transcript.push(line);
  console.log(line);
}
const { app, ports } = await startServer({ ...loadConfig(), dataDir, host: "127.0.0.1", port: 0 });
const address = app.server.address();
assert(address && typeof address === "object");
const base = `http://127.0.0.1:${address.port}`;
async function json(path, init) {
  const response = await fetch(base + path, init);
  return { status: response.status, body: await response.json() };
}
function fileBody(files) {
  const form = new FormData();
  form.set("relative_paths", JSON.stringify(files.map(([name]) => name)));
  for (const [name, bytes] of files) form.append("files", new Blob([bytes]), name.split("/").pop());
  return form;
}
function zipBody(bytes) {
  const form = new FormData();
  form.set("file", new Blob([bytes]), "upload.zip");
  return form;
}
async function digestTree(path) {
  const result = {};
  for (const name of (await readdir(path, { recursive: true, withFileTypes: true }))) {
    if (name.isFile()) {
      const full = join(name.parentPath, name.name);
      result[full.slice(path.length + 1)] = createHash("sha256").update(await readFile(full)).digest("hex");
    }
  }
  return result;
}
try {
  record("runtime", { sha, base, dataDir, health: (await json("/health")).status });
  const created = await json("/sources", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "GRE-288 real HTTP", source_kind: "local" }) });
  assert.equal(created.status, 200);
  const id = created.body.id;
  const sourceUrl = `/sources/${id}`;
  const initial = await json(`${sourceUrl}/upload-files`, { method: "POST", body: fileBody([["keep.stl", "previous STL"]]) });
  assert.equal(initial.status, 200);
  const priorPath = initial.body.local_path;
  const legacyPath = join(dataDir, "sources", String(id));
  await mkdir(join(legacyPath, "files"), { recursive: true });
  await writeFile(join(legacyPath, "files", "keep.stl"), "legacy working STL");
  await writeFile(join(legacyPath, "upload.zip"), "legacy ZIP bytes");
  const before = { active: await digestTree(priorPath), legacy: await digestTree(legacyPath), rules: (await json(`${sourceUrl}/import-rules`)).body };
  const validZip = zipSync({ "new.stl": strToU8("candidate STL") });
  const attempts = [
    ["invalid ZIP", "upload-zip", zipBody(strToU8("not-a-zip"))],
    ["truncated ZIP", "upload-zip", zipBody(validZip.subarray(0, validZip.length - 10))],
    ["unsafe path", "upload-files", fileBody([["../escape.stl", "escape"]])],
    ["invalid nested 3MF", "upload-zip", zipBody(zipSync({ "nested/broken.3mf": strToU8("not-a-3mf") }))],
  ];
  for (const [name, endpoint, body] of attempts) {
    const rejected = await json(`${sourceUrl}/${endpoint}`, { method: "POST", body });
    assert.equal(rejected.status, 400);
    assert.equal((await json(sourceUrl)).body.local_path, priorPath);
    assert.deepEqual(await digestTree(priorPath), before.active);
    assert.deepEqual(await digestTree(legacyPath), before.legacy);
    assert.deepEqual((await json(`${sourceUrl}/import-rules`)).body, before.rules);
    record("rejected upload preserves bytes", { name, status: rejected.status, detail: rejected.body.detail, active: before.active, legacy: before.legacy });
  }
  const threeMf = encodeAcceptedPlate3mf([{ token: "clip", objectName: "Clip", xUm: 0, yUm: 0, mesh: {
    vertices: [[0, 0, 0], [10, 0, 0], [0, 5, 0]], faces: [[0, 1, 2]],
    bounds: { minX: 0, minY: 0, minZ: 0, maxX: 10, maxY: 5, maxZ: 0, widthMm: 10, depthMm: 5, heightMm: 0 },
  } }]);
  const nested = await json(`${sourceUrl}/upload-zip`, { method: "POST", body: zipBody(zipSync({ "models/assembly.3mf": threeMf, "notes.txt": strToU8("complete candidate") })) });
  assert.equal(nested.status, 200);
  assert.equal(nested.body.stl_count, 1);
  assert.equal(await readFile(join(nested.body.local_path, "notes.txt"), "utf8"), "complete candidate");
  assert.match(await readFile(join(nested.body.local_path, "_3mf/assembly/clip.stl"), "utf8"), /solid/);
  record("valid nested 3MF", { status: nested.status, stlCount: nested.body.stl_count, files: await digestTree(nested.body.local_path) });

  const boundary = "gre288-slow-upload";
  const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="relative_paths"\r\n\r\n["loser.stl"]\r\n--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="loser.stl"\r\nContent-Type: application/octet-stream\r\n\r\nlosing bytes`);
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  const pending = request(`${base}${sourceUrl}/upload-files`, { method: "POST", headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": prefix.length + suffix.length } });
  const response = new Promise((resolve, reject) => {
    pending.on("response", (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    pending.on("error", reject);
  });
  pending.write(prefix);
  let observed = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const names = await readdir(join(dataDir, "sources"));
    if (names.some((name) => name.startsWith(".upload-"))) { observed = true; break; }
    await delay(10);
  }
  assert(observed, "slow request must enter upload staging before the winner starts");
  const winner = await json(`${sourceUrl}/upload-files`, { method: "POST", body: fileBody([["winner.stl", "winning bytes"], ["winner.txt", "complete winner"]]) });
  pending.end(suffix);
  const loser = await response;
  assert.equal(winner.status, 200);
  assert.equal(loser.status, 409);
  const current = (await json(sourceUrl)).body;
  assert.equal(current.local_path, winner.body.local_path);
  assert.deepEqual((await readdir(current.local_path)).sort(), [".printpartner-source-snapshot.json", "winner.stl", "winner.txt"]);
  assert.equal(await readFile(join(current.local_path, "winner.stl"), "utf8"), "winning bytes");
  assert.deepEqual(await digestTree(legacyPath), before.legacy);
  record("concurrent upload", { winnerStatus: winner.status, loserStatus: loser.status, loserDetail: loser.body.detail, revision: current.current_source_revision_id, files: await digestTree(current.local_path) });
  const repo = ports.repository;
  assert(repo);
  const currentBeforeFailure = (await json(sourceUrl)).body;
  await json(`${sourceUrl}/import-rules`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ rules: [] }),
  });
  const updateRules = repo.updateImportRules;
  repo.updateImportRules = () => { throw new Error("forced rule-write failure after activation"); };
  const failedPublication = await json(`${sourceUrl}/upload-files`, {
    method: "POST", body: fileBody([["rollback.stl", "must not publish"]]),
  });
  repo.updateImportRules = updateRules;
  assert.equal(failedPublication.status, 400);
  assert.equal((await json(sourceUrl)).body.current_source_revision_id, currentBeforeFailure.current_source_revision_id);
  assert.equal((await json(sourceUrl)).body.local_path, currentBeforeFailure.local_path);
  assert.deepEqual((await json(`${sourceUrl}/import-rules`)).body.rules, []);
  record("late SQLite failure rolls back publication", { status: failedPublication.status, detail: failedPublication.body.detail, revision: currentBeforeFailure.current_source_revision_id });

  const sourcesRoot = join(dataDir, "sources");
  const activate = repo.activateSourceRevision;
  const protectedStaging = [];
  repo.activateSourceRevision = function(input) {
    const result = activate.call(this, input);
    for (const name of readdirSync(sourcesRoot).filter((name) => name.startsWith(".upload-"))) {
      const path = join(sourcesRoot, name);
      chmodSync(path, 0o500);
      protectedStaging.push(path);
    }
    return result;
  };
  let retained;
  try {
    retained = await json(`${sourceUrl}/upload-files`, {
      method: "POST", body: fileBody([["retained.stl", "published despite cleanup failure"]]),
    });
    assert.equal(retained.status, 200);
    assert.equal((await json(sourceUrl)).body.local_path, retained.body.local_path);
    assert.equal(await readFile(join(retained.body.local_path, "retained.stl"), "utf8"), "published despite cleanup failure");
    assert.equal(protectedStaging.length, 1);
    const stagedFiles = await readdir(protectedStaging[0], { recursive: true, withFileTypes: true });
    let retainedBytes = 0;
    for (const file of stagedFiles) {
      if (file.isFile()) retainedBytes += (await lstat(join(file.parentPath, file.name))).size;
    }
    assert(retainedBytes > 0, "a real permission failure must retain upload bytes");
    const quotaInput = { dataDir, reposDir: join(dataDir, "repos"), tenantId: "default", sourceIds: [] };
    assert.equal(await measureTenantDiskUsage(quotaInput), retainedBytes);
    assert.equal(await measureTenantDiskUsage({ ...quotaInput, tenantId: "other" }), 0);
    await assert.rejects(runWithTenantDiskQuota({
      ...quotaInput, sourceIds: () => [], quotaBytes: retainedBytes,
    }, async () => chargeTenantDiskBytes(1)), /disk quota/);
    record("cleanup permission failure retains success and charges quota", {
      status: retained.status, retainedBytes, staging: protectedStaging[0], otherTenantBytes: 0,
    });
  } finally {
    repo.activateSourceRevision = activate;
    for (const path of protectedStaging) chmodSync(path, 0o700);
  }
  assert.deepEqual(await digestTree(priorPath), before.active);
  assert.deepEqual(await digestTree(legacyPath), before.legacy);
  record("PASS", { sha, criteria: "malformed/truncated ZIP, unsafe path, nested 3MF, byte preservation, complete concurrent winner, stale writer 409, SQLite late-error rollback, real cleanup permission failure, tenant staging quota" });
} finally {
  await app.close();
  await ports.db.close();
  await writeFile(join(evidence, "transcript.jsonl"), transcript.join("\n") + "\n");
}
