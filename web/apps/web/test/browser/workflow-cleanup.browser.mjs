import assert from "node:assert/strict";
import process from "node:process";
import console from "node:console";
import { URL } from "node:url";
import { chromium } from "playwright-core";
import { browserExecutable } from "./browserExecutable.mjs";

const ui = process.env.CLEANUP_UI;
const api = process.env.CLEANUP_API;
assert.ok(ui && api, "Set CLEANUP_UI and CLEANUP_API for an isolated app");
async function json(path, init) {
  const response = await globalThis.fetch(`${api}${path}`, init);
  assert.ok(response.ok, `${path}: ${response.status}`);
  return response.json();
}
const health = await json("/health");
assert.ok(health.data_dir?.startsWith("/tmp/pp-cleanup-"), "Refusing a non-isolated server");
const initial = await json("/settings/logging/config");
const setTracking = (enabled) => json("/settings/logging/config", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ enableWorkflowTracking: enabled }),
});
const browser = await chromium.launch({ executablePath: browserExecutable(), headless: true });
try {
  await setTracking(true);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(15000);
  await page.goto(`${ui}/settings#data`, { waitUntil: "domcontentloaded" });
  const toggle = page.getByRole("switch", { name: "Workflow Tracking", exact: true });
  await toggle.waitFor({ timeout: 60000 });
  console.log("Settings loaded");
  async function toggleTo(enabled) {
    const saved = page.waitForResponse((response) =>
      response.url().endsWith("/settings/logging/config") && response.request().method() === "POST",
    );
    await toggle.evaluate((element) => element.focus({ preventScroll: true }));
    await page.keyboard.press("Space");
    assert.equal((await (await saved).json()).enableWorkflowTracking, enabled);
    console.log(`Tracking ${enabled ? "on" : "off"}`);
  }
  await toggleTo(false);
  await page.reload({ waitUntil: "domcontentloaded" });
  await toggle.waitFor({ timeout: 60000 });
  assert.equal(await toggle.getAttribute("aria-checked"), "false");
  const before = await json("/settings/logging/stats");
  await json("/health");
  assert.equal((await json("/settings/logging/stats")).totalLogs, before.totalLogs);
  await toggleTo(true);
  await json("/health");
  assert.ok((await json("/settings/logging/stats")).totalLogs > before.totalLogs);
  await page.locator("#data").screenshot({ path: "/tmp/pp-cleanup-logging-verified.png" });
  await page.goto(`${ui}/help`, { waitUntil: "domcontentloaded" });
  await page.getByText("Choose parts, quantities, and colors. Changes save automatically", { exact: true }).waitFor({ timeout: 60000 });
  assert.equal(await page.getByText("Accept Working Plan", { exact: true }).count(), 0);
  const build = await json("/plans", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Queue browser fixture" }),
  });
  for (const route of ["/production", `/export?profile=${build.id}`, `/progress?profile=${build.id}`]) {
    const queueResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/printer-checkoff" && response.request().method() === "GET",
      { timeout: 60000 },
    );
    await page.goto(`${ui}${route}`, { waitUntil: "domcontentloaded" });
    const response = await queueResponse;
    assert.equal(response.status(), 200);
    const query = new URL(response.url()).searchParams;
    assert.equal(query.has("state"), false);
    assert.equal(query.get("profile_id"), route === "/production" ? null : String(build.id));
  }
  console.log("PASS logging toggle, reload, capture pause/resume, and autosave help");
  console.log("PASS All Production, Production, and Checkoff read combined queues with the correct Build scope");
} finally {
  await browser.close();
  await setTracking(initial.enableWorkflowTracking);
}
