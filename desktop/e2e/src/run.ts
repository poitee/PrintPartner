import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import {
  installOwnedLifecycle,
  ownedLivePids,
  readStartIdentity,
  requestSignal,
  stopOwnedProcesses,
  processesMentioning,
} from "./owned-lifecycle.ts";

installOwnedLifecycle();

function refusalProbe(): void {
  const before = readStartIdentity(1);
  if (before === null) {
    throw new Error("pid 1 has no start identity");
  }
  if (requestSignal(1, "SIGTERM") !== "refused") {
    throw new Error("unowned pid 1 accepted a signal");
  }
  if (readStartIdentity(1) !== before) {
    throw new Error("the unowned refusal changed pid 1");
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("could not bind a local port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

function portBusy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(true));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(false)));
  });
}

function freeDisplay(): number {
  for (let display = 150; display < 190; display += 1) {
    if (!existsSync(`/tmp/.X11-unix/X${display}`) && !existsSync(`/tmp/.X${display}-lock`)) {
      return display;
    }
  }
  throw new Error("no free X display");
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function main(): Promise<number> {
  const output = process.env.GRE492_OUTPUT;
  const binary = process.env.GRE492_APP_BINARY;
  const stage = process.env.GRE492_STAGE;
  const stagedNode = process.env.GRE492_STAGED_NODE;
  if (!output || !binary || !stage || !stagedNode) {
    throw new Error("GRE492_OUTPUT, GRE492_APP_BINARY, GRE492_STAGE, and GRE492_STAGED_NODE are required");
  }
  if (process.env.DISPLAY === ":99") {
    throw new Error("DISPLAY=:99 is the shared fleet display");
  }
  delete process.env.DISPLAY;
  mkdirSync(output, { recursive: true });
  process.env.GRE492_JOURNAL = join(output, "lifecycle.jsonl");
  refusalProbe();

  const root = mkdtempSync(join(output, "data-run-"));
  const data = join(root, "data");
  const xdg = {
    data: join(root, "xdg-data"),
    config: join(root, "xdg-config"),
    cache: join(root, "xdg-cache"),
    state: join(root, "xdg-state"),
    runtime: join(root, "xdg-runtime"),
  };
  for (const dir of [data, ...Object.values(xdg)]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  process.env.GRE492_DATA = data;
  process.env.XDG_DATA_HOME = xdg.data;
  process.env.XDG_CONFIG_HOME = xdg.config;
  process.env.XDG_CACHE_HOME = xdg.cache;
  process.env.XDG_STATE_HOME = xdg.state;
  process.env.XDG_RUNTIME_DIR = xdg.runtime;
  process.env.GRE492_PORT = String(await freePort());

  const homeStore = join(homedir(), ".print-partner");
  const homeBefore = existsSync(homeStore) ? statSync(homeStore).ino : null;

  const display = freeDisplay();
  let exitCode = 1;
  let failure: unknown;
  let displayPid: number | null = null;
  try {
    const xvfb = spawn(
      process.env.GRE492_XVFB_BINARY ?? "Xvfb",
      [`:${display}`, "-screen", "0", "1280x1024x24", "-nolisten", "tcp", "-ac", "+extension", "RANDR"],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    displayPid = xvfb.pid ?? null;
    let displayError: Error | null = null;
    xvfb.once("error", (error) => { displayError = error; });
    process.env.DISPLAY = `:${display}`;
    const socket = `/tmp/.X11-unix/X${display}`;
    const displayLock = `/tmp/.X${display}-lock`;
    const ownsDisplay = (): boolean => existsSync(socket) && existsSync(displayLock)
      && displayPid !== null && Number(readFileSync(displayLock, "utf8").trim()) === displayPid;
    const deadline = Date.now() + 5000;
    while (!ownsDisplay()) {
      if (displayError) throw displayError;
      if (xvfb.exitCode !== null) {
        throw new Error("owned Xvfb exited before its socket existed");
      }
      if (Date.now() > deadline) {
        throw new Error("owned Xvfb did not create its matching PID lock and socket");
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const { Launcher } = await import("@wdio/cli");
    const launcher = new Launcher(
      new URL("../wdio.conf.ts", import.meta.url).pathname,
      {},
    );
    exitCode = (await launcher.run()) ?? 1;
  } catch (error) {
    failure = error;
  } finally {
    try {
      await stopOwnedProcesses(["launcher", "descendant", "worker"]);
    } catch (error) { failure ??= error; exitCode = 1; }
    try {
      await stopOwnedProcesses(["display"]);
    } catch (error) { failure ??= error; exitCode = 1; }
    const sessionDeleted = existsSync(join(output, "session-deleted.json"));
    if (exitCode === 0 && !sessionDeleted) {
      failure ??= new Error("WebDriver session deletion was not observed");
      exitCode = 1;
    }
    const ownedLive = ownedLivePids(["launcher", "descendant", "worker", "display"]);
    const dataHits = processesMentioning(data);
    const busy = await portBusy(Number(process.env.GRE492_PORT));
    writeFileSync(join(output, "shutdown.json"), JSON.stringify({ live: ownedLive, dataHits, portBusy: busy }, null, 2) + "\n");
    if (ownedLive.length > 0 || dataHits.length > 0 || busy) {
      failure ??= new Error("Owned app shutdown left processes or its port active");
      exitCode = 1;
    } else rmSync(root, { recursive: true, force: true });
    const homeAfter = existsSync(homeStore) ? statSync(homeStore).ino : null;
    const summary = {
      exitCode,
      failure: failure instanceof Error ? failure.message : failure ? String(failure) : null,
      ownedLive,
      sessionDeleted,
      display: process.env.DISPLAY,
      displayPid,
      displayLive: ownedLivePids(["display"]),
      port: process.env.GRE492_PORT,
      data,
      xdg,
      homeStoreUnchanged: homeBefore === homeAfter,
      binarySha256: existsSync(binary) ? sha256File(binary) : null,
      stageReleaseSha256: sha256File(join(stage, "release.json")),
      stagedNodeSha256: sha256File(stagedNode),
    };
    writeFileSync(join(output, "run.json"), `${JSON.stringify(summary, null, 2)}\n`);
    if (homeBefore !== homeAfter) {
      throw new Error("the run changed the shared desktop store");
    }
  }
  if (failure) throw failure;
  return exitCode;
}

const code = await main();
process.exit(code);
