import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSelfHostPorts } from "../adapters/self-host/index.js";
import { GOLDEN_EVAL_FIXTURES } from "./golden-eval.fixtures.js";
import { invokeAssistantTool } from "./tools.js";
import { runAssistantTurn } from "./tool-loop.js";
import type { AssistantPort } from "./types.js";

describe("golden kit-advisor evals (no live LLM)", () => {
  let dataDir: string;
  let repo: NonNullable<ReturnType<typeof createSelfHostPorts>["repository"]>;
  let planId: number;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "pp-ai-golden-"));
    const ports = createSelfHostPorts(dataDir);
    await ports.db.connect();
    repo = ports.repository!;

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
        { repo, activePlanId: planId, useOtherBuildsAsExamples: useOther },
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

  it("tool-loop surfaces apply_stack_preset as a proposed action (mocked port)", async () => {
    const mock: AssistantPort = {
      provider: "openai",
      model: "mock",
      configured: true,
      supportsTools: true,
      async complete() {
        return "";
      },
      async stream(_p, h) {
        h.onDone();
      },
      async completeWithTools(params) {
        if (params.messages.some((m) => m.role === "tool")) {
          return {
            content:
              "I recommend the Voron 2.4 stock + Stealthburner + Tap stack preset.",
            toolCalls: [],
            stopReason: "end_turn",
          };
        }
        return {
          content: "",
          toolCalls: [
            {
              id: "call_1",
              name: "apply_stack_preset",
              input: { plan_id: planId, preset_id: "voron_2.4_stock_sb_tap" },
            },
          ],
          stopReason: "tool_use",
        };
      },
    };

    const turn = await runAssistantTurn({
      assistant: mock,
      system: "You are a kit advisor.",
      messages: [
        {
          role: "user",
          content: "Recommend a known stack preset for stock 2.4 + SB + Tap",
        },
      ],
      model: "mock",
      maxTokens: 256,
      toolCtx: { repo, activePlanId: planId, useOtherBuildsAsExamples: true },
    });

    expect(turn.toolsDegraded).toBe(false);
    expect(turn.proposedActions.some((a) => a.type === "apply_stack_preset")).toBe(
      true,
    );
    expect(turn.content.toLowerCase()).toMatch(/stealthburner|stack preset|tap/);
  });

  it("tool-loop does not invent sources when set_base fails", async () => {
    const mock: AssistantPort = {
      provider: "openai",
      model: "mock",
      configured: true,
      supportsTools: true,
      async complete() {
        return "";
      },
      async stream(_p, h) {
        h.onDone();
      },
      async completeWithTools(params) {
        if (params.messages.some((m) => m.role === "tool")) {
          const toolMsg = [...params.messages].reverse().find((m) => m.role === "tool");
          const toolContent =
            toolMsg && toolMsg.role === "tool" ? toolMsg.content : "";
          return {
            content: toolContent.includes("not found")
              ? "I cannot use FakePrinterKit-9000 — that source is not in your library."
              : "Done.",
            toolCalls: [],
            stopReason: "end_turn",
          };
        }
        return {
          content: "",
          toolCalls: [
            {
              id: "call_bad",
              name: "set_base",
              input: { plan_id: planId, source_name: "FakePrinterKit-9000" },
            },
          ],
          stopReason: "tool_use",
        };
      },
    };

    const turn = await runAssistantTurn({
      assistant: mock,
      system: "You are a kit advisor.",
      messages: [{ role: "user", content: "Use FakePrinterKit-9000 as base" }],
      model: "mock",
      maxTokens: 256,
      toolCtx: { repo, activePlanId: planId },
    });

    expect(turn.proposedActions).toHaveLength(0);
    expect(turn.content.toLowerCase()).toMatch(/cannot|not in your library|fakeprinterkit/i);
  });
});
