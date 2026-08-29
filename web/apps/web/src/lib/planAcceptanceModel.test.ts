import { describe, expect, it } from "vitest";
import type { PlanDraftWorkspace } from "@print-partner/contracts";
import {
  isPlanAcceptanceBlockerCode,
  PLAN_ACCEPTANCE_BLOCKER_CODES,
  type PlanReview,
  type ReviewPart,
} from "../api/endpoints/planManifests";
import {
  acceptedRevisionSummary,
  downstreamLinks,
  planAcceptanceModel,
  planConfirmationCopy,
  planHeaderSummary,
  planIssues,
  planPublication,
  preservedVerifiedUnits,
  requiredUnitImpact,
  workingChangeFieldLabels,
  workingChangeSummary,
} from "./planAcceptanceModel";

/** The settled answer that this Build has nothing left blocking acceptance. */
const noBlockers = { kind: "loaded", blockers: [] } as const;

function reviewPart(over: Partial<ReviewPart> & { id: number }): ReviewPart {
  return {
    match_key: `stls/part-${over.id}.stl`,
    relative_path: `STLs/part-${over.id}.stl`,
    filename: `part-${over.id}.stl`,
    source_layer: "base:Voron",
    status: "base",
    role: "primary",
    requirement: null,
    option_group_id: null,
    included: true,
    filament_color_id: null,
    quantity_auto: 1,
    quantity_override: null,
    quantity_effective: 1,
    printed_count: 0,
    print_units: [false],
    missing: true,
    filament_display: "",
    ...over,
  } as ReviewPart;
}

function review(over: Partial<PlanReview> = {}): PlanReview {
  return {
    profile_id: 1,
    accepted_basis: {
      profile_id: 1,
      plan_version: 4,
      plan_revision_id: 4,
      plan_revision_digest: "d".repeat(64),
      required_unit_mapping_digest: "e".repeat(64),
    },
    plan_name: "Voron 2.4 Workshop",
    layers: [],
    totals: { included_parts: 0, total_print_units: 0, by_role: {}, by_filament: {} },
    issues: [],
    has_blockers: false,
    part_groups: [],
    ...over,
  } as PlanReview;
}

function draftPart(over: Partial<PlanDraftWorkspace["parts"][number]> & { draft_part_id: number }) {
  return {
    base_revision_part_id: null,
    part_key: `stls/part-${over.draft_part_id}.stl`,
    filename: `part-${over.draft_part_id}.stl`,
    relative_path: `STLs/part-${over.draft_part_id}.stl`,
    source_layer: "base:Voron",
    role: "primary",
    quantity_inferred: 1,
    quantity_override: null,
    quantity_effective: 1,
    included: true,
    ...over,
  };
}

function draft(over: Partial<PlanDraftWorkspace> = {}): PlanDraftWorkspace {
  return {
    profile_id: 1,
    draft: {
      draft_id: 9,
      state: "open",
      lifecycle_version: 0,
      snapshot_digest: "a".repeat(64),
      base: { revision_id: 4, plan_version: 4 },
    },
    parts: [draftPart({ draft_part_id: 1 }), draftPart({ draft_part_id: 2 })],
    diff: { base_is_current: true, added: [], removed: [], changed: [] },
    reconciliation: { kind: "ready", reused_units: 11, new_units: 7, surplus_units: 0 },
    ...over,
  };
}

describe("accepted revision summary", () => {
  it("counts Required and verified units from the accepted revision", () => {
    const summary = acceptedRevisionSummary(review({
      part_groups: [{
        folder: "STLs",
        source_layer: "base:Voron",
        parts: [
          reviewPart({ id: 1, quantity_effective: 4, printed_count: 2 }),
          reviewPart({ id: 2, quantity_effective: 8, printed_count: 0 }),
          reviewPart({ id: 3, quantity_effective: 5, printed_count: 5, included: false }),
        ],
      }],
    }));
    expect(summary.heading).toBe("Plan revision 4 published");
    expect(summary.requiredUnits).toBe(12);
    expect(summary.verifiedUnits).toBe(2);
    expect(summary.remainingUnits).toBe(10);
    expect(summary.partCount).toBe(2);
  });

  it("says so when no revision has been accepted", () => {
    expect(acceptedRevisionSummary(review({ accepted_basis: null })).heading).toBe(
      "No Plan revision published yet",
    );
  });
});

