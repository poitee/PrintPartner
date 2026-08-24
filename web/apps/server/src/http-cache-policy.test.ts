import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSelfHostPorts } from "./adapters/self-host/index.js";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

describe("dynamic HTTP cache policy", () => {
  const directories: string[] = [];

  afterEach(() => {
    delete process.env.PRINT_PARTNER_DATA_DIR;
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("marks API and authentication responses as private and non-cacheable", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pp-cache-policy-"));
    directories.push(directory);
    process.env.PRINT_PARTNER_DATA_DIR = directory;
    const ports = createSelfHostPorts(directory);
    await ports.db.connect();
    const app = await buildApp(loadConfig(), ports);

    try {
      const sources = await app.inject({ method: "GET", url: "/sources" });
      const auth = await app.inject({ method: "GET", url: "/auth/me" });

      expect(sources.headers["cache-control"]).toBe("private, no-store");
      expect(auth.headers["cache-control"]).toBe("private, no-store");
    } finally {
      await app.close();
      ports.db.close();
    }
  });
});
