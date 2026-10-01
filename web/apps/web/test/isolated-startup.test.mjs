import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import process from "node:process";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";

async function runWrapper(filename, mode) {
  let now = 0;
  const removed = [];
  const spawned = [];
  const timeoutDurations = [];
  const signals = new Map();
  const kills = [];
  let healthRequests = 0;
  let abortedRequests = 0;
  const data = `/owned/${filename}`;
  const server = new EventEmitter();
  server.stdout = new EventEmitter();
  server.stderr = new EventEmitter();
  server.exitCode = null;
  server.signalCode = null;
  server.kill = (signal) => {
    kills.push({ signal, elapsed: now });
    server.signalCode = signal;
    server.emit("exit", null, signal);
  };

  const context = createContext({
    Date: class extends Date {
      static now() { return now; }
    },
    AbortSignal: {
      timeout(milliseconds) {
        timeoutDurations.push(milliseconds);
        const controller = new globalThis.AbortController();
        signals.set(controller.signal, { controller, milliseconds });
        return controller.signal;
      },
    },
    fetch: async (_url, options) => {
      healthRequests++;
      if (mode !== "stall" && (mode !== "retry" || healthRequests > 1)) return { ok: true };
      return new Promise((_resolve, reject) => {
        const signal = options?.signal;
        if (!signal) return;
        signal.addEventListener("abort", () => {
          abortedRequests++;
          reject(signal.reason);
        }, { once: true });
        globalThis.queueMicrotask(() => {
          const { controller, milliseconds } = signals.get(signal);
          now += milliseconds;
          controller.abort(new Error("Controlled health request timeout"));
        });
      });
    },
  });
  const exportsBySpecifier = {
    "node:assert/strict": { default: assert },
    "node:child_process": {
      spawn(command, args, options) {
        spawned.push({ command, args, options });
        if (spawned.length === 1) {
          globalThis.queueMicrotask(() => {
            if (mode === "server-exit") {
              server.stderr.emit("data", "Controlled startup failure");
              server.exitCode = 1;
              server.emit("exit", 1);
            } else {
              server.stdout.emit("data", "Server listening at http://127.0.0.1:9876");
            }
          });
          return server;
        }
        const check = new EventEmitter();
        globalThis.queueMicrotask(() => check.emit("exit", mode === "check-failure" ? 1 : 0));
        return check;
      },
    },
    "node:fs/promises": {
      mkdtemp: async () => data,
      rm: async (path, options) => removed.push({
        path, options: { recursive: options.recursive, force: options.force },
      }),
    },
    "node:process": { default: { execPath: process.execPath, env: { PATH: "/owned/bin" } } },
    "node:timers/promises": { setTimeout: async (milliseconds) => { now += milliseconds; } },
    "node:url": { fileURLToPath, URL },
  };
  const sourceUrl = new URL(`./browser/${filename}`, import.meta.url);
  const wrapper = new SourceTextModule(await readFile(sourceUrl, "utf8"), {
    context,
    initializeImportMeta(meta) { meta.url = sourceUrl.href; },
  });
  await wrapper.link((specifier) => {
    const exports = exportsBySpecifier[specifier];
    assert.ok(exports, `Unexpected wrapper dependency: ${specifier}`);
    return new SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
  });
  let error;
  try {
    await wrapper.evaluate();
  } catch (caught) {
    error = caught;
  }
  assert.deepEqual(removed, [{ path: data, options: { recursive: true, force: true } }]);
  return { error, spawned, timeoutDurations, kills, healthRequests, abortedRequests };
}

for (const filename of ["filename-grouping.isolated.mjs", "part-color.isolated.mjs"]) {
  test(`${filename} bounds stalled health requests and cleans its fixture`, async () => {
    const result = await runWrapper(filename, "stall");
    assert.match(result.error?.message ?? "", /Isolated API did not start/);
    assert.equal(result.spawned.length, 1);
    assert.equal(result.abortedRequests, result.healthRequests);
    assert.ok(result.abortedRequests > 1);
    assert.ok(result.timeoutDurations.every((duration) => duration === 1_000));
    assert.equal(result.kills[0]?.signal, "SIGTERM");
    assert.ok(result.kills[0].elapsed >= 30_000 && result.kills[0].elapsed < 31_250);
  });

  test(`${filename} retries an aborted health request before the browser journey`, async () => {
    const result = await runWrapper(filename, "retry");
    assert.equal(result.error, undefined);
    assert.equal(result.abortedRequests, 1);
    assert.equal(result.healthRequests, 2);
    assert.equal(result.spawned.length, 2);
    assert.deepEqual(result.timeoutDurations, [1_000, 1_000]);
    assert.equal(result.kills[0]?.signal, "SIGTERM");
  });

  test(`${filename} cleans an already-exited API without starting a browser journey`, async () => {
    const result = await runWrapper(filename, "server-exit");
    assert.match(result.error?.message ?? "", /Controlled startup failure/);
    assert.equal(result.spawned.length, 1);
    assert.equal(result.healthRequests, 0);
    assert.deepEqual(result.kills, []);
  });

  test(`${filename} cleans the API when the browser journey fails`, async () => {
    const result = await runWrapper(filename, "check-failure");
    assert.match(result.error?.message ?? "", /browser journey failed/);
    assert.equal(result.spawned.length, 2);
    assert.equal(result.healthRequests, 1);
    assert.equal(result.kills[0]?.signal, "SIGTERM");
  });
}
