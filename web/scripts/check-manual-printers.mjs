// Uses plan-save-benchmark.mts --serve on 5182 and Vite on 5176, proxying 5182.
import assert from "node:assert/strict";
import console from "node:console";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { chromium } from "playwright-core";
import { browserExecutable } from "../apps/web/test/browser/browserExecutable.mjs";

const browser = await chromium.launch({ executablePath: browserExecutable(), headless: true });
let createdPrinterId = null;
try {
  const page = await browser.newPage();
  const name = `Manual browser test ${randomUUID().slice(0, 8)}`;
  await page.goto("http://127.0.0.1:5176/plan?profile=1");
  await page.getByRole("heading", { name: /Autosave benchmark/ }).waitFor();
  await page.goto("http://127.0.0.1:5176/settings#printers");
  const choice = page.getByRole("checkbox", { name: "Connect to this printer", exact: true });
  await choice.waitFor();
  assert.equal(await choice.getAttribute("aria-checked"), "false");
  await page.locator("#printers").getByLabel("Name", { exact: true }).fill(name);
  const createdResponse = page.waitForResponse((res) => new URL(res.url()).pathname === "/printers" && res.request().method() === "POST");
  await page.getByRole("button", { name: "Add printer", exact: true }).click();
  const created = await createdResponse;
  assert.equal(created.status(), 200);
  const printer = await created.json();
  createdPrinterId = printer.id;
  assert.ok(!printer.integration_id);
  await page.getByText(`${name} added for manual use. No printer connection is enabled.`).waitFor();
  const forbidden = [];
  await page.route("**/api/v1/integrations**", async (route) => {
    forbidden.push(new URL(route.request().url()).pathname);
    await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Authentication required" }) });
  });
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.includes("reconcile")) forbidden.push(new URL(request.url()).pathname);
  });
  await page.goto("http://127.0.0.1:5176/progress?profile=1");
  await page.getByRole("heading", { name: "Print records", exact: true }).waitFor();
  await page.getByRole("button", { name: "Add a past print", exact: true }).waitFor();
  await page.waitForTimeout(1500);
  assert.deepEqual(forbidden, [], "manual Checkoff must not query connections or reconcile printers");
  assert.ok(!(await page.locator("body").innerText()).includes("Authentication required"));
  await page.goto("http://127.0.0.1:5176/printers");
  await page.getByText(name, { exact: true }).waitFor();
  await page.waitForTimeout(500);
  assert.deepEqual(forbidden, [], "manual printer desk must not query connections");
  console.log(JSON.stringify({ passed: true, printerId: printer.id, integrationRequests: forbidden.length }));
} finally {
  try {
    if (createdPrinterId != null) {
      const cleanupPage = await browser.newPage();
      const cleanupResponse = await cleanupPage.request.delete(
        `http://127.0.0.1:5176/printers/${encodeURIComponent(createdPrinterId)}`,
      );
      assert.equal(cleanupResponse.status(), 204);
      await cleanupPage.close();
    }
  } finally {
    await browser.close();
  }
}
