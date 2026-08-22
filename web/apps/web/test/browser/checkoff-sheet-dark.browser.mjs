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
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } });
  await page.goto(new URL("test/browser/checkoff-sheet-dark.html", baseUrl).toString());

  const screenSheet = page.locator(".checkoff-sheet");
  const screenBg = await screenSheet.evaluate((element) => {
    const style = element.ownerDocument.defaultView.getComputedStyle(element);
    return style.backgroundColor;
  });
  assert.notEqual(
    screenBg,
    "rgb(255, 255, 255)",
    `dark screen sheet should not use paper white, got ${screenBg}`,
  );
  assert.match(
    screenBg,
    /rgb\(3[0-9], 3[0-9], 3[0-9]\)/,
    `expected dark card-like background, got ${screenBg}`,
  );

  const printBg = await screenSheet.evaluate((element) => {
    const styles = [...element.ownerDocument.styleSheets].flatMap((sheet) => {
      try {
        return [...sheet.cssRules];
      } catch {
        return [];
      }
    });
    const printRule = styles.find((rule) => {
      if (!("conditionText" in rule) || rule.conditionText !== "print") return false;
      return [...rule.cssRules].some(
        (inner) =>
          "selectorText" in inner &&
          inner.selectorText === ".checkoff-sheet" &&
          inner.cssText.includes("--paper-bg: #ffffff"),
      );
    });
    return printRule ? "#ffffff" : null;
  });
  assert.equal(printBg, "#ffffff", "print media must force paper white");
} finally {
  await browser?.close();
  await server.close();
}
