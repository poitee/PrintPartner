import assert from "node:assert/strict";
import { log } from "node:console";
import { URL } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { BoxGeometry, Mesh, MeshBasicMaterial } from "three";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import { browserExecutable } from "./browserExecutable.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 0 } });
let browser;
try {
  await server.listen();
  const base = server.resolvedUrls?.local[0];
  assert.ok(base);
  browser = await chromium.launch({ executablePath: browserExecutable(), headless: true });
  const page = await browser.newPage({ viewport: { width: 680, height: 360 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/parts/*/mesh", async (route) => {
    const id = Number(/\/parts\/(\d+)\/mesh/.exec(route.request().url())?.[1]);
    assert.ok(id === 1 || id === 2);
    const geometry = new BoxGeometry(6, id === 2 ? 40 : 6, id === 1 ? 40 : 6);
    const material = new MeshBasicMaterial();
    const stl = new STLExporter().parse(new Mesh(geometry, material));
    geometry.dispose();
    material.dispose();
    await route.fulfill({ status: 200, body: stl, headers: {
      "content-type": "model/stl", etag: `"${String(id).repeat(64)}"`,
      "x-accepted-render-hex": "#f08030",
    } });
  });
  await page.route("**/parts/*/thumbnail", (route) => route.fulfill({ status: 200, body: "{}" }));
  await page.goto(new URL("test/browser/stl-orientation.html", base).toString());
  await page.waitForSelector('body[data-ready="true"]');
  assert.deepEqual(errors, []);
  const bounds = await page.locator("img").evaluateAll((images) => images.map((image) => {
    const canvas = image.ownerDocument.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("No pixel reader");
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let left = canvas.width, right = -1, top = canvas.height, bottom = -1;
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      if (data[(y * canvas.width + x) * 4 + 3] < 250) continue;
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
    return { axis: image.id, width: right - left + 1, height: bottom - top + 1 };
  }));
  const [z, y] = bounds;
  assert.ok(z.height > z.width * 1.5, `STL Z must appear upright: ${JSON.stringify(z)}`);
  assert.ok(y.width > y.height * 1.2, `STL Y must remain horizontal: ${JSON.stringify(y)}`);
  await page.screenshot({ path: "/tmp/pp-stl-orientation.png" });
  log("PASS STL axis orientation", bounds);
} finally {
  await browser?.close();
  await server.close();
}
