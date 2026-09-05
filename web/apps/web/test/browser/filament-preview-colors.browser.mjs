import assert from "node:assert/strict";
import { log } from "node:console";
import { readFileSync } from "node:fs";
import process from "node:process";
import { URL } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { browserExecutable } from "./browserExecutable.mjs";

const catalogPath = process.env.PREVIEW_COLOR_CATALOG ?? new URL("../../../server/src/data/ambrosia_fallback.json", import.meta.url);
const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
const hexes = ["asa::black", "asa::super-grey"].map((id) => {
  const color = catalog.colors.find((entry) => entry.id === id);
  assert.ok(color, `Missing catalog color ${id}`);
  return color.hex;
});
const vertices = [
  [0, 0, 0], [20, 0, 0], [20, 20, 0], [0, 20, 0],
  [0, 0, 20], [20, 0, 20], [20, 20, 20], [0, 20, 20],
];
const faces = [
  [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
  [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
  [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
];
const stl = `solid cube\n${faces.map((face) => `facet normal 0 0 0\nouter loop\n${face.map((index) => `vertex ${vertices[index].join(" ")}`).join("\n")}\nendloop\nendfacet`).join("\n")}\nendsolid cube`;
const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
let browser;

try {
  await server.listen();
  const baseUrl = server.resolvedUrls?.local[0];
  assert.ok(baseUrl, "Vite did not expose a test URL");
  browser = await chromium.launch({ executablePath: browserExecutable(), headless: true });
  const page = await browser.newPage({ viewport: { width: 640, height: 320 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/parts/*/mesh", async (route) => {
    const match = /\/parts\/(\d+)\/mesh/.exec(route.request().url());
    const id = Number(match?.[1]);
    assert.ok(id === 1 || id === 2, "Unexpected test Part");
    await route.fulfill({
      status: 200,
      headers: {
        "content-type": "model/stl",
        etag: `"${String(id).repeat(64)}"`,
        "x-accepted-render-hex": hexes[id - 1],
      },
      body: stl,
    });
  });
  await page.route("**/parts/*/thumbnail", (route) => route.fulfill({ status: 200, body: "{}" }));
  await page.goto(new URL("test/browser/filament-preview-colors.html", baseUrl).toString());
  await page.waitForSelector('body[data-ready="true"]');
  assert.deepEqual(errors, []);

  const samples = await page.locator("img").evaluateAll((images) => images.map((image) => {
    const canvas = image.ownerDocument.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("No pixel reader");
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    const totals = [0, 0, 0];
    let count = 0;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index + 3] < 250) continue;
      count += 1;
      for (let channel = 0; channel < 3; channel += 1) totals[channel] += data[index + channel];
    }
    return { id: image.id, count, rgb: totals.map((sum) => sum / count) };
  }));
  if (process.env.PREVIEW_COLOR_SCREENSHOT) {
    await page.screenshot({ path: process.env.PREVIEW_COLOR_SCREENSHOT });
  }
  const [black, grey] = samples;
  assert.ok(black.count > 500 && grey.count > 500, "Meshes must contain enough opaque pixels");
  assert.ok(Math.max(...black.rgb) < 40, `Black is not dark: ${black.rgb}`);
  assert.ok(Math.max(...grey.rgb) - Math.min(...grey.rgb) < 10, `Super Grey is not neutral: ${grey.rgb}`);
  assert.ok(Math.min(...grey.rgb) > Math.max(...black.rgb) + 40, "Black and Super Grey must remain distinguishable");
  log(JSON.stringify(samples));
} finally {
  await browser?.close();
  await server.close();
}
