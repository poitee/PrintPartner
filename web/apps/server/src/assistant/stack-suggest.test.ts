import { describe, expect, it } from "vitest";
import { suggestSoftStackActions } from "./stack-suggest.js";
import type { AppRepository } from "../db/repository.js";
import type { PlanDecision } from "@print-partner/contracts";

const catalog = {
  bases: {
    voron_2_4: {
      source_name: "Voron-2",
      default_addons: ["Voron-Stealthburner", "Voron-Tap"],
    },
  },
  stack_presets: {
    v24_sb_tap: {
      label: "2.4 SB Tap",
      base: "voron_2_4",
      addon_sources: ["Voron-Stealthburner", "Voron-Tap"],
    },
  },
};

function mockRepo(opts: {
  layers: Array<{ layer_type: string; project_name: string | null }>;
  decisions?: PlanDecision[];
}): AppRepository {
  return {
    getOwnedProfileIdentity: () => ({ id: 1, name: "P", archivedAt: null }),
    getProfileLayers: () =>
      opts.layers.map((l, i) => ({
        id: i + 1,
        layer_type: l.layer_type,
        project_name: l.project_name,
        project_id: i + 1,
        layer_order: i,
      })),
    listPlanDecisions: () => opts.decisions ?? [],
    getSetting: () => null,
    setSetting: () => undefined,
  } as unknown as AppRepository;
}

describe("suggestSoftStackActions", () => {
  it("proposes apply_stack_preset when base is set and addons are missing", () => {
    const actions = suggestSoftStackActions({
      repo: mockRepo({
        layers: [{ layer_type: "base", project_name: "Voron-2" }],
      }),
      planId: 1,
      catalog,
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]!.type).toBe("apply_stack_preset");
    expect(actions[0]!.params.preset_id).toBe("v24_sb_tap");
  });

  it("skips when addons already present or action already proposed", () => {
    expect(
      suggestSoftStackActions({
        repo: mockRepo({
          layers: [
            { layer_type: "base", project_name: "Voron-2" },
            { layer_type: "addon", project_name: "Voron-Tap" },
          ],
        }),
        planId: 1,
        catalog,
      }),
    ).toEqual([]);

    expect(
      suggestSoftStackActions({
        repo: mockRepo({
          layers: [{ layer_type: "base", project_name: "Voron-2" }],
        }),
        planId: 1,
        catalog,
        existingActions: [
          {
            id: "x",
            type: "add_addon",
            plan_id: 1,
            label: "x",
            summary: "x",
            params: { source_name: "Voron-Tap" },
          },
        ],
      }),
    ).toEqual([]);
  });

  it("falls back to add_addon when no matching preset", () => {
    const actions = suggestSoftStackActions({
      repo: mockRepo({
        layers: [{ layer_type: "base", project_name: "Voron-2" }],
      }),
      planId: 1,
      catalog: {
        bases: {
          voron_2_4: {
            source_name: "Voron-2",
            default_addons: ["Voron-Stealthburner"],
          },
        },
        stack_presets: {},
      },
    });
    expect(actions.map((a) => a.type)).toEqual(["add_addon"]);
    expect(actions[0]!.params.source_name).toBe("Voron-Stealthburner");
  });

  it("skips soft suggest when fingerprint was dismissed", () => {
    const actions = suggestSoftStackActions({
      repo: mockRepo({
        layers: [{ layer_type: "base", project_name: "Voron-2" }],
        decisions: [
          {
            id: 1,
            plan_id: 1,
            created_at: "2026-01-01T00:00:00.000Z",
            actor: "user",
            kind: "dismissed_action",
            action_type: "apply_stack_preset",
            params: { preset_id: "v24_sb_tap" },
            label: "",
            summary: "",
            rationale: null,
            result: null,
          },
        ],
      }),
      planId: 1,
      catalog,
    });
    expect(actions).toEqual([]);
  });

  it("ranks presets higher when thumbs feedback boosts the token", () => {
    const store = new Map<string, string>();
    store.set(
      "assistant_feedback",
      JSON.stringify([
        {
          id: "f1",
          rating: "up",
          message_excerpt: "Love v24_sb_tap",
          plan_id: 1,
          comment: null,
          created_at: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "f2",
          rating: "up",
          message_excerpt: "v24_sb_tap again",
          plan_id: 1,
          comment: null,
          created_at: "2026-01-02T00:00:00.000Z",
        },
      ]),
    );
    const repo = {
      getOwnedProfileIdentity: () => ({ id: 1, name: "P", archivedAt: null }),
      getProfileLayers: () => [
        {
          id: 1,
          layer_type: "base",
          project_name: "Voron-2",
          project_id: 1,
          layer_order: 0,
        },
      ],
      listPlanDecisions: () => [],
      getSetting: (k: string) => store.get(k) ?? null,
      setSetting: () => undefined,
    } as unknown as AppRepository;

    const multiCatalog = {
      bases: {
        voron_2_4: {
          source_name: "Voron-2",
          default_addons: ["Voron-Stealthburner"],
        },
      },
      stack_presets: {
        other_preset: {
          label: "Other",
          base: "voron_2_4",
          addon_sources: ["Voron-Tap", "Voron-Stealthburner", "Extra"],
        },
        v24_sb_tap: {
          label: "2.4 SB Tap",
          base: "voron_2_4",
          addon_sources: ["Voron-Stealthburner"],
        },
      },
    };

    const actions = suggestSoftStackActions({
      repo,
      planId: 1,
      catalog: multiCatalog,
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]!.params.preset_id).toBe("v24_sb_tap");
  });
});
