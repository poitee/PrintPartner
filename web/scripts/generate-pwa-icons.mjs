#!/usr/bin/env node
/* eslint-disable no-undef -- standalone Node asset generator, not part of the app build. */
/**
 * Rasterise the PWA icons from their SVG sources.
 *
 * The SVGs are the artwork of record; these PNGs exist only because Android
 * and iOS still want raster. Rerun after any change to icon.svg or
 * icon-maskable.svg:
 *
 *   node web/scripts/generate-pwa-icons.mjs
 *
 * This replaces the two Python generators that used to live in public/, where
 * Vite copied them into dist/ and shipped them. One of them, gen_png.py, still
 * drew an abandoned navy "P + check" design that no longer matched anything.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { browserExecutable } from "../apps/web/test/browser/browserExecutable.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const icons = join(here, "../apps/web/public/icons");
const docs = join(here, "../../docs");

/** `any` keeps the rounded plate; `maskable` is full bleed inside the safe zone. */
const TARGETS = [
  { svg: "icon.svg", out: "icon-192.png", size: 192 },
  { svg: "icon.svg", out: "icon-512.png", size: 512 },
  { svg: "icon-maskable.svg", out: "icon-maskable-512.png", size: 512 },
  // The README and GitHub Pages logo. It used to be an unrelated blue
  // circuit-asterisk on opaque black that matched nothing in the product.
  { svg: "icon.svg", out: "logo.png", size: 512, dir: docs },
];

const browser = await chromium.launch({ executablePath: browserExecutable(), headless: true });
try {
  for (const { svg, out, size, dir = icons } of TARGETS) {
    const source = readFileSync(join(icons, svg), "utf8");
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    });
    await page.setContent(
      `<!doctype html><style>
         html,body{margin:0;padding:0;background:transparent}
         svg{display:block;width:${size}px;height:${size}px}
       </style>${source}`,
      { waitUntil: "load" },
    );
    const shot = await page.locator("svg").screenshot({ omitBackground: true });
    writeFileSync(join(dir, out), shot);
    await page.close();
    console.log(`${join(dir, out)}  ${size}x${size}  ${shot.length} bytes`);
  }
} finally {
  await browser.close();
}
