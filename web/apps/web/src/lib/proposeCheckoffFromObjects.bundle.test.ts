import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "../..");

describe("proposeCheckoffFromObjects browser bundle", () => {
  it("does not pull Node filesystem APIs into the Checkoff client", async () => {
    const result = await build({
      absWorkingDir: webRoot,
      entryPoints: [path.join(here, "proposeCheckoffFromObjects.ts")],
      bundle: true,
      write: false,
      platform: "browser",
      format: "esm",
      logLevel: "silent",
    });
    const code = result.outputFiles.map((file) => file.text).join("\n");
    expect(code).not.toMatch(/node:fs/);
    expect(code).not.toMatch(/readdirSync/);
  });
});
