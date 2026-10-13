import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { installOwnedLifecycle, ownedLivePids } from "./owned-lifecycle.ts";

const output = mkdtempSync(join(tmpdir(), "gre492-signals-"));
process.env.GRE492_JOURNAL = join(output, "lifecycle.jsonl");
installOwnedLifecycle();

test("owned child kill preserves probes and requested signals", async () => {
  const child = spawn(process.execPath, ["-e", `
    process.on("SIGUSR1", () => process.send("SIGUSR1"));
    process.on("message", () => process.send("alive"));
    process.send("ready");
  `], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const exited = once(child, "exit");
  const response = async (send: () => void): Promise<unknown> => {
    const message = once(child, "message");
    send();
    return Promise.race([
      message.then(([value]) => value),
      exited.then(() => { throw new Error("child exited instead of preserving the requested signal"); }),
    ]);
  };
  try {
    await once(child, "message");
    assert.equal(child.kill(0), true);
    assert.equal(await response(() => child.send("ping")), "alive");
    assert.equal(await response(() => { child.kill("SIGUSR1"); }), "SIGUSR1");
    assert.equal(await response(() => { child.kill(constants.signals.SIGUSR1); }), "SIGUSR1");
    assert.ok(ownedLivePids(["worker"]).includes(child.pid ?? 0));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    rmSync(output, { recursive: true, force: true });
  }
});
