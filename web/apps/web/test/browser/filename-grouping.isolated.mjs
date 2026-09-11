import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";

const listener = createServer();
await new Promise((resolve, reject) => {
  listener.once("error", reject);
  listener.listen(0, "127.0.0.1", resolve);
});
const address = listener.address();
assert.ok(address && typeof address === "object");
await new Promise((resolve) => listener.close(resolve));
const data = await mkdtemp("/tmp/pp-filename-groups-ci-");
const base = `http://127.0.0.1:${address.port}`;
const server = spawn(process.execPath, [fileURLToPath(new URL("../../../server/dist/current/index.js", import.meta.url))], {
  env: { PATH: process.env.PATH, DEPLOY_MODE: "self-host", HOST: "127.0.0.1", PORT: String(address.port), PRINT_PARTNER_DATA_DIR: data,
    PRINT_PARTNER_API_KEY: "", STATIC_DIR: fileURLToPath(new URL("../../dist", import.meta.url)) },
  stdio: ["ignore", "pipe", "pipe"],
});
let diagnostics = "";
server.stdout.on("data", (chunk) => { diagnostics = (diagnostics + chunk).slice(-10000); });
server.stderr.on("data", (chunk) => { diagnostics = (diagnostics + chunk).slice(-10000); });
const exited = new Promise((resolve) => server.once("exit", resolve));
try {
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (server.exitCode !== null || server.signalCode !== null) throw new Error(diagnostics);
    try {
      const response = await globalThis.fetch(`${base}/health`);
      if (response.ok) { ready = true; break; }
    } catch { /* Startup has not opened the listener yet. */ }
    await delay(250);
  }
  assert.ok(ready, `Isolated API did not start: ${diagnostics}`);
  const check = spawn(process.execPath, [fileURLToPath(new URL("./filename-grouping.browser.mjs", import.meta.url))], {
    env: { ...process.env, FILENAME_GROUP_API: base, FILENAME_GROUP_UI: base }, stdio: "inherit",
  });
  const code = await new Promise((resolve, reject) => { check.once("error", reject); check.once("exit", resolve); });
  assert.equal(code, 0, "Filename grouping browser journey failed");
} finally {
  if (server.exitCode === null && server.signalCode === null) server.kill("SIGTERM");
  await Promise.race([exited, delay(5000)]);
  if (server.exitCode === null && server.signalCode === null) { server.kill("SIGKILL"); await exited; }
  await rm(data, { recursive: true, force: true });
}
