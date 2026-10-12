import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSelfHostPorts } from "../adapters/self-host/index.js";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { getDb } from "../db/client.js";
import { AppRepository } from "../db/repository.js";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pp-variant-route-"));
  const ports = createSelfHostPorts(root);
  await ports.db.connect();
  const repo = ports.repository!;
  const source = repo.createSource({ name: "Variant base", source_kind: "local" });
  const addon = repo.createSource({ name: "Variant addon", source_kind: "local" });
  const sourceRoot = join(ports.reposDir, String(source.id));
  mkdirSync(sourceRoot, { recursive: true });
  writeFileSync(join(sourceRoot, "print-partner.manifest.yaml"), "variant_dimensions:\n  size: [250, 300]\n");
  const plan = repo.createProfile("Variants", source.id);
  repo.addAddonLayer(plan.id, addon.id);
  repo.setSetting(`plan_variant_selection_${plan.id}`, '{"size":"250"}');
  repo.updateImportRules(source.id, ["250/"]);
  repo.updateImportRules(addon.id, ["addon/"]);
  const app = await buildApp({ ...loadConfig(), dataDir: root }, ports);
  return { root, ports, repo, source, addon, plan, app };
}

describe("Plan variant selection HTTP boundary", () => {
  let context: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => { context = await fixture(); });
  afterEach(async () => {
    await context.app.close();
    await context.ports.db.close();
    rmSync(context.root, { recursive: true, force: true });
  });

  it.each([false, true])("saves and reads a valid selection with explicit Source %s", async (explicitSource) => {
    const { app, plan, source } = context;
    const response = await app.inject({ method: "POST", url: `/plans/${plan.id}/variant-selection`, payload: {
      selection: { size: "300" }, ...(explicitSource ? { source_id: source.id } : {}),
    } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ profile_id: plan.id, source_id: source.id, selection: { size: "300" }, rules: ["300/"] });
    const read = await app.inject({ method: "GET", url: `/plans/${plan.id}/variant-dimensions` });
    expect(read.json()).toEqual({ profile_id: plan.id, source_id: source.id, dimensions: { size: [250, 300] }, selection: { size: "300" } });
  });

  it.each([
    { selection: { size: "bad" } }, { selection: { unknown: "300" } },
    { selection: [] }, { selection: "300" }, { selection: null },
    { selection: { size: 300 } }, { selection: { size: ["300"] } },
    { selection: { size: "300" }, source_id: "1" },
    { selection: { size: "300" }, source_id: null },
  ])("rejects invalid payload %j without side effects", async (payload) => {
    const { app, repo, plan, source, addon } = context;
    const response = await app.inject({ method: "POST", url: `/plans/${plan.id}/variant-selection`, payload });
    expect(response.statusCode).toBe(400);
    expect(repo.getSetting(`plan_variant_selection_${plan.id}`)).toBe('{"size":"250"}');
    expect(repo.getProjectRow(source.id)?.importedPaths).toBe('["250/"]');
    expect(repo.getProjectRow(addon.id)?.importedPaths).toBe('["addon/"]');
  });

  it("rejects the add-on source and preserves the prior selection", async () => {
    const { app, repo, plan, source, addon } = context;
    const response = await app.inject({ method: "POST", url: `/plans/${plan.id}/variant-selection`, payload: { selection: { size: "300" }, source_id: addon.id } });
    expect(response.statusCode).toBe(400);
    expect(repo.getSetting(`plan_variant_selection_${plan.id}`)).toBe('{"size":"250"}');
    expect(repo.getProjectRow(source.id)?.importedPaths).toBe('["250/"]');
    expect(repo.getProjectRow(addon.id)?.importedPaths).toBe('["addon/"]');
  });

  it("rejects a Plan without a base source", async () => {
    const { app, repo } = context;
    const plan = repo.createProfile("No base");
    const response = await app.inject({ method: "POST", url: `/plans/${plan.id}/variant-selection`, payload: { selection: {} } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ detail: "No base source on plan" });
  });

  it("keeps another tenant's Plan inaccessible", async () => {
    const { app, ports } = context;
    const other = new AppRepository(getDb(ports.db.sqlite), "other", ports.reposDir);
    const plan = other.createProfile("Other tenant");
    const response = await app.inject({ method: "POST", url: `/plans/${plan.id}/variant-selection`, payload: { selection: {} } });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ detail: "Profile not found" });
  });
});
