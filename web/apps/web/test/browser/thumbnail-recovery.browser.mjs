import assert from "node:assert/strict";
import { log } from "node:console";
import { URL } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { browserExecutable } from "./browserExecutable.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
let browser;

try {
  await server.listen();
  const baseUrl = server.resolvedUrls?.local[0];
  assert.ok(baseUrl, "Vite did not expose a fixture URL");
  browser = await chromium.launch({ executablePath: browserExecutable(), headless: true });

  for (const mode of ["normal", "stall"]) {
    const page = await browser.newPage({ viewport: { width: 1193, height: 1122 } });
    page.setDefaultTimeout(15_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const url = new URL("test/browser/thumbnail-recovery.html", baseUrl);
    if (mode === "stall") url.searchParams.set("capture", "stall");
    await page.goto(url.toString());

    const status = page.locator("[data-result]");
    await page.locator('[data-result="pass"]').waitFor();
    assert.match(await status.innerText(), /12\/12 images loaded; 12\/12 pixel checks passed/);
    assert.match(await status.innerText(), /Thumbnail POSTs: 12\. Cached: 12\./);
    assert.match(await status.innerText(), new RegExp(`Stalled captures: ${mode === "stall" ? 1 : 0}\\.`));

    await page.getByRole("button", { name: "Open grey preview", exact: true }).click();
    const preview = page.getByRole("application", { name: "Interactive 3D preview of fixture-grey.stl" });
    await preview.waitFor({ state: "visible" });
    await preview.press("ArrowLeft");
    // The old competing writer uploaded the expanded canvas after 900ms.
    await page.waitForTimeout(1_000);
    assert.equal(await status.getAttribute("data-result"), "pass");
    await page.getByRole("button", { name: "Close preview", exact: true }).click();
    await page.getByText("Thumbnail uploads since preview opened: 0. Expected: 0.", { exact: true }).waitFor();

    const oldUrls = await page.locator(".sheet-thumb-img").evaluateAll(
      (images) => images.map((image) => image.getAttribute("src")),
    );
    await page.getByRole("button", { name: "Reload thumbnail cards", exact: true }).click();
    const root = await page.locator("#root").elementHandle();
    assert.ok(root);
    await page.waitForFunction(({ element, previousUrls }) => {
      const images = [...element.querySelectorAll("img.sheet-thumb-img")];
      return images.length === 12 && images.every((image) =>
        image.complete && !previousUrls.includes(image.src),
      );
    }, { element: root, previousUrls: oldUrls });
    await page.locator('[data-result="pass"]').waitFor();
    assert.match(await status.innerText(), /Thumbnail POSTs: 12\. Cached: 12\./);
    assert.match(await status.innerText(), /Unexpected requests: 0\./);
    await page.getByText("Thumbnail uploads since preview opened: 0. Expected: 0.", { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    log(`${mode}: ${await status.innerText()}`);
    await page.close();
  }
} finally {
  await browser?.close();
  await server.close();
}
