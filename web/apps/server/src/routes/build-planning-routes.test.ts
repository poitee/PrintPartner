import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSelfHostPorts } from "../adapters/self-host/index.js";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { newBuildPlanningBrief, saveBuildPlanningBrief } from "../services/build-planning.js";

describe("Build planning routes", () => {
  const roots: string[] = [];

  afterEach(() => {
    delete process.env.PRINT_PARTNER_DATA_DIR;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("returns hydrated planning state while legacy Builds return null", async () => {
    const root = mkdtempSync(join(tmpdir(), "build-planning-route-"));
    roots.push(root);
    process.env.PRINT_PARTNER_DATA_DIR = root;
    const ports = createSelfHostPorts(root);
    await ports.db.connect();
    const app = await buildApp(loadConfig(), ports);
    const planned = ports.repository!.createProfile("AI planned");
    const legacy = ports.repository!.createProfile("Legacy");
    saveBuildPlanningBrief(
      ports.repository!,
      newBuildPlanningBrief(planned.id, "Print the linked project", [
        "https://www.printables.com/model/123-widget",
      ]),
    );

    const response = await app.inject({ method: "GET", url: `/plans/${planned.id}/build-planning` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      planning: expect.objectContaining({
        grouped_difference_count: 0,
        difference_count: 0,
        readiness: expect.objectContaining({ ready: false }),
        brief: expect.objectContaining({ special_request: "Print the linked project" }),
      }),
    });

    const legacyResponse = await app.inject({ method: "GET", url: `/plans/${legacy.id}/build-planning` });
    expect(legacyResponse.json()).toEqual({ planning: null });
    await app.close();
    await ports.db.close();
  });
});