describe("header part count", () => {
  it("reports the Working Plan total when the accepted revision is still empty", () => {
    // The old header read the accepted revision only, so it said "0 parts"
    // while the Working Plan held six.
    expect(planHeaderSummary({
      review: review({ accepted_basis: null }),
      draft: draft({
        parts: [1, 2, 3, 4, 5, 6].map((id) => draftPart({ draft_part_id: id, quantity_effective: 2 })),
      }),
    })).toBe("6 parts in the Working Plan · 6 included · 12 Required units when published");
  });

  it("reports accepted totals when there are no working changes", () => {
    expect(planHeaderSummary({
      review: review({
        part_groups: [{
          folder: "STLs",
          source_layer: "base:Voron",
          parts: [reviewPart({ id: 1, quantity_effective: 4, printed_count: 1 })],
        }],
      }),
      draft: null,
    })).toBe("1 part · 4 Required units · 1 verified");
  });
});

describe("working change summary", () => {
  it("counts added, changed, removed and unaffected parts", () => {
    const workspace = draft({
      parts: [1, 2, 3, 4].map((id) => draftPart({ draft_part_id: id })),
      diff: {
        base_is_current: true,
        added: [draftPart({ draft_part_id: 4 })],
        removed: [{
          revision_part_id: 90,
          filename: "gone.stl",
          relative_path: "STLs/gone.stl",
          source_layer: "base:Voron",
        }],
        changed: [{
          before: {
            revision_part_id: 91,
            filename: "part-1.stl",
            relative_path: "STLs/part-1.stl",
            source_layer: "base:Voron",
          },
          after: draftPart({ draft_part_id: 1, quantity_effective: 8 }),
          fields: ["quantityOverride", "quantityEffective"],
        }],
      },
    });
    expect(workingChangeSummary(workspace)).toEqual({
      added: 1,
      changed: 1,
      removed: 1,
      unaffected: 2,
      total: 4,
      changeCount: 3,
    });
    expect(workingChangeSummary(null)).toBeNull();
  });

  it("names changed fields in the user's words", () => {
    expect(workingChangeFieldLabels(["quantityOverride", "quantityEffective", "included"]))
      .toEqual(["quantity", "inclusion"]);
  });
});

