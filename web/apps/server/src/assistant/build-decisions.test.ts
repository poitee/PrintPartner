import { describe, expect, it } from "vitest";
import {
  configDecisionsFromGuideText,
  detectBuildDecisions,
  detectBuildDecisionsHeuristic,
  refineBuildDecisionsWithLlm,
} from "./build-decisions.js";
import { summarizeRepoTreePaths } from "../services/repo-tree-summary.js";
import { EMU_TREE_FIXTURE } from "../services/emu-tree.fixture.js";
import type { GuideExtract, GuideExtractLlm } from "../services/guide-ingest.js";

const emuSummary = summarizeRepoTreePaths(EMU_TREE_FIXTURE);

function guideExtract(overrides?: Partial<GuideExtract>): GuideExtract {
  return {
    detected_printer_or_base: null,
    tags_or_refs: [],
    required_addons: [],
    replacements: [],
    links: [],
    open_questions: [],
    confidence: "low",
    notes: [],
    ...overrides,
  };
}

describe("detectBuildDecisionsHeuristic (EMU-like fixture)", () => {
  it("mines electronics + lane config from README and suggests from user constraints", () => {
    const readme = `
# EMU
Off-the-shelf electronics (EBB42 with EBB36 also fully compatible). Custom Solo Lane Boards (SLB).
Supports single lane, dual lane, or multi-lane expandable setups.
`;
    const { decisions, notes } = detectBuildDecisionsHeuristic({
      treeSummary: emuSummary,
      guideText: readme,
      userConstraints: "Trianglelabs EMU 5 Lane kit with EBB36s",
    });
    const electronics = decisions.find((d) => d.id === "electronics_board");
    expect(electronics?.kind).toBe("config");
    expect(electronics?.options.map((o) => o.id).sort()).toEqual(
      expect.arrayContaining(["ebb36", "ebb42", "slb"]),
    );
    expect(electronics?.suggested_selection).toBe("ebb36");

    const lanes = decisions.find((d) => d.id === "lane_count");
    expect(lanes?.kind).toBe("config");
    expect(lanes?.suggested_selection).toBe("5");
    expect(lanes?.options.some((o) => o.selection?.lane_count === "5")).toBe(true);
    expect(lanes?.options[0]?.evidence).toMatch(/lane\/modular count/i);
    expect(notes.some((n) => /candidate/i.test(n))).toBe(true);

    // PCB folder variants remain, and come after core config.
    expect(decisions.some((d) => d.id === "pcb_recommended_options")).toBe(true);
    expect(decisions[0]?.id).toBe("electronics_board");
  });

  it("mines board tokens via patterns without kit-name literals in the miner", () => {
    const guide = `
Compatible controllers: SHT36 and BTT_EBB42 on the toolhead PCB.
Also mentions MMB as a reuse option near the electronics board section.
Supports single lane or multi-lane expandable setups.
`;
    const decisions = configDecisionsFromGuideText(guide);
    const electronics = decisions.find((d) => d.id === "electronics_board");
    expect(electronics).toBeTruthy();
    expect(electronics!.options.map((o) => o.id)).toEqual(
      expect.arrayContaining(["sht36", "bttebb42", "mmb"]),
    );
    expect(decisions.some((d) => d.id === "lane_count")).toBe(true);
    // Source of configDecisionsFromGuideText must not hardcode kit product names.
    const src = configDecisionsFromGuideText.toString();
    expect(src).not.toMatch(/EMU|Trianglelab|DW-Tas/i);
  });


  it("surfaces PCB choice as variant and User_Mods as optional", () => {
    const { decisions } = detectBuildDecisionsHeuristic({ treeSummary: emuSummary });
    const byId = Object.fromEntries(decisions.map((d) => [d.id, d]));

    const pcb = byId["pcb_recommended_options"];
    expect(pcb?.kind).toBe("variant");
    expect(pcb?.options.map((o) => o.id).sort()).toEqual(["hatch_board", "multi_led_button"]);
    expect(pcb?.options[0]?.selection).toEqual({
      pcb_recommended_options: pcb!.options[0]!.id,
    });

    const mods = byId["user_mods"];
    expect(mods?.kind).toBe("optional_mod");
    expect(mods?.suggested_selection).toBe("none");
    // "none" first, then one option per mod with a per-mod include selection.
    expect(mods?.options[0]).toMatchObject({ id: "none", selection: {} });
    const lite = mods?.options.find((o) => o.id === "emu_lite");
    expect(lite?.selection).toEqual({ user_mods_emu_lite: "include" });

    // Deprecated set suggests the default.
    expect(byId["stl_combiner_deprecated_options"]?.suggested_selection).toBe("default");
    // Single optional folders suggest skipping.
    expect(byId["stl_base_optional"]?.suggested_selection).toBe("skip");
  });

  it("turns guide open questions into config decisions and replacements into notes", () => {
    const { decisions, notes } = detectBuildDecisionsHeuristic({
      treeSummary: emuSummary,
      guideExtract: guideExtract({
        open_questions: ["How many lanes do you want (3 or 4)?"],
        replacements: ["replaces the stock spool holder"],
        required_addons: ["Klicky-Probe"],
      }),
    });
    const guideQ = decisions.find((d) => d.id === "guide_question_1");
    expect(guideQ?.kind).toBe("config");
    expect(guideQ?.label).toContain("lanes");
    expect(notes.some((n) => n.includes("stock spool holder"))).toBe(true);
    expect(notes.some((n) => n.includes("Klicky-Probe"))).toBe(true);
  });

  it("reports a note when no decisions were found", () => {
    const empty = detectBuildDecisionsHeuristic({
      treeSummary: summarizeRepoTreePaths(["STLs/frame/a.stl"]),
    });
    expect(empty.decisions).toEqual([]);
    expect(empty.notes[0]).toContain("No decision points detected");
  });
});

