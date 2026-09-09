import assert from "node:assert/strict";
import process from "node:process";
import console from "node:console";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import { unzipSync, strFromU8 } from "fflate";
import { browserExecutable } from "./browserExecutable.mjs";

const base = process.env.REFERENCE_SHARE_UI;
const api = process.env.REFERENCE_SHARE_API;
const profile = process.env.REFERENCE_SHARE_BUILD;
assert.ok(base && api && profile, "Set REFERENCE_SHARE_UI, REFERENCE_SHARE_API, and REFERENCE_SHARE_BUILD for an isolated fixture");
const health = await globalThis.fetch(`${api}/health`).then((response) => response.json());
assert.ok(health.data_dir?.startsWith("/tmp/pp-reference-share-"), "Refusing a non-isolated server");

const browser = await chromium.launch({ executablePath: browserExecutable(), headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  await page.goto(`${base}/export?profile=${encodeURIComponent(profile)}`);
  const share = page.getByRole("button", { name: "Share Build", exact: true }).first();
  await share.waitFor({ timeout: 60000 });
  await share.click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Download manifest", exact: true }).waitFor({ timeout: 30000 });
  assert.match(await dialog.innerText(), /No model files are included/);
  assert.match(await dialog.innerText(), /located manually/);
  await dialog.getByText("Preview shared manifest", { exact: true }).click();
  const preview = JSON.parse(await dialog.locator("pre").innerText());
  assert.equal(preview.kind, "build");
  assert.ok(preview.parts.length > 0, "Fixture must have at least one part");
  assert.equal(preview.sources[0].location.kind, "manual");

  async function download(button) {
    const pending = page.waitForEvent("download");
    await dialog.getByRole("button", { name: button, exact: true }).click();
    const result = await pending;
    assert.equal(await result.failure(), null);
    return readFile(await result.path());
  }
  const json = await download("Download manifest");
  assert.deepEqual(JSON.parse(json.toString()), preview);
  const git = unzipSync(await download("Download Git bundle"));
  assert.deepEqual(Object.keys(git).sort(), [".gitignore", "README.md", "printpartner.share.json"]);
  assert.deepEqual(JSON.parse(strFromU8(git["printpartner.share.json"])), preview);
  assert.equal("print_units" in preview.parts[0], false);
  assert.equal("order_number" in preview, false);

  await dialog.getByText("Validate a received manifest", { exact: true }).click();
  await dialog.getByLabel("Choose reference manifest JSON").setInputFiles({ name: "received.json", mimeType: "application/json", buffer: json });
  await dialog.getByRole("status").filter({ hasText: "No files were downloaded or data changed" }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => {
    const rect = globalThis.document.querySelector('[role="dialog"]').getBoundingClientRect();
    return rect.left >= 0 && rect.right <= globalThis.innerWidth;
  });
  await page.screenshot({ path: "/tmp/pp-reference-sharing-mobile.png", fullPage: true, animations: "disabled" });
  const sizes = await dialog.evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }));
  assert.ok(sizes.scroll <= sizes.client, `Dialog content overflow: ${JSON.stringify(sizes)}`);
  assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth > globalThis.innerWidth), false);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${base}/parts?profile=${encodeURIComponent(profile)}`);
  await page.getByRole("button", { name: "Share Build", exact: true }).click({ timeout: 60000 });
  await page.getByRole("dialog").getByRole("button", { name: "Download manifest", exact: true }).waitFor();
  console.log("PASS: Plan/Production Share UI downloads exact references-only JSON/Git, validates received JSON, and fits a 390px viewport");
} finally {
  await browser.close();
}
