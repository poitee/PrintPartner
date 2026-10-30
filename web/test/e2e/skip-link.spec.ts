// Ported from apps/web/test/browser/skip-link.browser.mjs, which checks a harness page;
// this runs against the real app shell served by pp-server.
import { expect, test } from "@playwright/test";

test("skip link stays hidden until focused, then shows and jumps to main", async ({ page }) => {
  await page.goto("/builds");
  const skipLink = page.getByRole("link", { name: "Skip to main content" });
  const style = () =>
    skipLink.evaluate((element) => {
      const computed = element.ownerDocument.defaultView!.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return { clip: computed.clip, clipPath: computed.clipPath, position: computed.position,
        width: rect.width, height: rect.height, left: rect.left, top: rect.top };
    });

  const initial = await style();
  expect(initial.width).toBe(1);
  expect(initial.height).toBe(1);
  expect(initial.clip.includes("rect(0px") || initial.clipPath.includes("inset(50%)")).toBe(true);

  await skipLink.focus();
  const focused = await style();
  expect(focused.position).toBe("fixed");
  expect(focused.width).toBeGreaterThan(100);
  expect(focused.height).toBeGreaterThan(20);
  expect(focused.left).toBeGreaterThanOrEqual(0);
  expect(focused.top).toBeGreaterThanOrEqual(0);
  expect(focused.clip).toBe("auto");
  expect(focused.clipPath).toBe("none");

  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#main-content$/);
});
