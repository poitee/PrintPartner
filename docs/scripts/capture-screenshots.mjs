#!/usr/bin/env node
/**
 * Capture Print Partner workflow screenshots (light or dark theme).
 *
 * Usage:
 *   node docs/scripts/capture-screenshots.mjs --theme light
 *   node docs/scripts/capture-screenshots.mjs --theme dark
 *   node docs/scripts/capture-screenshots.mjs --url http://localhost:8080 --theme light --profile-id 1
 *
 * Chrome: set PLAYWRIGHT_CHROMIUM_EXECUTABLE, or install Playwright Chromium:
 *   cd docs/scripts && npm install && npx playwright install chromium
 *
 * For representative kit data without a long-lived app, run:
 *   node web/apps/web/test/browser/capture-fixture-screenshots.mjs
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");

const { values } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:8080" },
    theme: { type: "string", default: "light" },
    out: { type: "string" },
    "profile-id": { type: "string" },
  },
});
const theme = values.theme === "dark" ? "dark" : "light";
const baseUrl = values.url.replace(/\/$/, "");
const profileId = values["profile-id"]?.trim() || null;
const outDir = resolve(
  values.out ?? join(repoRoot, "docs/screenshots", theme),
);

function browserExecutable() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/local/bin/google-chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate));
}

async function loadChromium() {
  try {
    const playwright = await import("playwright");
    if (playwright.chromium) return playwright.chromium;
  } catch {
    // Prefer the web workspace playwright-core + system Chrome.
  }
  const require = createRequire(join(repoRoot, "web/package.json"));
  const core = require("playwright-core");
  if (!core?.chromium) {
    throw new Error(
      "Neither playwright nor playwright-core.chromium is available. Install web workspace deps.",
    );
  }
  return core.chromium;
}

/**
 * @typedef {{
 *   label: string;
 *   path: string;
 *   file: string;
 *   nav?: "sidebar";
 *   waitMs?: number;
 *   ready?: (page: import('playwright').Page) => Promise<void>;
 * }} Capture
 */

/** @type {Capture[]} */
const captures = [
  {
    label: "Library",
    path: "/library",
    file: "library.png",
    nav: "sidebar",
    ready: async (page) => {
      await page.getByRole("heading", { name: "Library", level: 1 }).waitFor({
        state: "visible",
        timeout: 60_000,
      });
    },
  },
  {
    label: "Builds",
    path: "/builds",
    file: "builds.png",
    nav: "sidebar",
    ready: async (page) => {
      await page.getByRole("heading", { name: "Builds", level: 1 }).waitFor({
        state: "visible",
        timeout: 60_000,
      });
    },
  },
  {
    label: "Sources",
    path: "/sources",
    file: "sources.png",
    nav: "sidebar",
    ready: async (page) => {
      await page.getByRole("heading", { name: /Sources|Build Sources/i }).first().waitFor({
        state: "visible",
        timeout: 60_000,
      }).catch(async () => {
        await page.getByRole("heading", { level: 1 }).waitFor({ state: "visible", timeout: 60_000 });
      });
    },
  },
  {
    label: "Plan",
    path: "/plan",
    file: "plan.png",
    nav: "sidebar",
    waitMs: 2500,
    ready: async (page) => {
      await page.getByRole("heading", { name: "Plan", level: 1 }).waitFor({
        state: "visible",
        timeout: 60_000,
      });
      await page.getByRole("button", { name: /Increase quantity for /i }).first().waitFor({
        timeout: 30_000,
      }).catch(() => {});
      await page
        .locator(".preview3d-canvas canvas")
        .first()
        .waitFor({
          state: "attached",
          timeout: 15_000,
        })
        .catch(() => {});
    },
  },
  {
    label: "Checkoff",
    path: "/progress",
    file: "checkoff.png",
    nav: "sidebar",
    waitMs: 1200,
    ready: async (page) => {
      await page.getByRole("heading", { name: /Checkoff|Progress/i, level: 1 }).waitFor({
        state: "visible",
        timeout: 60_000,
      });
      await page.getByText(".stl", { exact: false }).first().waitFor({ timeout: 15_000 }).catch(() => {});
    },
  },
  {
    label: "Production",
    path: "/export",
    file: "production.png",
    nav: "sidebar",
    waitMs: 1200,
    ready: async (page) => {
      await page.getByRole("heading", { name: /Production/i, level: 1 }).waitFor({
        state: "visible",
        timeout: 60_000,
      });
      await page.getByRole("heading", { name: "Prepare Plates", level: 2 }).waitFor({
        timeout: 15_000,
      }).catch(() => {});
    },
  },
];

async function waitForApp(page) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const res = await page.request.get(`${baseUrl}/health`);
      if (res.ok()) {
        const body = await res.json();
        if (body?.ok) return;
      }
    } catch {
      // retry
    }
    await delay(2000);
  }
  throw new Error(`App not healthy at ${baseUrl}/health after 120s`);
}

async function openClientPath(page, path) {
  const workflow = page.getByRole("navigation", { name: "Workflow stages" });
  const utility = page.getByRole("navigation", { name: "Utility" });
  if (path === "/library") {
    await page.goto(`${baseUrl}/library`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    return;
  }
  if (path === "/builds") {
    await utility.getByRole("link", { name: "Builds" }).click();
    return;
  }
  const workflowLabel = {
    "/sources": "Sources",
    "/plan": "Plan",
    "/progress": "Checkoff",
    "/export": "Production",
  }[path];
  if (workflowLabel) {
    await workflow.getByRole("link", { name: workflowLabel }).click();
    return;
  }
  await page.evaluate((next) => {
    const url = new URL(next, window.location.origin);
    window.history.pushState({}, "", `${url.pathname}${url.search}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

async function main() {
  const chromium = await loadChromium();
  await mkdir(outDir, { recursive: true });

  const executablePath = browserExecutable();
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });

  await context.addInitScript(
    ({ selectedTheme, selectedProfileId }) => {
      localStorage.setItem("print-partner.theme", selectedTheme);
      localStorage.setItem("print-partner.sidebar.ui.v1", "0");
      localStorage.setItem("print-partner.workflow.onboarding.v1", "1");
      if (selectedProfileId) {
        sessionStorage.setItem("pp-selected-profile-id", selectedProfileId);
      }
    },
    { selectedTheme: theme, selectedProfileId: profileId },
  );

  const page = await context.newPage();

  process.stdout.write(`Waiting for ${baseUrl}/health...\n`);
  await waitForApp(page);

  const homeUrl = profileId
    ? `${baseUrl}/?profile=${encodeURIComponent(profileId)}`
    : `${baseUrl}/`;
  process.stdout.write(`Loading ${homeUrl} (${theme} theme)...\n`);
  await page.goto(homeUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});

  for (const shot of captures) {
    process.stdout.write(`Capturing ${shot.label} -> ${shot.file}\n`);
    await openClientPath(page, shot.path);
    await page.waitForURL(
      (url) => {
        const path = url.pathname.replace(/\/$/, "");
        const expected = shot.path.replace(/\/$/, "");
        return path === expected || path.endsWith(expected);
      },
      { timeout: 30_000 },
    );

    if (shot.ready) await shot.ready(page);
    if (shot.waitMs) await delay(shot.waitMs);

    await page.screenshot({
      path: join(outDir, shot.file),
      fullPage: false,
    });
  }

  await browser.close();
  process.stdout.write(`Done. Screenshots are in ${outDir}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