describe("issue grouping and routes", () => {
  it("sends a Build-scoped issue to the Build's Sources workspace, not the Library", () => {
    const issues = planIssues({
      review: review({
        issues: [{
          code: "unsynced_source",
          message: 'Source "Voron 2.4 LDO Kit" is not synced to a local folder.',
          severity: "blocker",
          link_hint: "sources",
        }],
      }),
      draft: null,
      buildId: 1,
      planningBlockers: noBlockers,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.group).toBe("review_recommended");
    expect(issues[0]!.statusLabel).toBe("Needed for Production");
    expect(issues[0]!.action).toEqual({
      kind: "route",
      label: "Open Sources",
      to: "/sources?profile=1",
    });
  });

  it("falls back to the Source Library only when no Build is selected", () => {
    const issues = planIssues({
      review: review({
        issues: [{ code: "unsynced_source", message: "x", severity: "blocker", link_hint: "sources" }],
      }),
      draft: null,
      buildId: null,
      planningBlockers: noBlockers,
    });
    expect(issues[0]!.action).toEqual({
      kind: "route",
      label: "Open Source Library",
      to: "/library",
    });
  });

  it("puts one must-resolve decision beside every Required-unit conflict", () => {
    const issues = planIssues({
      review: review(),
      draft: draft({
        reconciliation: {
          kind: "unresolved",
          conflicts: [
            { kind: "unsafe_predecessor", target_draft_part_id: 1, predecessor_revision_part_id: 5 },
            { kind: "ambiguous_exact_match", target_draft_part_id: 2, candidate_revision_part_ids: [5, 6] },
          ],
        },
      }),
      buildId: 1,
      planningBlockers: noBlockers,
    });
    expect(issues.map((issue) => issue.id)).toEqual([
      "plan-issue-required-unit-1",
      "plan-issue-required-unit-2",
    ]);
    expect(issues.every((issue) => issue.group === "must_resolve")).toBe(true);
    expect(issues[0]!.title).toBe("part-1.stl: choose what happens to units already printed");
  });

  it("blocks acceptance while the Accepted Plan has moved on", () => {
    const issues = planIssues({
      review: review(),
      draft: draft({
        diff: { base_is_current: false, added: [], removed: [], changed: [] },
      }),
      buildId: 1,
      planningBlockers: noBlockers,
    });
    expect(issues[0]!.id).toBe("plan-issue-working-plan-behind");
    expect(issues[0]!.action).toEqual({
      kind: "refresh_working_plan",
      label: "Refresh Working Plan",
    });
  });

  it("gathers missing STL files into one reviewable issue", () => {
    const issues = planIssues({
      review: review({
        issues: [
          { code: "missing_stl", message: "STL not found on disk: a.stl", severity: "blocker", link_hint: "sources" },
          { code: "missing_stl", message: "STL not found on disk: b.stl", severity: "blocker", link_hint: "sources" },
        ],
      }),
      draft: null,
      buildId: 1,
      planningBlockers: noBlockers,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.title).toBe("2 STL files are not on disk");
    expect(issues[0]!.detail).toBe("a.stl, b.stl");
  });

  it("lists printed files by name when their records cannot move", () => {
    const issues = planIssues({
      review: review(),
      draft: draft(),
      buildId: 1,
      planningBlockers: noBlockers,
      failure: {
        kind: "unsafe_records",
        units: [{ filename: "skirt_panel_x6.stl", outcome: "printed count is higher than the new quantity" }],
      },
    });
    expect(issues[0]!.group).toBe("must_resolve");
    expect(issues[0]!.detail).toContain("skirt_panel_x6.stl");
    expect(issues[0]!.detail).toContain("printed count is higher than the new quantity");
  });

  it("does not treat a Plan with no accepted inputs as something to review", () => {
    const issues = planIssues({
      review: review(),
      draft: null,
      buildId: 1,
      planningBlockers: noBlockers,
      freshness: {
        status: "untracked",
        accepted_input_set_id: null,
        accepted_at: null,
        reasons: [{ kind: "no_accepted_inputs" }],
      },
    });
    expect(issues).toEqual([]);
  });

  it("does not list an empty Build as an issue when there is nothing to accept", () => {
    const issues = planIssues({
      review: review({
        accepted_basis: null,
        issues: [
          {
            code: "no_included_parts",
            message: "No parts are included in this build.",
            severity: "blocker",
            link_hint: "build",
          },
        ],
        has_blockers: true,
      }),
      draft: null,
      buildId: 1,
      planningBlockers: noBlockers,
    });
    expect(issues).toEqual([]);
  });

  it("still names a Source whose revision was never recorded", () => {
    const issues = planIssues({
      review: review(),
      draft: null,
      buildId: 1,
      planningBlockers: noBlockers,
      freshness: {
        status: "untracked",
        accepted_input_set_id: null,
        accepted_at: null,
        reasons: [
          { kind: "source_revision_untracked", source_id: 2, source_name: "Voron Trident" },
        ],
      },
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.title).toBe("This Plan's source revisions are not tracked");
    expect(issues[0]!.detail).toContain("Voron Trident");
    expect(issues[0]!.statusLabel).toBe("Check before publishing");
  });
});

describe("Plan publication", () => {
  it("names the choices that must be completed before publishing", () => {
    const model = planAcceptanceModel({
      review: review(),
      draft: draft({
        reconciliation: {
          kind: "unresolved",
          conflicts: [
            { kind: "unsafe_predecessor", target_draft_part_id: 1, predecessor_revision_part_id: 5 },
          ],
        },
      }),
      buildId: 1,
      planningBlockers: noBlockers,
    });
    expect(model.publication).toEqual({
      kind: "waiting_for_choices",
      label: "Publish Plan for Production",
      reason: 'Complete 1 choice under "Before publishing" first.',
      choiceCount: 1,
    });
  });

  it("blocks when the Working Plan is not the reviewed assistant draft", () => {
    const model = planAcceptanceModel({
      review: review(),
      draft: draft({
        draft: {
          draft_id: 17,
          state: "open",
          lifecycle_version: 0,
          snapshot_digest: "b".repeat(64),
          base: { revision_id: 4, plan_version: 4 },
        },
      }),
      buildId: 1,
      planningBlockers: { kind: "loaded", blockers: ["draft_selection"] },
    });

    expect(model.mustResolve).toEqual([
      expect.objectContaining({
        id: "plan-issue-build-planning-draft-selection-0",
        title: "This Working Plan has not been reviewed",
        statusLabel: "Finish before publishing",
      }),
    ]);
    expect(model.publication.kind).toBe("waiting_for_choices");
  });

  it("allows publication and names the revision and downstream outcome", () => {
    const model = planAcceptanceModel({
      review: review(),
      draft: draft(),
      buildId: 1,
      planningBlockers: noBlockers,
    });
    expect(model.publication).toEqual({
      kind: "ready",
      label: "Publish Plan revision 5 for Production",
      reason: "Publishes 2 included parts as 2 required units. Production and Checkoff will use this fixed revision.",
      nextRevision: 5,
    });
  });

  it("points to Working Plan creation when none exists", () => {
    expect(planPublication({
      draft: null,
      issues: [],
      planningBlockers: noBlockers,
      accepted: acceptedRevisionSummary(review()),
    })).toEqual({
      kind: "no_working_plan",
      label: "Publish Plan for Production",
      reason: "Build a Working Plan from the current Sources, then review it here.",
    });
  });

  it("waits while the Build's planning checks are still loading", () => {
    const model = planAcceptanceModel({
      review: review(),
      draft: draft(),
      buildId: 1,
      planningBlockers: { kind: "loading" },
    });
    expect(model.publication).toEqual({
      kind: "checking",
      label: "Publish Plan for Production",
      reason: "PrintPartner is checking this Working Plan. Publishing becomes available when the check finishes.",
    });
    expect(model.mustResolve).toEqual([
      expect.objectContaining({
        id: "plan-issue-build-planning-loading",
        title: "Still checking this Working Plan",
        statusLabel: "Checking",
      }),
    ]);
  });

  it("explains when the Build's planning checks could not be read", () => {
    const model = planAcceptanceModel({
      review: review(),
      draft: draft(),
      buildId: 1,
      planningBlockers: { kind: "unavailable" },
    });
    expect(model.publication).toEqual({
      kind: "checks_unavailable",
      label: "Publish Plan for Production",
      reason: "The planning check could not be read. Reload the page to try again.",
    });
    expect(model.mustResolve).toEqual([
      expect.objectContaining({
        id: "plan-issue-build-planning-unavailable",
        title: "This Build's planning checks could not be read",
      }),
    ]);
  });

  it("says nothing about assistant planning when there is no Working Plan", () => {
    const model = planAcceptanceModel({
      review: review(),
      draft: null,
      buildId: 1,
      planningBlockers: { kind: "unavailable" },
    });
    expect(model.mustResolve).toEqual([]);
    expect(model.publication.kind).toBe("no_working_plan");
  });

  it("explains a refusal the engine raised after the click, in the same words", () => {
    const model = planAcceptanceModel({
      review: review(),
      draft: draft(),
      buildId: 1,
      planningBlockers: noBlockers,
      failure: { kind: "planning_blocked", blockers: ["requirement_unverified"] },
    });
    expect(model.mustResolve).toEqual([
      expect.objectContaining({
        id: "plan-issue-acceptance-blocked-requirement-unverified-0",
        title: "A Build requirement is still unverified",
        statusLabel: "Finish before publishing",
      }),
    ]);
    expect(model.publication.kind).toBe("waiting_for_choices");
  });
});

describe("blocker copy", () => {
  const codes = Object.keys(PLAN_ACCEPTANCE_BLOCKER_CODES).filter(isPlanAcceptanceBlockerCode);

  it("covers every code the engine can send", () => {
    expect(codes).toHaveLength(Object.keys(PLAN_ACCEPTANCE_BLOCKER_CODES).length);
  });

  it("writes every blocker in the user's words, with no engine strings", () => {
    for (const code of [...codes, "unrecognised" as const]) {
      const issues = planIssues({
        review: review(),
        draft: draft(),
        buildId: 1,
        planningBlockers: { kind: "loaded", blockers: [code] },
      });
      const issue = issues.find((candidate) => candidate.id.includes("build-planning"));
      expect(issue, code).toBeTruthy();
      // Written copy, not a code or a token: a sentence naming what to do.
      expect(issue!.title, code).not.toContain("_");
      expect(issue!.detail, code).toMatch(/\.$/);
      expect(issue!.detail, code).toContain("Open Sources");
      // "Draft" and "setup phase" are Avoid terms for Working Plan and Preparation.
      expect(issue!.title.toLowerCase(), code).not.toContain("draft");
      expect(issue!.detail!.toLowerCase(), code).not.toContain("draft");
      expect(issue!.detail!.toLowerCase(), code).not.toContain("setup");
    }
  });
});

describe("Required-unit impact", () => {
  it("splits preserved work from work that must be printed again", () => {
    expect(requiredUnitImpact(draft({
      parts: [
        draftPart({ draft_part_id: 1, quantity_effective: 10 }),
        draftPart({ draft_part_id: 2, quantity_effective: 8 }),
        draftPart({ draft_part_id: 3, quantity_effective: 3, included: false }),
      ],
    }))).toEqual({
      kind: "ready",
      preservedUnits: 11,
      printAgainUnits: 7,
      retiredUnits: 0,
      requiredUnitsAfter: 18,
    });
  });

  it("waits for the Required-unit answers", () => {
    const impact = requiredUnitImpact(draft({
      reconciliation: { kind: "unresolved", conflicts: [] },
    }));
    expect(impact).toEqual({
      kind: "unavailable",
      reason: "Answer the Required-unit decisions above to see what publishing preserves.",
    });
  });
});

describe("preserved verification", () => {
  it("never claims more verified units than the Build had", () => {
    const accepted = acceptedRevisionSummary(review({
      part_groups: [{
        folder: "STLs",
        source_layer: "base:Voron",
        parts: [reviewPart({ id: 1, quantity_effective: 4, printed_count: 2 })],
      }],
    }));
    // 11 units keep their identity, but only 2 were ever verified.
    expect(preservedVerifiedUnits({ accepted, draft: draft() })).toBe(2);
  });

  it("preserves nothing while the Required-unit answers are open", () => {
    expect(preservedVerifiedUnits({
      accepted: acceptedRevisionSummary(review()),
      draft: draft({ reconciliation: { kind: "unresolved", conflicts: [] } }),
    })).toBe(0);
  });
});

describe("downstream destinations", () => {
  it("labels Production and Checkoff with the revision they use while changes are unaccepted", () => {
    const links = downstreamLinks({
      draft: draft(),
      accepted: acceptedRevisionSummary(review()),
    });
    expect(links.map((link) => link.qualifier)).toEqual([
      "uses published revision 4",
      "uses published revision 4",
    ]);
  });

  it("drops the qualifier once everything is accepted", () => {
    const links = downstreamLinks({
      draft: null,
      accepted: acceptedRevisionSummary(review()),
    });
    expect(links.every((link) => link.qualifier === null)).toBe(true);
  });
});

describe("acceptance confirmation", () => {
  it("reads as a receipt", () => {
    expect(planConfirmationCopy({
      planVersion: 5,
      requiredUnits: 18,
      verifiedUnits: 11,
      remainingUnits: 7,
      unmoved: [],
    })).toEqual({
      heading: "Plan revision 5 published",
      detail: "18 Required units are current. 11 verified units were preserved.",
      prepareLabel: "Prepare 7 remaining units",
      checkoffLabel: "View Checkoff",
    });
  });

  it("offers no preparation link when every unit is verified", () => {
    expect(planConfirmationCopy({
      planVersion: 6,
      requiredUnits: 4,
      verifiedUnits: 4,
      remainingUnits: 0,
      unmoved: [],
    }).prepareLabel).toBeNull();
  });
});
