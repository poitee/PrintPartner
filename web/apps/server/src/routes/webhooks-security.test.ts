import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildApp } from "../app.js";
import { createSelfHostPorts } from "../adapters/self-host/index.js";
import { loadConfig } from "../config.js";

describe("webhook route security", () => {
  it("omits signing secrets from webhook listings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-webhooks-redaction-"));
    const config = { ...loadConfig(), dataDir: dir };
    const ports = createSelfHostPorts(dir);
    await ports.db.connect();
    ports.repository.setSetting(
      "integration_webhooks_v1",
      JSON.stringify([
        {
          id: "wh-test",
          url: "https://example.com/hook",
          events: ["job.done"],
          secret: "super-secret",
          created_at: new Date(0).toISOString(),
        },
      ]),
    );
    const app = await buildApp(config, ports);

    try {
      const response = await app.inject({ method: "GET", url: "/api/v1/webhooks" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        webhooks: [
          {
            id: "wh-test",
            url: "https://example.com/hook",
            events: ["job.done"],
            created_at: new Date(0).toISOString(),
          },
        ],
      });
    } finally {
      await app.close();
      ports.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
