import process from "node:process";
import { expect, test } from "@playwright/test";

// No spec creates printers, and help has no stored data. The sidebar shows whichever Build
// another spec left active and the main column stretches to match it, so only the page
// content inside main is compared. Baselines come from the
// Linux fleet's Chrome; font rendering differs elsewhere.
test.skip(process.platform !== "linux", "Screenshot baselines are Linux only");

for (const [name, path, ready] of [
  ["help", "/help", "Choose parts, quantities, and colors. Changes save automatically"],
  ["printers", "/printers", "Printers"],
] as const) {
  test(`${name} page matches its baseline`, async ({ page }) => {
    await page.goto(path);
    await page.getByRole("heading", { name: ready, exact: true }).or(page.getByText(ready, { exact: true }))
      .first().waitFor({ timeout: 60_000 });
    await page.waitForLoadState("networkidle");
    await expect(page.locator("#main-content > :first-child")).toHaveScreenshot(`${name}.png`);
  });
}
