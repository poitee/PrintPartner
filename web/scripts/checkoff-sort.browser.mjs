/* global console */
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { browserExecutable } from "../apps/web/test/browser/browserExecutable.mjs";

// Requires the isolated plan-save-benchmark --serve backend and preview on 5176.
const browser = await chromium.launch({ executablePath: browserExecutable(), headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  await page.goto("http://127.0.0.1:5176/progress?profile=1");
  const sort = page.getByRole("combobox", { name: "Sort by" });
  await sort.waitFor();
  await page.getByRole("button", { name: "Preview 3D model of part-0-0.stl", exact: true }).waitFor();
  assert.match(await page.locator("body").innerText(), /Autosave benchmark/);
  const writes = [];
  page.on("request", (r) => {
    if (["PATCH", "POST", "PUT", "DELETE"].includes(r.method()) && /\/(plans|parts)\//.test(r.url()) && !/thumbnail/.test(r.url())) writes.push(r.url());
  });
  const names = () => page.locator('[aria-label="Checkoff worklist"]').getByRole("button", { name: /^Preview 3D model/ }).evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")));
  const manual = await names();
  const headings = () => page.locator('[aria-label="Checkoff worklist"]').getByRole("heading", { level: 3 }).allTextContents();
  assert.deepEqual(await headings(), []);
  await sort.selectOption("source");
  const sourceHeadings = await headings();
  assert.equal(sourceHeadings.length, 7);
  assert.equal(new Set(sourceHeadings).size, 7);
  assert.equal((await names())[10], "Preview 3D model of part-0-10.stl");
  assert.equal(await page.getByRole("button", { name: "Add bag", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: /^Move .* down/ }).count(), 0);
  await sort.selectOption("directory");
  assert.deepEqual(await headings(), ["Folder-0", "Folder-1", "Folder-2", "Folder-3", "Folder-4"]);
  assert.equal((await names())[10], "Preview 3D model of part-1-0.stl");
  assert.match(await page.locator(".sheet-repo-title").first().innerText(), /Folder-0\s*70/);
  await page.reload();
  await sort.waitFor();
  assert.equal(await sort.inputValue(), "directory");
  await page.setViewportSize({ width: 390, height: 844 });
  await sort.selectOption("source");
  await page.getByRole("searchbox", { name: "Search progress parts" }).fill("part-0-10.stl");
  assert.equal((await names()).length, 1);
  assert.deepEqual(await headings(), [sourceHeadings[0]]);
  await page.getByRole("searchbox", { name: "Search progress parts" }).fill("");
  await sort.selectOption("manual");
  assert.deepEqual(await names(), manual);
  assert.deepEqual(await headings(), []);
  await page.getByRole("button", { name: "Add bag", exact: true }).waitFor();
  assert.deepEqual(writes, []);
  console.log("PASS: source/directory order, print grouping, persistence, mobile search, manual restoration, no data writes");
} finally {
  await browser.close();
}
