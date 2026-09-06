// Run against the isolated plan-save-benchmark.mts --serve backend on 5182
// and Vite on 5176 with VITE_DEV_API_TARGET=http://127.0.0.1:5182.
/* global document */
import assert from "node:assert/strict";
import console from "node:console";
import { URL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { browserExecutable } from "../apps/web/test/browser/browserExecutable.mjs";

const browser = await chromium.launch({ executablePath: browserExecutable(), headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1193, height: 1122 } });
  const errors = [];
  const screenshots = await mkdtemp(join(tmpdir(), "pp-quantities-"));
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://127.0.0.1:5176/plan?profile=1");
  const input = page.getByRole("spinbutton", { name: "Quantity for part-0-0.stl", exact: true });
  await input.waitFor();
  assert.match(await page.locator("body").innerText(), /Autosave benchmark/);
  const original = Number(await input.inputValue());
  let saves = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/plans/1/save") saves++;
  });
  async function confirmed(expected) {
    await page.waitForFunction((quantity) =>
      document.querySelector('[role="status"]')?.textContent === "Saved" &&
      document.querySelector('input[aria-label="Quantity for part-0-0.stl"]')?.value === String(quantity), expected);
    assert.equal(await page.getByRole("alert").count(), 0);
  }
  async function save(action, expected) {
    const response = page.waitForResponse((res) =>
      res.request().method() === "POST" && new URL(res.url()).pathname === "/plans/1/save");
    await action();
    const result = await response;
    assert.equal(result.status(), 200);
    const body = await result.json();
    const savedPart = body.review.part_groups.flatMap((group) => group.parts)
      .find((part) => part.filename === "part-0-0.stl");
    assert.equal(savedPart.quantity_effective, expected);
    await confirmed(expected);
  }
  await confirmed(original);
  await input.fill("24");
  await page.waitForTimeout(400);
  assert.equal(saves, 0, "typing must not save intermediate numbers");
  await save(() => input.press("Enter"), 24);
  assert.equal(saves, 1);
  await page.route("**/plans/1/save", async (route) => {
    const response = await route.fetch();
    await delay(1000);
    await route.fulfill({ response });
  }, { times: 1 });
  const request = page.waitForRequest((req) => req.method() === "POST" && new URL(req.url()).pathname === "/plans/1/save");
  const saving = save(() => page.getByRole("button", { name: "Increase quantity for part-0-0.stl", exact: true }).click(), 25);
  await request;
  const otherInput = page.getByRole("spinbutton", { name: "Quantity for part-0-1.stl", exact: true });
  await otherInput.fill("9");
  await saving;
  assert.equal(await otherInput.inputValue(), "9", "another save must not erase active typing");
  await otherInput.press("Escape");
  await save(() => page.getByRole("button", { name: "Decrease quantity for part-0-0.stl", exact: true }).click(), 24);
  await input.fill("12");
  await save(() => input.press("Tab"), 12);
  await page.reload();
  await confirmed(12);
  await input.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(screenshots, "desktop.png") });
  await page.getByRole("button", { name: "Table", exact: true }).click();
  await input.fill("7");
  await save(() => input.press("Enter"), 7);
  await page.reload();
  await confirmed(7);
  await page.setViewportSize({ width: 390, height: 844 });
  await input.fill("6");
  await save(() => page.getByRole("button", { name: "Decrease quantity for part-0-0.stl", exact: true }).click(), 5);
  await page.reload();
  await confirmed(5);
  await input.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(screenshots, "mobile.png") });
  const beforeInvalid = saves;
  await input.fill("1.5");
  await input.press("Tab");
  assert.equal(await input.getAttribute("aria-invalid"), "true");
  assert.equal(saves, beforeInvalid);
  await input.focus();
  await input.press("Escape");
  assert.equal(await input.inputValue(), "5");
  await input.fill(String(original));
  await save(() => input.press("Enter"), original);
  await page.reload();
  await confirmed(original);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, saves, originalRestored: original, layouts: ["grid", "table", "mobile"], screenshots }));
} finally {
  await browser.close();
}
