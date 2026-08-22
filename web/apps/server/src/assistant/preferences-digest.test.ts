import { describe, expect, it } from "vitest";
import {
  buildPreferencesDigest,
  decisionFingerprint,
  isDismissedFingerprint,
  isNoisePreferencePattern,
} from "./preferences-digest.js";
import type { PlanDecision } from "@print-partner/contracts";
import type { AppRepository } from "../db/repository.js";

function decision(
  partial: Partial<PlanDecision> & Pick<PlanDecision, "kind" | "action_type" | "params">,
): PlanDecision {
  return {
    id: partial.id ?? 1,
    plan_id: partial.plan_id ?? 10,
    created_at: partial.created_at ?? "2026-01-01T00:00:00.000Z",
    actor: partial.actor ?? "user",
    kind: partial.kind,
    action_type: partial.action_type,
    params: partial.params,
    label: partial.label ?? "",
    summary: partial.summary ?? "",
    rationale: partial.rationale ?? null,
    result: partial.result ?? null,
  };
}

describe("decisionFingerprint", () => {
  it("canonicalizes action_type + key params including workflow", () => {
    expect(
      decisionFingerprint("set_base", { source_name: "Voron-Trident", tag: "VTr2", noise: 1 }),
    ).toBe("set_base|source_name=Voron-Trident;tag=VTr2");
    expect(
      decisionFingerprint("apply_build_recipe", {
        workflow: "sync_then_recompute",
        source_name: "Voron-Trident",
      }),
    ).toBe("apply_build_recipe|source_name=Voron-Trident;workflow=sync_then_recompute");
  });
});

describe("isNoisePreferencePattern", () => {
  it("flags sync/recompute and Sync→Update recipes", () => {
    expect(isNoisePreferencePattern("start_sync", {})).toBe(true);
    expect(isNoisePreferencePattern("start_recompute", {})).toBe(true);
    expect(
      isNoisePreferencePattern("apply_build_recipe", { workflow: "sync_then_recompute" }),
    ).toBe(true);
    expect(isNoisePreferencePattern("add_addon", { source_name: "Voron-Stealthburner" })).toBe(
      false,
    );
    expect(isNoisePreferencePattern("apply_build_recipe", { workflow: "full_stack" })).toBe(
      false,
    );
  });
});

