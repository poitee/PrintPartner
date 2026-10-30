// Ported from apps/web/test/browser/workflow-cleanup.browser.mjs.
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { api } from "./api";

type LoggingConfig = { enableWorkflowTracking: boolean };
type LoggingStats = { totalLogs: number };

test("workflow tracking toggle persists and pauses capture; queues keep Build scope", async ({ page }) => {
  const setTracking = (enabled: boolean) =>
    api<LoggingConfig>(page, "/settings/logging/config", "POST", { enableWorkflowTracking: enabled });
  const initial = await api<LoggingConfig>(page, "/settings/logging/config");
  try {
    await setTracking(true);
    await page.goto("/settings#data", { waitUntil: "domcontentloaded" });
    const toggle = page.getByRole("switch", { name: "Workflow Tracking", exact: true });
    await toggle.waitFor({ timeout: 60_000 });

    const toggleTo = async (enabled: boolean) => {
      const saved = page.waitForResponse((response) =>
        response.url().endsWith("/settings/logging/config") && response.request().method() === "POST");
      await toggle.evaluate((element: HTMLElement) => element.focus({ preventScroll: true }));
      await page.keyboard.press("Space");
      expect((await (await saved).json()).enableWorkflowTracking).toBe(enabled);
    };

    await toggleTo(false);
    await page.reload({ waitUntil: "domcontentloaded" });
    await toggle.waitFor({ timeout: 60_000 });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    const before = await api<LoggingStats>(page, "/settings/logging/stats");
    await api(page, "/health");
    expect((await api<LoggingStats>(page, "/settings/logging/stats")).totalLogs).toBe(before.totalLogs);
    await toggleTo(true);
    await api(page, "/health");
    expect((await api<LoggingStats>(page, "/settings/logging/stats")).totalLogs).toBeGreaterThan(before.totalLogs);

    await page.goto("/help", { waitUntil: "domcontentloaded" });
    await page.getByText("Choose parts, quantities, and colors. Changes save automatically", { exact: true })
      .waitFor({ timeout: 60_000 });
    await expect(page.getByText("Accept Working Plan", { exact: true })).toHaveCount(0);

    const build = await api<{ id: number }>(page, "/plans", "POST", { name: `Queue browser fixture ${randomUUID()}` });
    // Other specs leave Builds behind, and a page can read the last active Build's queue before
    // it applies ?profile=, so wait for the read with the expected scope.
    for (const route of ["/production", `/export?profile=${build.id}`, `/progress?profile=${build.id}`]) {
      const scope = route === "/production" ? null : String(build.id);
      const queueResponse = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === "/printer-checkoff" && response.request().method() === "GET"
          && url.searchParams.get("profile_id") === scope;
      }, { timeout: 60_000 });
      await page.goto(route, { waitUntil: "domcontentloaded" });
      const response = await queueResponse;
      expect(response.status()).toBe(200);
      expect(new URL(response.url()).searchParams.has("state")).toBe(false);
    }
  } finally {
    await setTracking(initial.enableWorkflowTracking);
  }
});
