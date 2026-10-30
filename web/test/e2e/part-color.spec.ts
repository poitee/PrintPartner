// Ported from apps/web/test/browser/part-color.browser.mjs. The STL comes from the Rust
// fixtures and goes through upload-files instead of a zip.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import process from "node:process";
import { expect, test } from "@playwright/test";
import { api } from "./api";

type Part = { id: number; filename: string; role: string; quantity_effective: number; printed_count: number;
  filament_hex: string | null; filament_color_id: number | null; spoolman_spool_id: string | null };
type Draft = { draft_id: string; snapshot_digest: string; lifecycle_version: number; base: unknown };

const stl = readFileSync(new URL("../../../rust/tests/fixtures/part.stl", import.meta.url));

test("part color: Build color, catalog color, custom hex, validation, persistence, mobile dialog", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const source = await api<{ id: number }>(page, "/sources", "POST", { name: `Part colors ${randomUUID()}`, source_kind: "local" });
  const names = ["base.stl", "peer.stl", "[a]-cover.stl"];
  const form = new FormData();
  for (const name of names) form.append("files", new File([stl], name));
  form.append("relative_paths", JSON.stringify(names));
  const origin = process.env.PP_SERVER_URL!;
  const upload = await page.request.post(`${origin}/sources/${source.id}/upload-files`, {
    headers: { Origin: origin }, multipart: form,
  });
  expect(upload.ok(), await upload.text()).toBe(true);

  const build = await api<{ id: number }>(page, "/plans", "POST", { name: `Part colors ${randomUUID()}` });
  await api(page, `/plans/${build.id}/layers/base`, "PUT", { project_id: source.id });
  const { draft } = await api<{ draft: Draft }>(page, `/plans/${build.id}/drafts/recompute`, "POST", { apply_manifest: true });
  await api(page, `/plans/${build.id}/drafts/${draft.draft_id}/apply`, "POST", {
    expected_snapshot_digest: draft.snapshot_digest, expected_lifecycle_version: draft.lifecycle_version, expected_base: draft.base,
  });
  await api(page, `/plans/${build.id}/role-filament`, "PUT", { role: "primary", filament_custom_hex: "#112233" });
  await api(page, `/plans/${build.id}/role-filament`, "PUT", { role: "accent", filament_custom_hex: "#aabbcc" });
  const parts = async () => (await api<{ parts: Part[] }>(page, `/plans/${build.id}/parts`)).parts;
  const original = await parts();
  const target = original.find((part) => part.filename === "base.stl")!;
  expect(target).toBeTruthy();
  const current = async () => (await parts()).find((part) => part.id === target.id)!;
  const otherColor = (await api<{ colors: { id: number; hex: string; combo_label: string }[] }>(page, "/filaments/catalog")).colors[0];
  expect(otherColor).toBeTruthy();

  await page.goto(`/parts?profile=${build.id}`);
  const openColor = async () => {
    await page.getByRole("button", { name: "Change color for base.stl", exact: true }).click({ timeout: 60_000 });
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("option", { name: /^accent:/ }).waitFor({ state: "attached" });
    return dialog;
  };
  const saveColor = async (dialog: ReturnType<typeof page.getByRole>) => {
    await dialog.getByRole("button", { name: "Save part color", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
  };

  let dialog = await openColor();
  await expect(dialog.locator("optgroup").first()).toHaveAttribute("label", "Build colors");
  const accent = await dialog.getByRole("option", { name: /^accent:/ }).getAttribute("value");
  await dialog.getByLabel("Part color", { exact: true }).selectOption(accent!);
  await saveColor(dialog);
  expect((await current()).filament_hex).toBe("#aabbcc");

  dialog = await openColor();
  await dialog.getByLabel("Part color", { exact: true }).selectOption(`catalog:${otherColor.id}`);
  await saveColor(dialog);
  expect((await current()).filament_color_id).toBe(otherColor.id);

  dialog = await openColor();
  await dialog.getByLabel("Part color", { exact: true }).selectOption("custom");
  await dialog.getByLabel("Hex color", { exact: true }).fill("bad hex");
  await expect(dialog.getByRole("button", { name: "Save part color" })).toBeDisabled();
  await dialog.getByLabel("Hex color", { exact: true }).fill("FF6600");
  await page.route(`**/parts/${target.id}`, async (route) => {
    if (route.request().method() === "PATCH") {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "Color save temporarily unavailable" }) });
    } else await route.continue();
  });
  await dialog.getByRole("button", { name: "Save part color", exact: true }).click();
  await dialog.getByRole("alert").waitFor();
  await expect(dialog).toBeVisible();
  expect((await current()).filament_color_id).toBe(otherColor.id);
  await page.unroute(`**/parts/${target.id}`);
  await saveColor(dialog);
  await page.reload();
  dialog = await openColor();
  await dialog.getByText("Current color: #ff6600", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

  const saved = await parts();
  const roles = (await api<{ roles: { role: string; filament_hex: string }[] }>(page, `/plans/${build.id}/role-filaments`)).roles;
  expect(roles.find((role) => role.role === "primary")!.filament_hex, "Individual changes must not replace the Build palette").toBe("#112233");
  for (const part of saved) {
    const before = original.find((item) => item.id === part.id)!;
    expect(part.role).toBe(before.role);
    expect(part.quantity_effective).toBe(before.quantity_effective);
    expect(part.printed_count).toBe(before.printed_count);
    expect(part.filament_hex).toBe(part.id === target.id ? "#ff6600" : before.filament_hex);
  }
  for (const body of [
    { filament_custom_hex: "not-a-color" },
    { quantity_override: 99 },
    { included: false },
    { filament_custom_hex: "#ffffff", included: false },
    { filament_color_id: otherColor.id, filament_custom_hex: "#ffffff" },
  ]) {
    const invalid = await page.request.patch(`${origin}/parts/${target.id}`, { headers: { Origin: origin }, data: body });
    expect(invalid.status(), JSON.stringify(body)).toBe(400);
  }
  expect(await parts()).toEqual(saved);

  await api(page, `/parts/${target.id}`, "PATCH", { filament_color_id: otherColor.id, spoolman_spool_id: "spoolman:gre747:spool:5" });
  await page.reload();
  dialog = await openColor();
  await dialog.getByText(`Current color: ${otherColor.combo_label}`, { exact: true }).waitFor();
  await dialog.getByLabel("Part color", { exact: true }).selectOption("custom");
  await expect(dialog.getByLabel("Hex color", { exact: true })).toHaveValue(otherColor.hex);
  expect((await current()).spoolman_spool_id).toBe("spoolman:gre747:spool:5");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

  await page.getByRole("button", { name: "Table", exact: true }).click();
  dialog = await openColor();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  const colorButtons = page.getByRole("button", { name: "Change color for base.stl", exact: true });
  const mobileColorButton = page.locator(".checkoff-mobile-card").getByRole("button", { name: "Change color for base.stl", exact: true });
  await mobileColorButton.waitFor({ state: "visible" });
  await expect(colorButtons).toHaveCount(1);
  await page.evaluate(() => globalThis.dispatchEvent(new Event("beforeprint")));
  await page.emulateMedia({ media: "print" });
  await page.locator(".checkoff-print-table").getByRole("button", { name: "Change color for base.stl", exact: true }).waitFor({ state: "visible" });
  await expect(colorButtons).toHaveCount(1);
  await page.emulateMedia({ media: "screen" });
  await page.evaluate(() => globalThis.dispatchEvent(new Event("afterprint")));
  await mobileColorButton.waitFor({ state: "visible" });
  await expect(colorButtons).toHaveCount(1);
  await mobileColorButton.click();
  await page.getByRole("dialog").waitFor();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  expect(errors).toEqual([]);
});
