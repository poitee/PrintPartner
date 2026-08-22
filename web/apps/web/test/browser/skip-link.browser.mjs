import assert from "node:assert/strict";
import { URL } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { browserExecutable } from "./browserExecutable.mjs";

const executablePath = browserExecutable();

const server = await createServer({
  server: {
    host: "127.0.0.1",
    port: 0,
    strictPort: false,
  },
});

let browser;
try {
  await server.listen();
  const baseUrl = server.resolvedUrls?.local[0];
  assert.ok(baseUrl, "Vite did not expose a local test URL");

  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.goto(new URL("test/browser/skip-link.html", baseUrl).toString());

  const skipLink = page.getByRole("link", { name: "Skip to main content" });
  const initial = await skipLink.evaluate((element) => {
    const style = element.ownerDocument.defaultView.getComputedStyle(element);
    return {
      clip: style.clip,
      clipPath: style.clipPath,
      height: style.height,
      width: style.width,
    };
  });
  assert.equal(initial.width, "1px");
  assert.equal(initial.height, "1px");
  assert.ok(
    initial.clip.includes("rect(0px") || initial.clipPath.includes("inset(50%)"),
    `expected visually hidden clipping, got clip=${initial.clip} clipPath=${initial.clipPath}`,
  );

  await skipLink.focus();
  const focused = await skipLink.evaluate((element) => {
    const style = element.ownerDocument.defaultView.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      clip: style.clip,
      clipPath: style.clipPath,
      height: rect.height,
      left: rect.left,
      position: style.position,
      top: rect.top,
      width: rect.width,
    };
  });

  assert.equal(focused.position, "fixed");
  assert.ok(focused.width > 100, `focused skip link width was ${focused.width}`);
  assert.ok(focused.height > 20, `focused skip link height was ${focused.height}`);
  assert.ok(focused.left >= 0 && focused.top >= 0, "focused skip link was outside the viewport");
  assert.equal(focused.clip, "auto");
  assert.equal(focused.clipPath, "none");
} finally {
  await browser?.close();
  await server.close();
}
