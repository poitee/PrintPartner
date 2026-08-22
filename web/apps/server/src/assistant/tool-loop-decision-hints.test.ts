import { describe, expect, it } from "vitest";
import {
  appendBuildDecisionHints,
  stripWrongBaseProposalsForAttachedKit,
} from "./tool-loop.js";
import type { ToolContext } from "./tools.js";
import type { AssistantProposedAction } from "@print-partner/contracts";
import type { BuildDecision } from "./build-decisions.js";

describe("appendBuildDecisionHints", () => {
  it("soft-proposes update_kit_selections + ui_focus when model narrates only", () => {
    const decisions: BuildDecision[] = [
      {
        id: "electronics_board",
        label: "Which electronics board?",
        kind: "config",
        suggested_selection: "ebb36",
        evidence: "test",
        options: [
          {
            id: "ebb36",
            label: "EBB36",
            selection: { electronics_board: "ebb36" },
          },
          {
            id: "ebb42",
            label: "EBB42",
            selection: { electronics_board: "ebb42" },
          },
        ],
      },
      {
        id: "lane_count",
        label: "How many lanes?",
        kind: "config",
        suggested_selection: "5",
        evidence: "test",
        options: [
          { id: "5", label: "5 lanes", selection: { lane_count: "5" } },
        ],
      },
      {
        id: "pcb_recommended_options",
        label: "Which PCB option?",
        kind: "variant",
        evidence: "test",
        options: [
          {
            id: "hatch_board",
            label: "hatch_board",
            selection: { pcb_recommended_options: "hatch_board" },
          },
        ],
      },
    ];
    const actions: AssistantProposedAction[] = [];
    const toolCtx = {
      activePlanId: 9,
      dataDir: null,
      repo: {
        getOwnedProfileIdentity: () => ({ id: 9, name: "EMU", archivedAt: null }),
        getProfileLayers: () => [{ layer_type: "base", project_name: "DW-Tas/emu" }],
        listSources: () => [{ name: "DW-Tas/emu" }],
      },
    } as unknown as ToolContext;

    appendBuildDecisionHints(
      toolCtx,
      actions,
      "Trianglelabs EMU 5 Lane with EBB36s",
      decisions,
    );

    expect(actions.some((a) => a.type === "update_kit_selections")).toBe(true);
    const update = actions.find((a) => a.type === "update_kit_selections");
    expect(update?.params?.selections).toMatchObject({
      electronics_board: "ebb36",
      lane_count: "5",
    });
    expect(actions.some((a) => a.type === "ui_focus_kit_option")).toBe(true);
  });
});

describe("stripWrongBaseProposalsForAttachedKit (generic)", () => {
  it("drops wrong-base / storefront proposals when a non-catalog standalone is already base (EMU fixture)", () => {
    const actions: AssistantProposedAction[] = [
      {
        id: "1",
        type: "propose_add_source",
        plan_id: 9,
        label: "Add Trianglelabs",
        summary: "x",
        params: {
          name: "Trianglelabs/EMU-5-Lane",
          url: "https://trianglelab.net/products/emu-5-lane-kit",
          source_kind: "github",
        },
      },
      {
        id: "2",
        type: "set_base",
        plan_id: 9,
        label: "Set Voron",
        summary: "x",
        params: { source_name: "Voron-Trident" },
      },
    ];
    const toolCtx = {
      activePlanId: 9,
      dataDir: null,
      repo: {
        getOwnedProfileIdentity: () => ({ id: 9, name: "EMU", archivedAt: null }),
        getProfileLayers: () => [{ layer_type: "base", project_name: "DW-Tas/emu" }],
        listSources: () => [{ name: "DW-Tas/emu" }, { name: "Voron-Trident" }],
      },
    } as unknown as ToolContext;

    stripWrongBaseProposalsForAttachedKit(
      toolCtx,
      actions,
      "https://trianglelab.net/products/emu-5-lane-kit but I plan to use the EBB36s. This is for the EMU",
    );

    expect(actions).toEqual([]);
  });

  it("drops catalog printer add_addon proposals on a standalone non-catalog base", () => {
    const actions: AssistantProposedAction[] = [
      {
        id: "1",
        type: "add_addon",
        plan_id: 9,
        label: "Add Voron-Trident",
        summary: "x",
        params: { source_name: "Voron-Trident" },
      },
    ];
    const toolCtx = {
      activePlanId: 9,
      dataDir: null,
      repo: {
        getOwnedProfileIdentity: () => ({ id: 9, name: "EMU", archivedAt: null }),
        getProfileLayers: () => [{ layer_type: "base", project_name: "DW-Tas/emu" }],
        listSources: () => [{ name: "DW-Tas/emu" }, { name: "Voron-Trident" }],
      },
    } as unknown as ToolContext;

    stripWrongBaseProposalsForAttachedKit(
      toolCtx,
      actions,
      "building the MMU with a 5 lane hardware kit",
    );
    expect(actions).toEqual([]);
  });

  it("drops set_base to a different source when Voron-Trident is already attached (non-EMU fixture)", () => {
    const actions: AssistantProposedAction[] = [
      {
        id: "1",
        type: "set_base",
        plan_id: 3,
        label: "Set Micron",
        summary: "x",
        params: { source_name: "Micron" },
      },
      {
        id: "2",
        type: "propose_add_source",
        plan_id: 3,
        label: "Add shop",
        summary: "x",
        params: {
          name: "SomeShop",
          url: "https://example-shop.com/kit",
          source_kind: "github",
        },
      },
      {
        id: "3",
        type: "add_addon",
        plan_id: 3,
        label: "Add Tap",
        summary: "x",
        params: { source_name: "Voron-Tap" },
      },
    ];
    const toolCtx = {
      activePlanId: 3,
      dataDir: null,
      repo: {
        getOwnedProfileIdentity: () => ({ id: 3, name: "Trident", archivedAt: null }),
        getProfileLayers: () => [{ layer_type: "base", project_name: "Voron-Trident" }],
        listSources: () => [
          { name: "Voron-Trident" },
          { name: "Micron" },
          { name: "Voron-Tap" },
        ],
      },
    } as unknown as ToolContext;

    stripWrongBaseProposalsForAttachedKit(
      toolCtx,
      actions,
      "add Tap to my Trident — do not change the base",
    );

    // Wrong set_base + storefront propose_add_source dropped; addon to non-base catalog source kept
    // (Voron-Tap is typically an addon category source, not a catalog base).
    expect(actions.some((a) => a.type === "set_base")).toBe(false);
    expect(actions.some((a) => a.type === "propose_add_source")).toBe(false);
    expect(actions.some((a) => a.type === "add_addon" && a.params?.source_name === "Voron-Tap")).toBe(
      true,
    );
  });

  it("keeps set_base proposals when the user explicitly asks to switch bases", () => {
    const actions: AssistantProposedAction[] = [
      {
        id: "1",
        type: "set_base",
        plan_id: 3,
        label: "Set Micron",
        summary: "x",
        params: { source_name: "Micron" },
      },
    ];
    const toolCtx = {
      activePlanId: 3,
      dataDir: null,
      repo: {
        getOwnedProfileIdentity: () => ({ id: 3, name: "Trident", archivedAt: null }),
        getProfileLayers: () => [{ layer_type: "base", project_name: "Voron-Trident" }],
        listSources: () => [{ name: "Voron-Trident" }, { name: "Micron" }],
      },
    } as unknown as ToolContext;

    stripWrongBaseProposalsForAttachedKit(
      toolCtx,
      actions,
      "please switch base to Micron",
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]?.params?.source_name).toBe("Micron");
  });
});
