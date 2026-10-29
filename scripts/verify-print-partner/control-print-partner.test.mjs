import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const run = promisify(execFile);
const helper = new URL("./control-print-partner.mjs", import.meta.url);

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function instance(t) {
  const root = mkdtempSync(join(tmpdir(), "pp-control-test-"));
  const stateDir = join(root, "state");
  const evidenceDir = join(root, "evidence");
  const env = { ...process.env, PP_VERIFY_STATE_DIR: stateDir };
  const control = async (...args) => {
    const { stdout } = await run(process.execPath, [helper.pathname, ...args], {
      env,
      timeout: 210_000,
      maxBuffer: 1024 * 1024,
    });
    return JSON.parse(stdout);
  };
  t.after(async () => {
    try {
      await control("cleanup");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  return { root, stateDir, evidenceDir, control };
}

test("npm verification serves its advertised IPv4 URL and cleans up only its run", async (t) => {
  const { stateDir, evidenceDir, control } = instance(t);

  const unrelated = createServer();
  await new Promise((resolve, reject) => {
    unrelated.once("error", reject);
    unrelated.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => unrelated.close(resolve)));
  const apiPort = await freePort();
  let uiPort = await freePort();
  while (uiPort === apiPort) uiPort = await freePort();

  const launch = await control(
    "launch", "--mode", "npm",
    "--api-port", String(apiPort), "--ui-port", String(uiPort),
    "--evidence-dir", evidenceDir,
  );
  assert.equal(launch.baseUrl, `http://127.0.0.1:${uiPort}`);
  assert.equal(launch.healthUrl, `http://127.0.0.1:${apiPort}`);

  const doctor = await control("doctor");
  assert.equal(doctor.doctor, "pass");
  assert.equal(doctor.checks.uiReachable, true);
  const page = await fetch(launch.baseUrl, { signal: AbortSignal.timeout(5000) });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<div id="root"><\/div>/);
  for (const url of [launch.healthUrl, launch.baseUrl]) {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
    const health = await response.json();
    assert.equal(health.ok, true);
    assert.equal(health.data_dir, launch.dataDir);
    assert.equal(health.port, apiPort);
  }
  const log = readFileSync(launch.logPath, "utf8");
  assert.match(log, /@print-partner\/contracts@[^\n]+ build/);
  assert.match(log, /@print-partner\/domain@[^\n]+ build/);

  const cleanup = await control("cleanup");
  assert.equal(cleanup.cleaned, true);
  assert.equal(cleanup.evidenceRetained, true);
  assert.equal(existsSync(launch.dataDir), false);
  assert.equal(existsSync(join(stateDir, "state.json")), false);
  assert.equal(existsSync(evidenceDir), true);
  assert.equal(unrelated.listening, true);
  for (const url of [launch.healthUrl, launch.baseUrl]) {
    await assert.rejects(fetch(url, { signal: AbortSignal.timeout(2000) }));
  }
});

test("npm launch rejects an occupied UI port owned by another healthy instance", async (t) => {
  const { root, stateDir, evidenceDir, control } = instance(t);
  const otherDataDir = join(root, "other-data");
  mkdirSync(otherDataDir);
  const other = createHttpServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ ok: true, data_dir: otherDataDir, port: other.address().port }));
  });
  await new Promise((resolve, reject) => {
    other.once("error", reject);
    other.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => other.close(resolve)));
  const uiPort = other.address().port;
  const apiPort = await freePort();
  let failure;
  await assert.rejects(
    control(
      "launch", "--mode", "npm",
      "--api-port", String(apiPort), "--ui-port", String(uiPort),
      "--evidence-dir", evidenceDir,
    ).then((launch) => {
      console.log(JSON.stringify({ unexpectedLaunch: launch }));
      return launch;
    }),
    (error) => {
      assert.equal(error.code, 1);
      failure = JSON.parse(error.stdout);
      assert.match(failure.error, /another instance/);
      return true;
    },
  );
  assert.equal(existsSync(join(stateDir, "state.json")), false);
  assert.equal(existsSync(evidenceDir), true);
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      process.kill(-failure.pid, 0);
    } catch (error) {
      assert.equal(error.code, "ESRCH");
      break;
    }
    await delay(50);
  }
  assert.throws(() => process.kill(-failure.pid, 0), { code: "ESRCH" });
  await assert.rejects(fetch(`http://127.0.0.1:${apiPort}/health`, {
    signal: AbortSignal.timeout(2000),
  }));
  const response = await fetch(`http://127.0.0.1:${uiPort}/health`, {
    signal: AbortSignal.timeout(2000),
  });
  assert.deepEqual(await response.json(), { ok: true, data_dir: otherDataDir, port: uiPort });
});
