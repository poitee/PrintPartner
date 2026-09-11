import assert from "node:assert/strict";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { log } from "node:console";
import { chromium } from "playwright-core";
import { zipSync, strToU8 } from "fflate";
import { BoxGeometry, Mesh, MeshBasicMaterial } from "three";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import { browserExecutable } from "./browserExecutable.mjs";

const api = process.env.PART_COLOR_API ?? "http://127.0.0.1:18769";
const ui = process.env.PART_COLOR_UI ?? "http://127.0.0.1:5179";
async function request(path, method = "GET", value) {
  const response = await globalThis.fetch(`${api}${path}`, { method, headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  const body = await response.json();
  assert.ok(response.ok, `${path}: ${JSON.stringify(body)}`);
  return body;
}
assert.ok((await request("/health")).data_dir.startsWith("/tmp/pp-part-colors-"), "Use an isolated fixture server");
const source = await request("/sources", "POST", { name: `Part colors ${randomUUID()}`, source_kind: "local" });
const geometry = new BoxGeometry(5, 6, 7);
const material = new MeshBasicMaterial();
const bytes = strToU8(new STLExporter().parse(new Mesh(geometry, material)));
geometry.dispose(); material.dispose();
const form = new globalThis.FormData();
form.append("file", new globalThis.Blob([zipSync({ "base.stl": bytes, "peer.stl": bytes, "[a]-cover.stl": bytes })]), "parts.zip");
const upload = await globalThis.fetch(`${api}/sources/${source.id}/upload-zip`, { method: "POST", body: form });
assert.ok(upload.ok, await upload.text());
const build = await request("/plans", "POST", { name: `Part colors ${randomUUID()}` });
await request(`/plans/${build.id}/layers/base`, "PUT", { project_id: source.id });
const { draft } = await request(`/plans/${build.id}/drafts/recompute`, "POST", { apply_manifest: true });
await request(`/plans/${build.id}/drafts/${draft.draft_id}/apply`, "POST", { expected_snapshot_digest: draft.snapshot_digest, expected_lifecycle_version: draft.lifecycle_version, expected_base: draft.base });
await request(`/plans/${build.id}/role-filament`, "PUT", { role: "primary", filament_custom_hex: "#112233" });
await request(`/plans/${build.id}/role-filament`, "PUT", { role: "accent", filament_custom_hex: "#aabbcc" });
const original = (await request(`/plans/${build.id}/parts`)).parts;
const target = original.find((part) => part.filename === "base.stl");
assert.ok(target);
const catalog = await request("/filaments/catalog");
const otherColor = catalog.colors[0];
assert.ok(otherColor);
const browser = await chromium.launch({ executablePath: browserExecutable(), headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${ui}/parts?profile=${build.id}`);
  async function openColor() {
    await page.getByRole("button", { name: "Change color for base.stl", exact: true }).click({ timeout: 60000 });
    await page.getByRole("dialog").getByRole("option", { name: /^accent:/ }).waitFor({ state: "attached" });
    return page.getByRole("dialog");
  }
  async function saveColor(dialog) {
    await dialog.getByRole("button", { name: "Save part color", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
  }
  let dialog = await openColor();
  assert.equal(await dialog.locator("optgroup").first().getAttribute("label"), "Build colors");
  const accent = await dialog.getByRole("option", { name: /^accent:/ }).getAttribute("value");
  await dialog.getByLabel("Part color", { exact: true }).selectOption(accent);
  await saveColor(dialog);
  assert.equal((await request(`/plans/${build.id}/parts`)).parts.find((part) => part.id === target.id).filament_hex, "#aabbcc");
  dialog = await openColor();
  await dialog.getByLabel("Part color", { exact: true }).selectOption(`catalog:${otherColor.id}`);
  await saveColor(dialog);
  assert.equal((await request(`/plans/${build.id}/parts`)).parts.find((part) => part.id === target.id).filament_color_id, otherColor.id);
  dialog = await openColor();
  await dialog.getByLabel("Part color", { exact: true }).selectOption("custom");
  await dialog.getByLabel("Hex color", { exact: true }).fill("bad hex");
  assert.equal(await dialog.getByRole("button", { name: "Save part color" }).isDisabled(), true);
  await dialog.getByLabel("Hex color", { exact: true }).fill("FF6600");
  await page.route(`**/parts/${target.id}`, async (route) => {
    if (route.request().method() === "PATCH") await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "Color save temporarily unavailable" }) });
    else await route.continue();
  });
  await dialog.getByRole("button", { name: "Save part color", exact: true }).click();
  await dialog.getByRole("alert").waitFor();
  assert.equal(await dialog.isVisible(), true);
  assert.equal((await request(`/plans/${build.id}/parts`)).parts.find((part) => part.id === target.id).filament_color_id, otherColor.id);
  await page.unroute(`**/parts/${target.id}`);
  await saveColor(dialog);
  await page.reload();
  dialog = await openColor();
  await dialog.getByText("Current color: #ff6600", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  const saved = (await request(`/plans/${build.id}/parts`)).parts;
  const roles = (await request(`/plans/${build.id}/role-filaments`)).roles;
  assert.equal(roles.find((role) => role.role === "primary").filament_hex, "#112233", "Individual changes must not replace the Build palette");
  for (const part of saved) {
    const before = original.find((item) => item.id === part.id);
    assert.equal(part.role, before.role);
    assert.equal(part.quantity_effective, before.quantity_effective);
    assert.equal(part.printed_count, before.printed_count);
    assert.equal(part.filament_hex, part.id === target.id ? "#ff6600" : before.filament_hex);
  }
  const invalid = await globalThis.fetch(`${api}/parts/${target.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filament_custom_hex: "not-a-color" }) });
  assert.equal(invalid.status, 400);
  await page.getByRole("button", { name: "Table", exact: true }).click();
  dialog = await openColor();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Change color for base.stl", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth > globalThis.innerWidth), false);
  await page.screenshot({ path: "/tmp/pp-part-color-mobile.png", fullPage: true });
  assert.deepEqual(errors, []);
  log("PASS: Build color, catalog color, custom hex, validation, reload persistence, unchanged peers/roles/quantities/progress, mobile dialog", { build: build.id });
} finally { await browser.close(); }