describe("refineBuildDecisionsWithLlm guards", () => {
  const heuristic = detectBuildDecisionsHeuristic({ treeSummary: emuSummary }).decisions;

  function llmReturning(payload: unknown): GuideExtractLlm {
    return {
      configured: true,
      model: "test-model",
      complete: async () => JSON.stringify(payload),
    };
  }

  it("keeps only known decision ids and valid suggested selections", async () => {
    const refined = await refineBuildDecisionsWithLlm(
      heuristic,
      { treeSummary: emuSummary },
      llmReturning({
        decisions: [
          { id: "pcb_recommended_options", label: "Which PCB option?", priority: 1 },
          { id: "user_mods", suggested_selection: "not_a_real_option" },
          { id: "invented_decision", label: "Install Klipper?", priority: 0 },
          { id: "stl_stepper_options", drop: true },
        ],
      }),
    );
    expect(refined).not.toBeNull();
    const ids = refined!.map((d) => d.id);
    expect(ids).not.toContain("invented_decision");
    expect(ids).not.toContain("stl_stepper_options");
    // Priority 1 sorts first; relabeled.
    expect(refined![0]).toMatchObject({
      id: "pcb_recommended_options",
      label: "Which PCB option?",
    });
    // Invalid suggested_selection falls back to the heuristic suggestion.
    const mods = refined!.find((d) => d.id === "user_mods");
    expect(mods?.suggested_selection).toBe("none");
  });

  it("falls back to heuristics on unparseable LLM output", async () => {
    const bad: GuideExtractLlm = {
      configured: true,
      model: "test-model",
      complete: async () => "sorry, I cannot help with that",
    };
    const result = await detectBuildDecisions({ treeSummary: emuSummary, llm: bad });
    expect(result.method).toBe("heuristic");
    expect(result.decisions.length).toBeGreaterThan(0);
  });

  it("never invents options — refined options always match heuristic options", async () => {
    const refined = await refineBuildDecisionsWithLlm(
      heuristic,
      { treeSummary: emuSummary },
      llmReturning({
        decisions: heuristic.map((d) => ({ id: d.id, label: `${d.label} (refined)` })),
      }),
    );
    for (const decision of refined ?? []) {
      const original = heuristic.find((d) => d.id === decision.id);
      expect(decision.options).toEqual(original?.options);
    }
  });
});
