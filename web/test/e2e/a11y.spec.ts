import { writeFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { test } from "@playwright/test";

// Report only: violations go to the report and never fail the run.
for (const path of ["/builds", "/help", "/settings"]) {
  test(`axe report for ${path}`, async ({ page }, testInfo) => {
    await page.goto(path);
    await page.locator("#main-content").waitFor({ timeout: 60_000 });
    const results = await new AxeBuilder({ page }).analyze();
    const summary = results.violations.map((violation) => ({
      id: violation.id, impact: violation.impact, nodes: violation.nodes.length, help: violation.help,
    }));
    const file = testInfo.outputPath("axe.json");
    writeFileSync(file, JSON.stringify(results, null, 2));
    await testInfo.attach(`axe ${path}`, { path: file, contentType: "application/json" });
    testInfo.annotations.push({ type: "axe", description: `${path}: ${summary.length} violation types` });
    console.log(`axe ${path}: ${JSON.stringify(summary)}`);
  });
}
