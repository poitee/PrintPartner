import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { browserExecutable } from "../apps/web/test/browser/browserExecutable.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Run against the isolated plan-save-benchmark --serve fixture, never a live Build.
const browser = await chromium.launch({ executablePath: browserExecutable(), headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  await page.goto("http://127.0.0.1:5176/plan?profile=1");
  await page.getByRole("heading", { name: "Plan", exact: true }).waitFor();
  await page.getByRole("combobox", { name: "Select Build" }).waitFor();
  await page.waitForFunction(() => document.body.innerText.includes("Autosave benchmark"));
  assert.match(await page.locator("body").innerText(), /Autosave benchmark/);
  const fixture = await (await fetch("http://127.0.0.1:5182/plans/1/review")).json();
  assert.match(fixture.plan_name, /Autosave benchmark/);
  const target = fixture.part_groups.flatMap((group) => group.parts).find((part) => part.filename === "part-0-0.stl");
  assert.ok(target);
  const reset = await fetch(`http://127.0.0.1:5182/parts/${target.id}/progress`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ unit_index: 0, completed: false }),
  });
  assert.equal(reset.status, 200);
  await page.getByRole("button", { name: "Table", exact: true }).click();
  await page.getByRole("spinbutton", { name: "Quantity for part-0-0.stl", exact: true }).fill("4");
  await page.getByText("Saved", { exact: true }).waitFor();
  await page.goto("http://127.0.0.1:5176/progress?profile=1");
  const name = "All copies printed for part-0-0.stl";
  const all = page.getByRole("checkbox", { name, exact: true });
  await all.waitFor();
  await page.screenshot({ path: join(tmpdir(), "pp-all-copies-desktop.png") });
  const requests = [];
  page.on("request", (request) => {
    if (request.method() === "PATCH" && /\/parts\/\d+\/progress$/.test(request.url())) requests.push(request.postDataJSON());
  });
  async function clickAndSave(control, expected) {
    const responsePromise = page.waitForResponse((r) => r.request().method() === "PATCH" && /\/parts\/\d+\/progress$/.test(r.url()));
    await control.click();
    const response = await responsePromise;
    assert.equal(response.status(), 200);
    assert.deepEqual((await response.json()).print_units, expected);
  }
  await clickAndSave(page.getByRole("button", { name: /^Mark one part-0-0.stl printed/ }), [true, false, false, false]);
  await page.waitForFunction((label) => document.querySelector(`[aria-label="${label}"]`)?.getAttribute("aria-checked") === "mixed", name);
  await clickAndSave(all, [true, true, true, true]);
  assert.deepEqual(requests.at(-1), { unit_index: 3, completed: true });
  await page.getByRole("button", { name: /^Completed/ }).click();
  await all.waitFor();
  await page.reload();
  await all.waitFor();
  assert.equal(await all.getAttribute("aria-checked"), "true");
  await page.setViewportSize({ width: 390, height: 844 });
  await clickAndSave(all, [false, false, false, false]);
  assert.deepEqual(requests.at(-1), { unit_index: 0, completed: false });
  await page.getByRole("button", { name: /^Remaining/ }).click();
  await all.waitFor();
  await page.reload();
  await all.waitFor();
  assert.equal(await all.getAttribute("aria-checked"), "false");
  assert.equal(await page.getByRole("checkbox", { name: "All copies printed for part-0-1.stl", exact: true }).getAttribute("aria-checked"), "false");
  assert.equal(requests.length, 3);
  await page.route("**/parts/*/progress", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Test save failure" }) }));
  await all.click();
  await page.getByRole("button", { name: /Retry/ }).first().waitFor();
  assert.equal(await all.getAttribute("aria-checked"), "false");
  await page.unroute("**/parts/*/progress");
  await page.reload();
  await all.waitFor();
  await page.locator("article").filter({ has: all }).screenshot({ path: join(tmpdir(), "pp-all-copies-mobile.png") });
  console.log("PASS: desktop partial/all, mobile clear-all, persisted reloads, other part unchanged, one request per action, failed save rollback with visible retry");
} finally {
  await browser.close();
}
