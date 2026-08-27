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

  // Assert the intent, not a fixed colour: on screen the sheet takes the theme's
  // card surface and stays dark. Matching a literal rgb() range broke every time
  // the palette was tuned, even when the behaviour was still correct.
  const surfaces = await screenSheet.evaluate((element) => {
    const view = element.ownerDocument.defaultView;
    const probe = element.ownerDocument.createElement("div");
    probe.style.backgroundColor = "var(--card)";
    element.parentElement.appendChild(probe);
    const cardToken = view.getComputedStyle(probe).backgroundColor;
    probe.remove();
    return {
      sheet: view.getComputedStyle(element).backgroundColor,
      cardToken,
      page: view.getComputedStyle(element.ownerDocument.body).backgroundColor,
    };
  });

  function channels(color) {
    const parsed = color.match(/\d+(\.\d+)?/g);
    assert.ok(parsed && parsed.length >= 3, `could not read a colour from ${color}`);
    return parsed.slice(0, 3).map(Number);
  }

  /** Perceived lightness, 0 (black) to 255 (white). */
  function lightness(color) {
    const [r, g, b] = channels(color);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  assert.equal(
    surfaces.sheet,
    surfaces.cardToken,
    `dark screen sheet must use the --card surface, got ${surfaces.sheet}`,
  );
  assert.ok(
    lightness(surfaces.sheet) < 128,
    `dark screen sheet must stay dark, got ${surfaces.sheet}`,
  );
  assert.notEqual(
    surfaces.sheet,
    surfaces.page,
    "the sheet must read as a raised surface, not the page background",
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
