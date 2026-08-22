import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const webRoot = resolve(import.meta.dirname, "../..");
const publicRoot = resolve(webRoot, "public");

describe("PWA icon assets", () => {
  it("provides every icon referenced by HTML and the web manifest", () => {
    const html = readFileSync(resolve(webRoot, "index.html"), "utf8");
    const manifest = JSON.parse(
      readFileSync(resolve(publicRoot, "manifest.json"), "utf8"),
    ) as { icons: Array<{ src: string }> };
    const favicon = html.match(
      /<link\s+rel=["']icon["'][^>]*href=["']([^"']+)["']/i,
    )?.[1];

    expect(favicon).toBeTruthy();
    const references = [favicon, ...manifest.icons.map((icon) => icon.src)];
    for (const reference of references) {
      expect(
        existsSync(resolve(publicRoot, String(reference).replace(/^\//, ""))),
        `missing public asset ${reference}`,
      ).toBe(true);
    }
  });
});
