import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createSelfHostPorts } from "./adapters/self-host/index.js";

async function makeApp(dir: string) {
  process.env.PRINT_PARTNER_DATA_DIR = dir;
  delete process.env.PRINT_PARTNER_API_KEY;
  const config = loadConfig();
  const ports = createSelfHostPorts(dir);
  await ports.db.connect();
  const app = await buildApp(config, ports);
  return { app, ports, repo: ports.repository };
}

describe("POST /plans/:id/layers", () => {
  afterEach(() => {
    delete process.env.PRINT_PARTNER_DATA_DIR;
  });

  it("returns 409 when the same source is already attached", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-layer-dup-"));
    const { app, ports, repo } = await makeApp(dir);

    const source = repo.createSource({ name: "BaseRepo", url: "https://github.com/a/base" });
    const repoPath = join(dir, "repos", String(source.id));
    mkdirSync(join(repoPath, "parts"), { recursive: true });
    writeFileSync(join(repoPath, "parts", "a.stl"), "solid");
    repo.updateSource(source.id, { local_path: repoPath });

    const plan = repo.createProfile("DupLayerPlan", source.id);

    const ok = await app.inject({
      method: "POST",
      url: `/plans/${plan.id}/layers`,
      payload: { project_id: source.id },
    });
    expect(ok.statusCode).toBe(409);
    expect((ok.json() as { detail?: string }).detail).toContain("already attached");

    await app.close();
    await ports.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
