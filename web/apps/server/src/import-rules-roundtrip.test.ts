import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildStlTreePayload } from "@print-partner/domain";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createSelfHostPorts } from "./adapters/self-host/index.js";

describe("import rules roundtrip", () => {
  it("PUT rules → GET rules → stl-tree selected count match", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-import-rules-"));
    process.env.PRINT_PARTNER_DATA_DIR = dir;
    const config = loadConfig();
    const ports = createSelfHostPorts(dir);
    await ports.db.connect();
    const repo = ports.repository!;

    const source = repo.createSource({ name: "RulesRepo", url: "https://github.com/a/b" });
    const repoPath = join(dir, "repos", String(source.id));
    mkdirSync(join(repoPath, "parts", "keep"), { recursive: true });
    mkdirSync(join(repoPath, "parts", "skip"), { recursive: true });
    writeFileSync(join(repoPath, "parts", "keep", "a.stl"), "solid a");
    writeFileSync(join(repoPath, "parts", "keep", "b.stl"), "solid b");
    writeFileSync(join(repoPath, "parts", "skip", "c.stl"), "solid c");
    repo.updateSource(source.id, { local_path: repoPath });

    const app = await buildApp(config, ports);

    const fullTree = buildStlTreePayload(repoPath, null);
    expect(fullTree.selected).toBe(3);

    const narrowed = ["parts/keep/"];
    const putRes = await app.inject({
      method: "PUT",
      url: `/sources/${source.id}/import-rules`,
      payload: { rules: narrowed },
    });
    expect(putRes.statusCode).toBe(200);
    const putBody = putRes.json() as { rules: string[] };
    expect(putBody.rules).toEqual(["parts/keep/"]);

    const getRes = await app.inject({
      method: "GET",
      url: `/sources/${source.id}/import-rules`,
    });
    expect(getRes.statusCode).toBe(200);
    const getBody = getRes.json() as { rules: string[]; legacy_import_all: boolean };
    expect(getBody.rules).toEqual(putBody.rules);
    expect(getBody.legacy_import_all).toBe(false);

    const treeRes = await app.inject({
      method: "GET",
      url: `/sources/${source.id}/stl-tree`,
    });
    expect(treeRes.statusCode).toBe(200);
    const treeBody = treeRes.json() as { total: number; selected: number };
    expect(treeBody.total).toBe(3);
    expect(treeBody.selected).toBe(2);

    await app.close();
    await ports.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