describe("buildPreferencesDigest", () => {
  it("prefers repeated applied patterns and lists dismissed fingerprints", () => {
    const decisions = [
      decision({
        kind: "applied_action",
        action_type: "set_base",
        params: { source_name: "Voron-Trident", tag: "VTr2" },
      }),
      decision({
        id: 2,
        kind: "applied_action",
        action_type: "set_base",
        params: { source_name: "Voron-Trident", tag: "VTr2" },
      }),
      decision({
        id: 3,
        kind: "applied_action",
        action_type: "add_addon",
        params: { source_name: "Voron-Stealthburner" },
      }),
      decision({
        id: 4,
        kind: "dismissed_action",
        action_type: "add_addon",
        params: { source_name: "Wrong-Addon" },
      }),
    ];

    const digest = buildPreferencesDigest(
      { listRecentTenantPlanDecisions: () => [] } as unknown as AppRepository,
      10,
      { decisions },
    );
    expect(digest).toContain("## User preferences (from this plan)");
    expect(digest).toContain("Prefer (2×): set_base source_name=Voron-Trident tag=VTr2");
    expect(digest).toContain("Prefer (1×): add_addon source_name=Voron-Stealthburner");
    expect(digest).toContain("Avoid re-proposing: add_addon source_name=Wrong-Addon");
  });

  it("includes user_note lines in the digest", () => {
    const decisions = [
      decision({
        kind: "user_note",
        action_type: null,
        params: {},
        summary: "Prefer Micron with Galileo2",
      }),
    ];
    const digest = buildPreferencesDigest(
      { listRecentTenantPlanDecisions: () => [] } as unknown as AppRepository,
      1,
      { decisions },
    );
    expect(digest).toContain("### Notes & choices");
    expect(digest).toContain("[note] Prefer Micron with Galileo2");
  });

  it("includes cross-plan prefer when another plan applied a preset", () => {
    const globalDecisions = [
      decision({
        plan_id: 99,
        kind: "applied_action",
        action_type: "apply_stack_preset",
        params: { preset_id: "ldo_trident_r2" },
      }),
      decision({
        id: 2,
        plan_id: 99,
        kind: "applied_action",
        action_type: "apply_stack_preset",
        params: { preset_id: "ldo_trident_r2" },
      }),
    ];
    const digest = buildPreferencesDigest(
      {} as AppRepository,
      10,
      { decisions: [], globalDecisions },
    );
    expect(digest).toContain("## Cross-plan memory (other builds)");
    expect(digest).toContain("Cross-plan prefer (2×): apply_stack_preset preset_id=ldo_trident_r2");
  });

  it("filters sync/recompute noise from cross-plan Prefer when real signals exist", () => {
    const globalDecisions = [
      decision({
        plan_id: 99,
        kind: "applied_action",
        action_type: "start_sync",
        params: {},
      }),
      decision({
        id: 2,
        plan_id: 99,
        kind: "applied_action",
        action_type: "start_recompute",
        params: {},
      }),
      decision({
        id: 3,
        plan_id: 99,
        kind: "applied_action",
        action_type: "apply_build_recipe",
        params: { workflow: "sync_then_recompute" },
      }),
      decision({
        id: 4,
        plan_id: 99,
        kind: "applied_action",
        action_type: "add_addon",
        params: { source_name: "Voron-Stealthburner" },
      }),
      decision({
        id: 5,
        plan_id: 99,
        kind: "dismissed_action",
        action_type: "start_sync",
        params: {},
      }),
      decision({
        id: 6,
        plan_id: 99,
        kind: "dismissed_action",
        action_type: "add_addon",
        params: { source_name: "Bad-Addon" },
      }),
    ];
    const digest = buildPreferencesDigest({} as AppRepository, 10, {
      decisions: [],
      globalDecisions,
    });
    expect(digest).toContain("Cross-plan prefer (1×): add_addon source_name=Voron-Stealthburner");
    expect(digest).toContain("Cross-plan avoid: add_addon source_name=Bad-Addon");
    expect(digest).not.toContain("start_sync");
    expect(digest).not.toContain("start_recompute");
    expect(digest).not.toContain("sync_then_recompute");
  });

  it("keeps sync noise in Prefer when it is the only signal", () => {
    const globalDecisions = [
      decision({
        plan_id: 99,
        kind: "applied_action",
        action_type: "start_sync",
        params: {},
      }),
      decision({
        id: 2,
        plan_id: 99,
        kind: "applied_action",
        action_type: "start_sync",
        params: {},
      }),
    ];
    const digest = buildPreferencesDigest({} as AppRepository, null, { globalDecisions });
    expect(digest).toContain("Cross-plan prefer (2×): start_sync");
  });

  it("returns global digest when no plan is active", () => {
    const globalDecisions = [
      decision({
        plan_id: 5,
        kind: "dismissed_action",
        action_type: "add_addon",
        params: { source_name: "Bad-Addon" },
      }),
    ];
    const digest = buildPreferencesDigest({} as AppRepository, null, { globalDecisions });
    expect(digest).toContain("Cross-plan avoid: add_addon source_name=Bad-Addon");
  });

  it("returns null when there are no decisions", () => {
    expect(
      buildPreferencesDigest(
        { listRecentTenantPlanDecisions: () => [] } as unknown as AppRepository,
        1,
        { decisions: [] },
      ),
    ).toBeNull();
  });
});

describe("isDismissedFingerprint", () => {
  it("matches dismissed action fingerprints", () => {
    const decisions = [
      decision({
        kind: "dismissed_action",
        action_type: "apply_stack_preset",
        params: { preset_id: "voron_2.4_stock_sb_tap" },
      }),
    ];
    const repo = {
      listPlanDecisions: () => decisions,
    } as unknown as AppRepository;
    expect(
      isDismissedFingerprint(repo, 10, "apply_stack_preset", {
        preset_id: "voron_2.4_stock_sb_tap",
      }),
    ).toBe(true);
    expect(
      isDismissedFingerprint(repo, 10, "apply_stack_preset", {
        preset_id: "other",
      }),
    ).toBe(false);
  });
});
