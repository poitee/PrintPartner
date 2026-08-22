import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildApp } from "../app.js";
import { createSelfHostPorts } from "../adapters/self-host/index.js";
import { loadConfig } from "../config.js";
import type { MetricsDeps } from "./metrics.js";

type Assert<T extends true> = T;
type MetricsValidatorIsRequired = Assert<
  undefined extends MetricsDeps["validateApiKey"] ? false : true
>;
const metricsValidatorIsRequired: MetricsValidatorIsRequired = true;

describe("metrics authentication", () => {
  it("requires callers to provide an API key validator", () => {
    expect(metricsValidatorIsRequired).toBe(true);
  });

  it("rejects an invalid bearer credential", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-metrics-auth-"));
    const config = {
      ...loadConfig(),
      dataDir: dir,
      integrationApiKey: "valid-metrics-key",
    };
    const ports = createSelfHostPorts(dir);
    await ports.db.connect();
    const app = await buildApp(config, ports);

    try {
      const response = await app.inject({
        method: "GET",
        url: "/metrics",
        headers: { authorization: "Bearer garbage" },
      });

      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
      ports.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports the configured application version", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-metrics-version-"));
    const config = {
      ...loadConfig(),
      dataDir: dir,
      version: "9.8.7-test",
    };
    const ports = createSelfHostPorts(dir);
    await ports.db.connect();
    const app = await buildApp(config, ports);

    try {
      const response = await app.inject({ method: "GET", url: "/metrics" });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('app_info{version="9.8.7-test"');
      expect(response.body).not.toContain('app_info{version="3.1.0"');
    } finally {
      await app.close();
      ports.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
