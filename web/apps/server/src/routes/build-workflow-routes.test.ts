import { parseBuildWorkflowWorkspace } from "@print-partner/contracts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSelfHostPorts } from "../adapters/self-host/index.js";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";

describe("Build Workflow routes", () => {
  const roots: string[] = [];

  afterEach(() => {
    delete process.env.PRINT_PARTNER_DATA_DIR;
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("projects one shared next action and the Prepare and Make groups", async () => {
    const root = mkdtempSync(join(tmpdir(), "build-workflow-route-"));
    roots.push(root);
    process.env.PRINT_PARTNER_DATA_DIR = root;
    const ports = createSelfHostPorts(root);
    await ports.db.connect();
    const app = await buildApp(loadConfig(), ports);

    try {
      const build = ports.repository.createProfile("Clockwork Dragon");
      const response = await app.inject({
        method: "GET",
        url: `/plans/${build.id}/workflow`,
      });

      expect(response.statusCode).toBe(200);
      const workspace = parseBuildWorkflowWorkspace(response.json());
      expect(workspace.build).toEqual({
        id: build.id,
        name: "Clockwork Dragon",
      });
      expect(workspace.stages.map(({ id, group }) => ({ id, group }))).toEqual([
        { id: "sources", group: "prepare" },
        { id: "plan", group: "prepare" },
        { id: "production", group: "make" },
        { id: "checkoff", group: "make" },
      ]);
      expect(workspace.next_action.kind).toBe("attach_sources");
    } finally {
      await app.close();
      await ports.db.close();
    }
  });

  it("returns not found for an unknown Build", async () => {
    const root = mkdtempSync(join(tmpdir(), "build-workflow-missing-"));
    roots.push(root);
    process.env.PRINT_PARTNER_DATA_DIR = root;
    const ports = createSelfHostPorts(root);
    await ports.db.connect();
    const app = await buildApp(loadConfig(), ports);

    try {
      const response = await app.inject({
        method: "GET",
        url: "/plans/999/workflow",
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
      await ports.db.close();
    }
  });
});
