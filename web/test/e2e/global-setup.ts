import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { chromium, type FullConfig } from "@playwright/test";

// pp-server admits a browser through a one-use bootstrap URL. Redeem it once and save the
// session cookie, so every spec starts signed in.
export default async function globalSetup(config: FullConfig) {
  const state = process.env.PP_E2E_STATE;
  const origin = process.env.PP_SERVER_URL;
  if (!state || !origin) throw new Error("pp-server did not start; PP_E2E_STATE or PP_SERVER_URL is missing");
  const { bootstrap_url: bootstrap } = JSON.parse(readFileSync(join(state, "bootstrap.json"), "utf8")) as {
    bootstrap_url: string;
  };
  if (!bootstrap.startsWith(`${origin}/__desktop/bootstrap?`)) throw new Error("Unexpected bootstrap origin");
  const browser = await chromium.launch(config.projects[0].use.launchOptions);
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(bootstrap);
    await context.storageState({ path: join(state, "storage.json") });
  } finally {
    await browser.close();
  }
}
