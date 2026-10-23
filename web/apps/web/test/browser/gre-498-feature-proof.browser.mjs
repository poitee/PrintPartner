import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { browserExecutable } from "./browserExecutable.mjs";

const fixture = "test/browser/gre-498-feature-proof-visibility.html";
const evidenceRoot = process.env.PP_GRE498_PROOF_EVIDENCE;
const shots = [
  { name: "01-account-default", query: "surface=account" },
  { name: "02-account-all-enabled", query: "surface=account&enabled=1" },
  { name: "03-plan-default", query: "surface=plan" },
  { name: "04-plan-all-enabled", query: "surface=plan&enabled=1" },
  { name: "05-farm-queue-off", query: "surface=farm" },
  { name: "06-farm-queue-on", query: "surface=farm&enabled=1" },
];

const server = await createServer({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});

let browser;
try {
  await server.listen();
  const baseUrl = server.resolvedUrls?.local[0];
  assert.ok(baseUrl, "Vite did not expose a local test URL");
  if (evidenceRoot) await mkdir(evidenceRoot, { recursive: true });

  browser = await chromium.launch({ executablePath: browserExecutable(), headless: true });
  const page = await browser.newPage({ viewport: { width: 960, height: 900 } });

  for (const { name, query } of shots) {
    await page.goto(new URL(`${fixture}?${query}`, baseUrl).toString());

    if (query.includes("surface=account")) {
      await page.getByRole("heading", { name: "Account feature toggles" }).waitFor();
      const switches = page.getByRole("switch");
      await switches.first().waitFor();
      const count = await switches.count();
      assert.equal(count, 4);
      const checked = await switches.evaluateAll((nodes) =>
        nodes.map((n) => n.getAttribute("data-state") === "checked"),
      );
      if (query.includes("enabled=1")) assert.ok(checked.every(Boolean));
      else assert.ok(checked.every((on) => !on));
    }

    if (query.includes("surface=plan")) {
      await page.getByRole("heading", { name: "Plan feature overrides" }).waitFor();
      await page.getByText("Print farm").waitFor();
      const onButtons = page.getByRole("button", { name: "On" });
      assert.equal(await onButtons.count(), 4);
    }

    if (query.includes("surface=farm")) {
      await page.getByRole("heading", { name: "Production send queue" }).waitFor();
      const marker = page.locator('[aria-label="Send queue visible"]');
      await marker.waitFor({ state: "attached" });
      const queue = page.getByRole("region", { name: "Printer send queue" });
      const wantVisible = query.includes("enabled=1");
      await page.waitForFunction(
        ({ want }) => {
          const el = document.querySelector('[aria-label="Send queue visible"]');
          return el?.getAttribute("data-farm-queue-visible") === (want ? "yes" : "no");
        },
        { want: wantVisible },
        { timeout: 15_000 },
      );
      await queue.waitFor({ state: wantVisible ? "visible" : "hidden" });
    }

    if (evidenceRoot) {
      await page.screenshot({ path: join(evidenceRoot, `${name}.png`), fullPage: true });
    }
  }

  if (evidenceRoot) {
    await writeFile(
      join(evidenceRoot, "manifest.json"),
      `${JSON.stringify({ fixture, shots: shots.map((s) => s.name) }, null, 2)}\n`,
    );
  }
  console.log(`PASS GRE-498 feature proof fixture (${shots.length} surfaces)`);
} finally {
  await browser?.close();
  await server.close();
}
