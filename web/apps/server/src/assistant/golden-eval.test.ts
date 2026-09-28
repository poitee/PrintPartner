import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSelfHostPorts } from "../adapters/self-host/index.js";
import { GOLDEN_EVAL_FIXTURES } from "./golden-eval.fixtures.js";
import { invokeAssistantTool } from "./tools.js";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../test-fixtures/kit-workspace",
);

describe("golden kit-advisor evals (no live LLM)", () => {
  let dataDir: string;
  let repo: NonNullable<ReturnType<typeof createSelfHostPorts>["repository"]>;
  let planId: number;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "pp-ai-golden-"));
    const ports = createSelfHostPorts(dataDir);
    await ports.db.connect();
    repo = ports.repository!;

    repo.createSource({
      name: "Example-Printer",
      url: "https://example.com/example-printer.git",
      source_kind: "github",
    });
    const synced = repo.createSource({
      name: "SyncedKit",
      url: "https://example.com/synced.git",
      source_kind: "github",
    });
    repo.updateSource(synced.id, { last_synced_at: new Date().toISOString() });

    const unsynced = repo.createSource({
      name: "UnsyncedKit",
      url: "https://example.com/unsynced.git",
      source_kind: "github",
    });
    // Explicitly clear sync timestamp if any default appeared.
    repo.updateSource(unsynced.id, { last_synced_at: null });

    const plan = repo.createProfile("Golden plan", synced.id);
    planId = plan.id;
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  for (const fixture of GOLDEN_EVAL_FIXTURES) {
    it(`${fixture.id}: ${fixture.description}`, async () => {
      expect(fixture.expected_tool).toBeTruthy();
      const toolName = fixture.expected_tool!;
      const useOther =
        fixture.id === "respect-use-other-builds-off" ? false : true;

      const result = await invokeAssistantTool(
        toolName,
        { plan_id: planId, ...(fixture.tool_input ?? {}) },
        { repo, activePlanId: planId, useOtherBuildsAsExamples: useOther, dataDir: FIXTURE },
      );

      if (fixture.expect.proposes_action) {
        expect(result.proposedAction).toBeTruthy();
        if (fixture.expect.action_type) {
          expect(result.proposedAction?.type).toBe(fixture.expect.action_type);
        }
      } else {
        expect(result.proposedAction).toBeUndefined();
      }

      const lower = result.content.toLowerCase();
      for (const needle of fixture.expect.content_includes ?? []) {
        expect(lower).toContain(needle.toLowerCase());
      }
      for (const needle of fixture.expect.content_excludes ?? []) {
        expect(lower).not.toContain(needle.toLowerCase());
      }

      if (fixture.expect.error) {
        const parsed = JSON.parse(result.content) as { error?: string };
        expect(parsed.error).toBeTruthy();
      }
    });
  }

});
