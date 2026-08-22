import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSelfHostPorts } from "../adapters/self-host/index.js";
import {
  extractMentionedSourceNames,
  recoverProposedActionsFromText,
} from "./recover-proposals-from-text.js";

describe("extractMentionedSourceNames", () => {
  it("maps LDO / Leviathan / Trident R2 phrases to live names", () => {
    const live = ["Voron-Trident", "LDOVoronTrident", "Leviathan", "Voron-Stealthburner"];
    const got = extractMentionedSourceNames(
      "To add the LDO addons, Leviathan, and A4T to your Voron Trident R2 plan, use the following command:",
      live,
    );
    expect(got.base?.source_name).toBe("Voron-Trident");
    expect(got.base?.tag).toBe("VTr2");
    expect(got.addons).toContain("LDOVoronTrident");
    expect(got.addons).toContain("Leviathan");
    expect(got.addons).toContain("Voron-Stealthburner");
    expect(got.addons).not.toContain("A4T"); // not live
  });
});

describe("recoverProposedActionsFromText prose", () => {
  let dataDir: string;
  let repo: NonNullable<ReturnType<typeof createSelfHostPorts>["repository"]>;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "pp-recover-prose-"));
    const ports = createSelfHostPorts(dataDir);
    await ports.db.connect();
    repo = ports.repository!;
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("turns command narration into set_base / add_addon proposals", async () => {
    const base = repo.createSource({
      name: "Voron-Trident",
      url: "https://example.com/trident.git",
      source_kind: "github",
    });
    repo.updateSource(base.id, {
      last_synced_at: new Date().toISOString(),
      tag: "VTr1",
    });
    const ldo = repo.createSource({
      name: "LDOVoronTrident",
      url: "https://example.com/ldo.git",
      source_kind: "github",
    });
    repo.updateSource(ldo.id, { last_synced_at: new Date().toISOString() });
    const lev = repo.createSource({
      name: "Leviathan",
      url: "https://example.com/lev.git",
      source_kind: "github",
    });
    repo.updateSource(lev.id, { last_synced_at: new Date().toISOString() });
    const sb = repo.createSource({
      name: "Voron-Stealthburner",
      url: "https://example.com/sb.git",
      source_kind: "github",
    });
    repo.updateSource(sb.id, { last_synced_at: new Date().toISOString() });
    const plan = repo.createProfile("test", base.id);

    const content = `To add the LDO addons, Leviathan, and A4T to your Voron Trident R2 plan, you can use the following command:

print-partner add-addon LDOVoronTrident Leviathan a4t_toolhead
`;

    const { actions, cleanedContent } = await recoverProposedActionsFromText(content, {
      repo,
      activePlanId: plan.id,
    });

    expect(actions.some((a) => a.type === "set_base")).toBe(true);
    expect(actions.filter((a) => a.type === "add_addon").length).toBeGreaterThanOrEqual(2);
    expect(actions.some((a) => a.type === "start_sync")).toBe(true);
    expect(actions.some((a) => a.type === "start_recompute")).toBe(false);
    expect(cleanedContent).toMatch(/Apply cards/i);
    expect(cleanedContent).not.toMatch(/following command/i);
  });

  it("turns fake recipe JSON + Apply pitch into proposals", async () => {
    const base = repo.createSource({
      name: "Voron-Trident",
      url: "https://example.com/trident.git",
      source_kind: "github",
    });
    repo.updateSource(base.id, {
      last_synced_at: new Date().toISOString(),
      tag: "VTr1",
    });
    const ldo = repo.createSource({
      name: "LDOVoronTrident",
      url: "https://example.com/ldo.git",
      source_kind: "github",
    });
    repo.updateSource(ldo.id, { last_synced_at: new Date().toISOString() });
    const lev = repo.createSource({
      name: "Leviathan",
      url: "https://example.com/lev.git",
      source_kind: "github",
    });
    repo.updateSource(lev.id, { last_synced_at: new Date().toISOString() });
    const plan = repo.createProfile("test", base.id);

    const content = `Here is an example of what the build recipe might look like:
\`\`\`json
{
  "plan_id": ${plan.id},
  "base": { "source_name": "Voron-Trident", "tag": "VTr2", "branch": "main" },
  "addons": [
    {"source_name": "ldo_voron_trident"},
    {"source_name": "leviathan"},
    {"source_name": "a4t_toolhead"}
  ]
}
\`\`\`
To apply these settings, click on the "Apply" button in the UI.`;

    const { actions, cleanedContent } = await recoverProposedActionsFromText(content, {
      repo,
      activePlanId: plan.id,
    });

    expect(actions.some((a) => a.type === "set_base")).toBe(true);
    expect(actions.filter((a) => a.type === "add_addon").length).toBeGreaterThanOrEqual(1);
    expect(cleanedContent).toMatch(/Apply cards/i);
    expect(cleanedContent).not.toMatch(/click on the "Apply" button/i);
  });
});
