import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";

const data = await mkdtemp("/tmp/pp-part-colors-ci-");
let base = "";
const server = spawn(process.execPath, [fileURLToPath(new URL("../../../server/dist/current/index.js", import.meta.url))], {
  env: { PATH: process.env.PATH, DEPLOY_MODE: "self-host", HOST: "127.0.0.1", PORT: "0", PRINT_PARTNER_DATA_DIR: data,
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
    base = /Server listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(diagnostics)?.[1] ?? "";
    try {
      if (base && (await globalThis.fetch(`${base}/health`)).ok) { ready = true; break; }
    } catch { /* Wait for the listener. */ }
    await delay(250);
  }
  assert.ok(ready, `Isolated API did not start: ${diagnostics}`);
  const check = spawn(process.execPath, [fileURLToPath(new URL("./part-color.browser.mjs", import.meta.url))], {
    env: { ...process.env, PART_COLOR_API: base, PART_COLOR_UI: base }, stdio: "inherit",
  });
  const code = await new Promise((resolve, reject) => { check.once("error", reject); check.once("exit", resolve); });
  assert.equal(code, 0, "Part color browser journey failed");
} finally {
  if (server.exitCode === null && server.signalCode === null) server.kill("SIGTERM");
  await Promise.race([exited, delay(5000)]);
  if (server.exitCode === null && server.signalCode === null) { server.kill("SIGKILL"); await exited; }
  await rm(data, { recursive: true, force: true });
}
