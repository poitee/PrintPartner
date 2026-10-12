import { browser, expect } from "@wdio/globals";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { PNG } from "pngjs";
import {
  exePath,
  launcherPid,
  ownedLivePids,
  processesMentioning,
  readStartIdentity,
  recordDescendants,
  requestSignal,
} from "../src/owned-lifecycle.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nodeIdentity(text: string): { version: string; abi: string; execPath: string } {
  const value: unknown = JSON.parse(text);
  if (
    !isRecord(value) ||
    typeof value.version !== "string" ||
    typeof value.abi !== "string" ||
    typeof value.execPath !== "string"
  ) {
    throw new Error("staged node did not report its identity");
  }
  return { version: value.version, abi: value.abi, execPath: value.execPath };
}

function outputDir(): string {
  const dir = process.env.GRE492_OUTPUT;
  if (!dir) {
    throw new Error("GRE492_OUTPUT is required");
  }
  return dir;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function heading(): Promise<string> {
  return browser.$("h1").getText();
}

async function waitForHeading(text: string): Promise<void> {
  await browser.waitUntil(async () => (await heading()) === text, {
    timeout: 60000,
    timeoutMsg: `expected the native heading ${text}`,
  });
}

function pngFacts(bytes: Buffer): {
  width: number;
  height: number;
  distinctColors: number;
  center: [number, number, number, number];
} {
  const png = PNG.sync.read(bytes);
  const colors = new Set<string>();
  const step = Math.max(1, Math.floor((png.width * png.height) / 4000));
  for (let index = 0; index < png.width * png.height; index += step) {
    const offset = index * 4;
    colors.add(
      `${png.data[offset]},${png.data[offset + 1]},${png.data[offset + 2]},${png.data[offset + 3]}`,
    );
  }
  const x = Math.floor(png.width / 2);
  const y = Math.floor(png.height / 2);
  const center = (y * png.width + x) * 4;
  return {
    width: png.width,
    height: png.height,
    distinctColors: colors.size,
    center: [png.data[center] ?? 0, png.data[center + 1] ?? 0, png.data[center + 2] ?? 0, png.data[center + 3] ?? 0],
  };
}

function portBusy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(true));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(false));
    });
  });
}

describe("native desktop", () => {
  it("refuses a signal to an unowned pid", () => {
    const before = readStartIdentity(1);
    expect(before).not.toBeNull();
    expect(requestSignal(1, "SIGTERM")).toBe("refused");
    expect(readStartIdentity(1)).toBe(before);
  });

  it("logs in through bootstrap and opens Builds then Plan", async () => {
    await waitForHeading("Builds");
    const builds = new URL(await browser.getUrl());
    expect(builds.pathname).toBe("/builds");
    expect(builds.search).not.toContain("token=");

    await browser.$('nav[aria-label="Support"] a[aria-label="Settings"]').click();
    await waitForHeading("Settings");

    await browser.$('nav[aria-label="Utility"] a[aria-label="Builds"]').click();
    await waitForHeading("Builds");
    expect(new URL(await browser.getUrl()).pathname).toBe("/builds");

    await browser.$('nav[aria-label="Build Workflow"] a[aria-label^="Plan"]').click();
    await waitForHeading("Plan");
    const plan = new URL(await browser.getUrl());
    expect(plan.pathname).toBe("/plan");
    const body = await browser.$("body").getText();
    expect(body).toContain("No Build selected");
    expect(body).toContain("Choose a Build to edit its Plan.");

    const launcher = launcherPid();
    expect(launcher).not.toBeNull();
    if (launcher === null) {
      return;
    }
    const descendants = recordDescendants(launcher);
    const stagedNode = process.env.GRE492_STAGED_NODE;
    if (!stagedNode) {
      throw new Error("GRE492_STAGED_NODE is required");
    }
    const nodePid = descendants.find((pid) => exePath(pid) === stagedNode);
    expect(nodePid).toBeDefined();
    if (nodePid === undefined) {
      return;
    }
    const identity = nodeIdentity(
      execFileSync(
        stagedNode,
        ["-p", "JSON.stringify({version:process.version,abi:process.versions.modules,execPath:process.execPath})"],
        { encoding: "utf8" },
      ),
    );
    expect(identity.version).toBe("v24.21.0");
    expect(identity.abi).toBe("137");
    expect(identity.execPath).toBe(stagedNode);
    expect(readFileSync(stagedNode).subarray(0, 4).toString("latin1")).toBe("\u007fELF");

    mkdirSync(outputDir(), { recursive: true });
    const screenshotPath = `${outputDir()}/plan.png`;
    await browser.saveScreenshot(screenshotPath);
    const bytes = readFileSync(screenshotPath);
    const pixels = pngFacts(bytes);
    expect(pixels.width).toBeGreaterThan(100);
    expect(pixels.height).toBeGreaterThan(100);
    expect(pixels.distinctColors).toBeGreaterThan(8);
    const receipt = {
      pathname: plan.pathname,
      heading: "Plan",
      buildsPath: "/builds",
      windowHandle: await browser.getWindowHandle(),
      launcherPid: launcher,
      launcherStartIdentity: readStartIdentity(launcher),
      descendantPids: descendants,
      stagedNode,
      stagedNodePid: nodePid,
      screenshotPath,
      screenshotSha256: sha256(bytes),
      pixels,
    };
    writeFileSync(`${outputDir()}/plan-receipt.json`, `${JSON.stringify(receipt, null, 2)}\n`);
  });

  after(async () => {
    const launcher = launcherPid();
    if (launcher === null) {
      return;
    }
    recordDescendants(launcher);
    const data = process.env.GRE492_DATA;
    const sent = requestSignal(launcher, "SIGTERM");
    expect(sent).toBe("sent");
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && readStartIdentity(launcher) !== null) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const live = ownedLivePids(["launcher", "descendant"]);
    const dataHits = data ? processesMentioning(data) : [];
    const port = Number(process.env.GRE492_PORT);
    const busy = Number.isInteger(port) ? await portBusy(port) : false;
    writeFileSync(
      `${outputDir()}/shutdown.json`,
      `${JSON.stringify({ sent, live, dataHits, portBusy: busy }, null, 2)}\n`,
    );
    expect(live).toEqual([]);
    expect(dataHits).toEqual([]);
    expect(busy).toBe(false);
  });
});
