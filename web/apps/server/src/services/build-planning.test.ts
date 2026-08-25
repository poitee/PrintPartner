import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeBuildRequest,
  buildEvidenceFromUploadedSource,
  compareSourceTrees,
  deriveBuildPlanningReadiness,
  hydrateBuildPlanningBrief,
  newBuildPlanningBrief,
  normalizedUrl,
  parseBuildPlanningBrief,
  resolvedSourcePathExclusions,
} from "./build-planning.js";

describe("Build planning", () => {
  it("rejects malformed persisted planning briefs at the storage boundary", () => {
    expect(() => parseBuildPlanningBrief(JSON.stringify({ version: 1, build_id: 4 })))
      .toThrow(/invalid/i);
    const brief = newBuildPlanningBrief(4, "Print this", []);
    brief.requirements.push({ key: "material", value: "ABS", status: "satisfied" });
    expect(parseBuildPlanningBrief(JSON.stringify(brief))).toEqual(brief);
  });
  it("turns source-choice resolutions into draft exclusions", () => {
    const brief = newBuildPlanningBrief(1, "Build it", []);
    brief.differences = [
      {
        id: "changed-part",
        group_id: "parts",
        family: "parts",
        kind: "changed",
        source_a: "Official",
        source_b: "Vendor",
        path_a: "parts/bracket.stl",
        path_b: "parts/bracket.stl",
        detail: "changed",
      },
    ];
    brief.resolutions.parts = {
      resolution: "choose_source_a",
      rationale: "Use official geometry",
      resolved_at: new Date().toISOString(),
    };

    expect(resolvedSourcePathExclusions({
      brief,
      sourceIdsByName: new Map([["Official", 10], ["Vendor", 20]]),
    })).toEqual({ exclusions: [{ sourceId: 20, path: "parts/bracket.stl" }], blockers: [] });
  });

  it("blocks a resolved printable choice when the selected draft cannot represent it", () => {
    const brief = newBuildPlanningBrief(1, "Build it", []);
    brief.differences = [{
      id: "missing-part", group_id: "parts", family: "parts", kind: "added",
      source_a: "Official", source_b: "Vendor", path_b: "parts/new.stl", detail: "added",
    }];
    brief.resolutions.parts = {
      resolution: "choose_source_a", rationale: "Do not use vendor part", resolved_at: new Date().toISOString(),
    };
    expect(resolvedSourcePathExclusions({
      brief,
      sourceIdsByName: new Map([["Official", 10]]),
    }).blockers).toContainEqual(expect.stringMatching(/new\.stl/));
  });
  it("classifies model-library pages and uploaded printable artifacts", () => {
    const analyzed = analyzeBuildRequest("Use these models for the project", [
      "https://www.printables.com/model/123-widget",
      "https://makerworld.com/en/models/456-widget",
    ]);

    expect(analyzed.evidence).toEqual([
      expect.objectContaining({ kind: "model_source", input_kind: "model_page" }),
      expect.objectContaining({ kind: "model_source", input_kind: "model_page" }),
    ]);

    expect(
      buildEvidenceFromUploadedSource({
        sourceId: 42,
        sourceName: "Customer files",
        filenames: ["parts/frame.stl", "plates/project.3mf", "original.zip"],
      }),
    ).toEqual(
      expect.objectContaining({
        source_id: 42,
        kind: "model_source",
        input_kind: "upload",
        filenames: ["parts/frame.stl", "plates/project.3mf", "original.zip"],
        normalized_url: "printpartner:source:42",
      }),
    );
  });

  it.each([
    "https://www.thingiverse.com/thing:123",
    "https://thangs.com/designer/example/3d-model/widget-123",
    "https://cults3d.com/en/3d-model/tool/widget",
    "https://www.myminifactory.com/object/3d-print-widget-123",
  ])("classifies %s as a model page that needs its files", (url) => {
    expect(analyzeBuildRequest("Print this", [url]).evidence[0]).toEqual(
      expect.objectContaining({
        kind: "model_source",
        input_kind: "model_page",
        upload_required: true,
        sync_status: undefined,
      }),
    );
  });

  it("blocks a model-page Build until uploaded files are linked to that page", () => {
    const brief = newBuildPlanningBrief(9, "Print this model", [
      "https://www.printables.com/model/123-widget",
    ]);
    brief.draft_id = 1;
    expect(deriveBuildPlanningReadiness(brief).blockers).toContainEqual(
      expect.objectContaining({ code: "model_files_missing" }),
    );

    brief.evidence.push(
      buildEvidenceFromUploadedSource({
        sourceId: 42,
        sourceName: "Downloaded model files",
        derivedFromEvidenceId: brief.evidence[0]!.id,
      }),
    );
    brief.evidence[1]!.sync_status = "synced";
    brief.evidence[1]!.pinned_revision = "a".repeat(64);
    expect(deriveBuildPlanningReadiness(brief).blockers).not.toContainEqual(
      expect.objectContaining({ code: "model_files_missing" }),
    );
  });

  it("blocks apply for unverified or incompatible compatibility findings", () => {
    const brief = newBuildPlanningBrief(9, "Print this model", []);
    brief.draft_id = 1;
    brief.compatibility_findings = [{
      id: "hotend-toolhead",
      subject: "Rapido UHF with selected toolhead",
      status: "unverified",
      detail: "Mount has not been selected",
      evidence_ids: [],
    }];
    expect(deriveBuildPlanningReadiness(brief).blockers).toContainEqual(
      expect.objectContaining({ code: "compatibility_unverified" }),
    );
    brief.compatibility_findings[0]!.status = "satisfied";
    expect(deriveBuildPlanningReadiness(brief).blockers).not.toContainEqual(
      expect.objectContaining({ code: "compatibility_unverified" }),
    );
  });

  it("blocks a reviewed draft when a pinned Source revision changes", () => {
    const brief = newBuildPlanningBrief(9, "Print this", []);
    brief.evidence = [{
      id: "source", url: "https://example.com/source", normalized_url: "https://example.com/source",
      kind: "canonical_design", source_id: 7, source_role: "structural_base",
      sync_status: "synced", pinned_revision: "new-revision",
    }];
    brief.draft_id = 3;
    brief.draft_source_revisions = { "7": "old-revision" };
    expect(deriveBuildPlanningReadiness(brief).blockers).toContainEqual(
      expect.objectContaining({ code: "draft_source_changed" }),
    );
  });

  it("classifies arbitrary design and mod repositories from customer language", () => {
    const result = analyzeBuildRequest(
      "Use the official CaptainSlug Caliburn repository as the canonical base, then include the FoamBlast magwell repository as a mod.",
      [
        "https://github.com/CaptainSlug/Caliburn",
        "https://github.com/FoamBlast/caliburn-magwell",
      ],
    );

    expect(result.evidence).toEqual([
      expect.objectContaining({
        kind: "canonical_design",
        source_role: "structural_base",
      }),
      expect.objectContaining({ kind: "mod", source_role: "addon" }),
    ]);
  });

  it("extracts a generic project and requested feature outside printer-specific vocabulary", () => {
    const result = analyzeBuildRequest(
      "Build a Caliburn Nerf blaster with a metric hardware remix.",
      ["https://www.printables.com/model/123-caliburn-remix"],
    );
    expect(result.requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "project", value: "Caliburn Nerf blaster" }),
      expect.objectContaining({ key: "requested_feature_1", value: "a metric hardware remix" }),
    ]));
    expect(result.evidence[0]).toEqual(expect.objectContaining({ kind: "model_source" }));
  });

  it("records every structural tree difference and detects renames", () => {
    const root = mkdtempSync(join(tmpdir(), "build-planning-diff-"));
    const official = join(root, "official");
    const overlay = join(root, "overlay");
    mkdirSync(join(official, "STLs", "Toolhead"), { recursive: true });
    mkdirSync(join(overlay, "STLs", "Toolhead"), { recursive: true });
    writeFileSync(join(official, "STLs", "common.stl"), "official");
    writeFileSync(join(overlay, "STLs", "common.stl"), "overlay");
    writeFileSync(join(official, "STLs", "Toolhead", "old.stl"), "same geometry");
    writeFileSync(join(overlay, "STLs", "Toolhead", "new.stl"), "same geometry");
    writeFileSync(join(official, "STLs", "removed.stl"), "removed");
    writeFileSync(join(overlay, "STLs", "added.stl"), "added");

    const differences = compareSourceTrees({
      sourceA: { name: "official", root: official },
      sourceB: { name: "overlay", root: overlay },
    });

    expect(differences.map((difference) => difference.kind).sort()).toEqual([
      "added",
      "changed",
      "removed",
      "renamed",
    ]);
    expect(differences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "renamed",
          path_a: "STLs/Toolhead/old.stl",
          path_b: "STLs/Toolhead/new.stl",
          family: "STLs/Toolhead",
        }),
      ]),
    );
  });

  it("hydrates pinned Source evidence and builds the overlapping-source ledger", () => {
    const root = mkdtempSync(join(tmpdir(), "build-planning-hydrate-"));
    const official = join(root, "official");
    const overlay = join(root, "overlay");
    mkdirSync(official);
    mkdirSync(overlay);
    writeFileSync(join(official, "part.stl"), "official");
    writeFileSync(join(overlay, "part.stl"), "overlay");
    const brief = newBuildPlanningBrief(4, "request", [
      "https://github.com/VoronDesign/Voron-2",
      "https://github.com/FORMBOT/Voron-2.4",
    ]);
    brief.evidence[0]!.source_role = "structural_base";
    brief.evidence[1]!.source_role = "overlay";
    brief.evidence[0]!.source_id = 10;
    brief.evidence[1]!.source_id = 11;

    const hydrated = hydrateBuildPlanningBrief(
      {
        listSources: () => [
          { id: 10, name: "Voron-2", local_path: official, last_synced_at: "2026-01-01", last_commit_sha: "a".repeat(40) },
          { id: 11, name: "Formbot", local_path: overlay, last_synced_at: "2026-01-01", last_commit_sha: "b".repeat(40) },
        ],
      },
      brief,
    );

    expect(hydrated.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sync_status: "synced", pinned_revision: "a".repeat(40) }),
        expect.objectContaining({ sync_status: "synced", pinned_revision: "b".repeat(40) }),
      ]),
    );
    expect(hydrated.differences).toEqual([
      expect.objectContaining({ kind: "changed", path_a: "part.stl" }),
    ]);
  });

  it("compares the structural base with every vendor overlay", () => {
    const root = mkdtempSync(join(tmpdir(), "build-planning-overlays-"));
    const paths = ["base", "overlay-a", "overlay-b"].map((name) => join(root, name));
    for (const path of paths) mkdirSync(path);
    writeFileSync(join(paths[0]!, "part.stl"), "base");
    writeFileSync(join(paths[1]!, "part.stl"), "overlay a");
    writeFileSync(join(paths[2]!, "part.stl"), "overlay b");
    const brief = newBuildPlanningBrief(5, "request", []);
    brief.evidence = [
      { id: "base", url: "https://example.com/base", normalized_url: "https://example.com/base", kind: "canonical_design", source_id: 1, source_role: "structural_base" },
      { id: "a", url: "https://example.com/a", normalized_url: "https://example.com/a", kind: "vendor_overlay", source_id: 2, source_role: "overlay" },
      { id: "b", url: "https://example.com/b", normalized_url: "https://example.com/b", kind: "vendor_overlay", source_id: 3, source_role: "overlay" },
    ];
    const hydrated = hydrateBuildPlanningBrief({ listSources: () => [
      { id: 1, name: "Base", local_path: paths[0]!, last_synced_at: "now", last_commit_sha: "a" },
      { id: 2, name: "Overlay A", local_path: paths[1]!, last_synced_at: "now", last_commit_sha: "b" },
      { id: 3, name: "Overlay B", local_path: paths[2]!, last_synced_at: "now", last_commit_sha: "c" },
    ] }, brief);
    expect(hydrated.differences).toHaveLength(2);
    expect(new Set(hydrated.differences.map((item) => item.group_id)).size).toBe(2);
  });

  it("records contradictory informational claims about the same subject", () => {
    const brief = newBuildPlanningBrief(5, "request", []);
    brief.evidence = [
      { id: "guide-a", url: "https://a.example/guide", normalized_url: "https://a.example/guide", kind: "informational_evidence", title: "Required fasteners", extract: "Uses M3 screws" },
      { id: "guide-b", url: "https://b.example/guide", normalized_url: "https://b.example/guide", kind: "informational_evidence", title: "Required fasteners", extract: "Uses M4 screws" },
    ];

    const hydrated = hydrateBuildPlanningBrief({ listSources: () => [] }, brief);

    expect(hydrated.differences).toEqual([
      expect.objectContaining({ kind: "contradictory", family: "documentation_claims" }),
    ]);
    expect(hydrateBuildPlanningBrief({ listSources: () => [] }, hydrated).differences).toHaveLength(1);
  });

  it("extracts a complete vendor-overlay request without a built-in machine list", () => {
    const result = analyzeBuildRequest(
      "Build a Voron 2.4r2 350mm using the official Voron repository as the structural base and the Formbot repository as the vendor-kit overlay. Use Stealthburner, Galileo 2 Extruder, Rapido 2 Fiber UHF, Beacon H over USB, EBB36 over USB with a USB umbilical, and an Octopus controller. Primary color is Forest Green and accent color is KB3D Bright Orange.",
      [
        "https://github.com/VoronDesign/Voron-2",
        "https://github.com/FORMBOT/Voron-2.4",
      ],
    );

    expect(result.requirements).toEqual(
      expect.arrayContaining([
        // No hard-coded machine names: the project is whatever the user said.
        { key: "project", value: "Voron 2.4r2 350mm", status: "unverified" },
        { key: "revision", value: "r2", status: "unverified" },
        { key: "size", value: "350", status: "unverified" },
        { key: "umbilical", value: "USB", status: "unverified" },
        { key: "color_primary", value: "Forest Green", status: "unverified" },
        { key: "color_accent", value: "KB3D Bright Orange", status: "unverified" },
      ]),
    );
    expect(result.evidence).toEqual([
      expect.objectContaining({
        kind: "canonical_design",
        source_role: "structural_base",
      }),
      expect.objectContaining({
        kind: "vendor_overlay",
        source_role: "overlay",
      }),
    ]);
  });

  it("analyzes a request without mutating state", () => {
    const result = analyzeBuildRequest(
      "Voron 2.4 r2 350mm with Stealthburner, Galileo 2, Beacon H and EBB36 over USB",
      ["https://github.com/VoronDesign/Voron-2/"],
    );
    expect(result.special_request).toContain("Voron 2.4");
    // Shape-based requirements only — no product vocabulary is compiled in.
    expect(result.requirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "revision", value: "r2" }),
        expect.objectContaining({ key: "size", value: "350" }),
        expect.objectContaining({ key: "transport", value: "USB" }),
      ]),
    );
    // Everything else the user asked for is still captured verbatim.
    expect(
      result.requirements.some(
        (r) => r.key.startsWith("requested_feature_") && /Stealthburner/.test(r.value),
      ),
    ).toBe(true);
    expect(result.requirements.some((r) => r.key === "printer")).toBe(false);
    expect(result.evidence[0]).toMatchObject({
      kind: "mod",
      sync_status: "pending",
    });
  });

  it("names a requirement after a catalog slot the request mentions", () => {
    const result = analyzeBuildRequest(
      "Build an Example Printer with probe Example-Probe and toolhead Example-Toolhead",
      [],
      ["probe", "toolhead"],
    );
    expect(result.requirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "probe", value: "Example-Probe" }),
        expect.objectContaining({ key: "toolhead", value: "Example-Toolhead" }),
      ]),
    );
  });

  it("normalizes URLs for source deduplication", () => {
    expect(
      normalizedUrl("HTTPS://GitHub.com/VoronDesign/Voron-2/#readme"),
    ).toBe("https://github.com/VoronDesign/Voron-2");
  });

  it("keeps every difference blocking until its group is resolved", () => {
    const brief = newBuildPlanningBrief(7, "customer request", []);
    brief.requirements = [
      { key: "printer", value: "Voron 2.4", status: "satisfied" },
    ];
    brief.differences = [
      {
        id: "one",
        group_id: "toolhead",
        family: "toolhead",
        kind: "changed",
        source_a: "official",
        source_b: "kit",
        detail: "mount differs",
      },
      {
        id: "two",
        group_id: "toolhead",
        family: "toolhead",
        kind: "removed",
        source_a: "official",
        source_b: "kit",
        detail: "part removed",
      },
    ];
    brief.draft_id = 2;
    expect(deriveBuildPlanningReadiness(brief)).toMatchObject({
      ready: false,
      blockers: [expect.objectContaining({ code: "open_difference" })],
    });
    brief.resolutions.toolhead = {
      resolution: "choose_source_b",
      rationale: "Use kit mount",
      resolved_at: new Date().toISOString(),
    };
    expect(deriveBuildPlanningReadiness(brief)).toEqual({
      ready: true,
      blockers: [],
    });
  });

  it("blocks unconfirmed filament substitutes and missing provenance", () => {
    const brief = newBuildPlanningBrief(7, "customer request", []);
    brief.requirements = [];
    brief.draft_id = 2;
    brief.evidence = [
      {
        id: "repo",
        url: "https://example.com/repo.git",
        normalized_url: "https://example.com/repo.git",
        kind: "mod",
        sync_status: "synced",
      },
    ];
    brief.role_filaments = [
      {
        role: "accent",
        inventory_kind: "substitute",
        color_hex: "#ff6600",
        substitution_confirmed: false,
      },
    ];
    expect(
      deriveBuildPlanningReadiness(brief).blockers.map(
        (blocker) => blocker.code,
      ),
    ).toEqual(
      expect.arrayContaining([
        "source_provenance",
        "unconfirmed_filament_substitute",
      ]),
    );
  });

  it("blocks proposed Source contributions and accepts confirmed scoped contributions", () => {
    const brief = newBuildPlanningBrief(8, "request", []);
    brief.requirements = [];
    brief.draft_id = 3;
    brief.contributions = [
      {
        id: "g2e",
        evidence_id: "galileo-source",
        slot: "extruder",
        responsibility: "printable_parts",
        path_scopes: ["galileo2_extruder/stl/**"],
        confidence: "high",
        evidence_text: "Upstream describes G2E as a Stealthburner drop-in extruder.",
        status: "proposed",
      },
    ];
    expect(deriveBuildPlanningReadiness(brief).blockers).toContainEqual({
      code: "unconfirmed_contribution",
      detail: "extruder: g2e",
    });
    brief.contributions[0]!.status = "confirmed";
    expect(deriveBuildPlanningReadiness(brief)).toEqual({ ready: true, blockers: [] });
  });
});
