import { describe, expect, it } from "vitest";
import {
  aggregateFeedbackScores,
  appendAssistantFeedback,
  buildThumbsPreferDigestLine,
  collectCatalogFeedbackTokens,
  feedbackExcerptKey,
  loadAssistantFeedback,
  scorePlanFeedback,
  scoreStackPreset,
} from "./history.js";
import type { AppRepository } from "../db/repository.js";

function memoryRepo(): AppRepository & { _store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    _store: store,
    getSetting: (key: string) => store.get(key) ?? null,
    setSetting: (key: string, value: string) => {
      store.set(key, value);
    },
  } as unknown as AppRepository & { _store: Map<string, string> };
}

describe("aggregateFeedbackScores", () => {
  it("scores plans and known stack tokens without dumping raw feedback", () => {
    const repo = memoryRepo();
    appendAssistantFeedback(repo, {
      rating: "up",
      plan_id: 7,
      message_excerpt: "Applied voron_2.4_stock_sb_tap successfully",
    });
    appendAssistantFeedback(repo, {
      rating: "up",
      plan_id: 7,
      message_excerpt: "Still good",
    });
    appendAssistantFeedback(repo, {
      rating: "down",
      plan_id: 3,
      message_excerpt: "Bad suggestion for voron_2.4_stock_sb_tap",
    });

    const scores = aggregateFeedbackScores(repo, ["voron_2.4_stock_sb_tap", "ldo_2.4_sb_tap"]);
    expect(scores.byPlanId.get(7)).toBe(4); // 2× up at +2
    expect(scores.byPlanId.get(3)).toBe(-2);
    expect(scores.byToken.get("voron_2.4_stock_sb_tap")).toBe(0); // +2 and -2
    expect(scorePlanFeedback(repo, 7)).toBe(4);
    expect(scoreStackPreset(repo, "ldo_2.4_sb_tap", ["ldo_2.4_sb_tap"])).toBe(0);
    expect(loadAssistantFeedback(repo)).toHaveLength(3);
  });

  it("boosts known tokens from comments and builds high-confidence prefer line", () => {
    const repo = memoryRepo();
    appendAssistantFeedback(repo, {
      rating: "up",
      message_excerpt: "Great Micron stack",
      comment: "ldo_trident_r2 is perfect",
    });
    appendAssistantFeedback(repo, {
      rating: "up",
      message_excerpt: "Again ldo_trident_r2",
    });
    const known = ["ldo_trident_r2", "other_preset"];
    const scores = aggregateFeedbackScores(repo, known);
    expect(scores.byToken.get("ldo_trident_r2")).toBeGreaterThanOrEqual(2);
    const line = buildThumbsPreferDigestLine(repo, known);
    expect(line).toContain("Preferred stacks (thumbs):");
    expect(line).toContain("ldo_trident_r2");
    expect(line).not.toMatch(/perfect|Great Micron/i);
  });

  it("collectCatalogFeedbackTokens includes presets and source names", () => {
    const tokens = collectCatalogFeedbackTokens({
      bases: { micron: { source_name: "Micron" } },
      stack_presets: { ldo_trident_r2: {} },
      addon_categories: {
        toolhead: { sources: [{ name: "Voron-Stealthburner" }] },
      },
    });
    expect(tokens).toContain("ldo_trident_r2");
    expect(tokens).toContain("micron");
    expect(tokens).toContain("voron-stealthburner");
  });

  it("feedbackExcerptKey is stable", () => {
    expect(feedbackExcerptKey("hello")).toBe(feedbackExcerptKey("hello"));
    expect(feedbackExcerptKey("a")).not.toBe(feedbackExcerptKey("b"));
  });
});
