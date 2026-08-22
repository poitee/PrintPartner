import { describe, expect, it, vi } from "vitest";
import {
  applyPartsManifest,
  buildPartsManifestRows,
  parseManifestCsv,
  PARTS_MANIFEST_HEADERS,
  rowsToCsv,
  type PartsManifestRow,
} from "./partsManifest";
import { parsePartsManifestXlsx, partsManifestToXlsxBlob } from "./partsManifestXlsx";
import type { PlanReview } from "../api/engine";
import type { SourceSummary } from "@print-partner/contracts";

function sampleReview(): PlanReview {
  return {
    profile_id: 1,
    accepted_basis: {
      profile_id: 1,
      plan_version: 4,
      plan_revision_id: 8,
      plan_revision_digest: "a".repeat(64),
      required_unit_mapping_digest: "b".repeat(64),
    },
    plan_name: "Voron Test",
    layers: [
      {
        id: 10,
        layer_type: "base",
        project_id: 5,
        project_name: "Voron2",
        local_path: "/tmp/v",
        synced: true,
        last_synced_at: null,
      },
    ],
    totals: {
      included_parts: 1,
      total_print_units: 2,
      by_role: {},
      by_filament: {},
    },
    issues: [],
    has_blockers: false,
    part_groups: [
      {
        folder: "frame",
        source_layer: "base:Voron2",
        parts: [
          {
            id: 42,
            match_key: "frame/x_extrusion.stl",
            relative_path: "frame/x_extrusion.stl",
            filename: "x_extrusion.stl",
            source_layer: "base:Voron2",
            status: "ok",
            role: "structural",
            requirement: null,
            option_group_id: null,
            included: true,
            filament_color_id: null,
            quantity_auto: 2,
            quantity_override: null,
            quantity_effective: 2,
            printed_count: 1,
            print_units: [true, false],
            missing: false,
            filament_display: "ABS Black",
          },
        ],
      },
    ],
  };
}

const sampleSources: SourceSummary[] = [
  {
    id: 5,
    name: "Voron2",
    url: "https://github.com/VoronDesign/Voron-2",
    source_kind: "github",
    source_type: "git",
    role: "base",
    category: null,
    branch: "main",
    tag: null,
    local_path: "/tmp/v",
    last_synced_at: null,
    last_commit_sha: null,
    current_source_revision_id: null,
    docs_url: null,
    manifest_community_slug: null,
    metadata: null,
  },
];

describe("partsManifest CSV", () => {
  it("validates the whole spreadsheet before grouped saved-draft edits", async () => {
    const review = sampleReview();
    const rows = buildPartsManifestRows({ review, sources: sampleSources });
    const workspace = {
      profile_id: 1,
      draft: {
        draft_id: 9,
        state: "open" as const,
        lifecycle_version: 0,
        snapshot_digest: "a".repeat(64),
        base: { revision_id: 3, plan_version: 1 },
      },
      parts: [{
        draft_part_id: 17,
        base_revision_part_id: 3,
        part_key: "frame/x_extrusion.stl",
        filename: "x_extrusion.stl",
        relative_path: "frame/x_extrusion.stl",
        source_layer: "base:Voron2",
        role: "structural",
        quantity_inferred: 2,
        quantity_override: null,
        quantity_effective: 2,
        included: true,
      }],
      diff: { base_is_current: true, added: [], removed: [], changed: [] },
      reconciliation: { kind: "ready" as const, reused_units: 2, new_units: 0, surplus_units: 0 },
    };
    const decisions: unknown[] = [];
    let batchCalls = 0;
    const applyDraftDecisions = async (batch: unknown[]) => {
      batchCalls++;
      decisions.push(...batch);
      return workspace;
    };

    const invalid = await applyPartsManifest(
      [{ ...rows[0]!, quantity: "3" }, { ...rows[0]!, part_id: "", match_key: "missing", quantity: "0" }],
      review,
      { applyIncluded: true, draftWorkspace: workspace, applyDraftDecisions },
    );
    expect(invalid.errors.length).toBeGreaterThan(0);
    expect(decisions).toEqual([]);

    const result = await applyPartsManifest(
      [{ ...rows[0]!, quantity: "3", included: "false" }],
      review,
      { applyIncluded: true, draftWorkspace: workspace, applyDraftDecisions },
    );
    expect(result).toEqual({ updated: 1, skipped: 0, errors: [] });
    expect(batchCalls).toBe(1);
    expect(decisions).toEqual([
      { kind: "set_quantity_override", draft_part_ids: [17], value: 3 },
      { kind: "set_included", draft_part_ids: [17], value: false },
    ]);
    expect(review.part_groups[0]!.parts[0]).toMatchObject({
      quantity_effective: 2,
      included: true,
    });
  });

  it("compares planning imports with the saved draft instead of accepted Review", async () => {
    const review = sampleReview();
    const rows = buildPartsManifestRows({ review, sources: sampleSources });
    const workspace = {
      profile_id: 1,
      draft: {
        draft_id: 9,
        state: "open" as const,
        lifecycle_version: 0,
        snapshot_digest: "a".repeat(64),
        base: { revision_id: 3, plan_version: 1 },
      },
      parts: [{
        draft_part_id: 17,
        base_revision_part_id: 3,
        part_key: "frame/x_extrusion.stl",
        filename: "x_extrusion.stl",
        relative_path: "frame/x_extrusion.stl",
        source_layer: "base:Voron2",
        role: "structural",
        quantity_inferred: 2,
        quantity_override: 3,
        quantity_effective: 3,
        included: false,
      }],
      diff: { base_is_current: true, added: [], removed: [], changed: [] },
      reconciliation: { kind: "ready" as const, reused_units: 2, new_units: 0, surplus_units: 0 },
    };
    const applyDraftDecisions = vi.fn().mockResolvedValue(workspace);

    const restoreAcceptedValues = await applyPartsManifest(rows, review, {
      applyIncluded: true,
      draftWorkspace: workspace,
      applyDraftDecisions,
    });
    expect(restoreAcceptedValues).toEqual({ updated: 1, skipped: 0, errors: [] });
    expect(applyDraftDecisions).toHaveBeenCalledWith([
      { kind: "set_quantity_override", draft_part_ids: [17], value: 2 },
      { kind: "set_included", draft_part_ids: [17], value: true },
    ]);

    applyDraftDecisions.mockClear();
    const keepDraftValues = await applyPartsManifest(
      [{ ...rows[0]!, quantity: "3", included: "false" }],
      review,
      { applyIncluded: true, draftWorkspace: workspace, applyDraftDecisions },
    );
    expect(keepDraftValues).toEqual({ updated: 0, skipped: 1, errors: [] });
    expect(applyDraftDecisions).not.toHaveBeenCalled();
  });

  it("rejects mixed proposed planning and accepted progress before either write", async () => {
    const review = sampleReview();
    const rows = buildPartsManifestRows({ review, sources: sampleSources });
    const applyDraftDecisions = vi.fn();
    const applyAcceptedProgress = vi.fn();

    const result = await applyPartsManifest(
      [{ ...rows[0]!, quantity: "3", printed_count: "2" }],
      review,
      {
        applyPrintedProgress: true,
        draftWorkspace: {
          profile_id: 1,
          draft: {
            draft_id: 9,
            state: "open",
            lifecycle_version: 0,
            snapshot_digest: "c".repeat(64),
            base: { revision_id: 8, plan_version: 4 },
          },
          parts: [{
            draft_part_id: 17,
            base_revision_part_id: 8,
            part_key: "frame/x_extrusion.stl",
            filename: "x_extrusion.stl",
            relative_path: "frame/x_extrusion.stl",
            source_layer: "base:Voron2",
            role: "structural",
            quantity_inferred: 2,
            quantity_override: null,
            quantity_effective: 2,
            included: true,
          }],
          diff: { base_is_current: true, added: [], removed: [], changed: [] },
          reconciliation: { kind: "ready", reused_units: 2, new_units: 0, surplus_units: 0 },
        },
        applyDraftDecisions,
        applyAcceptedProgress,
      },
    );

    expect(result.errors).toEqual([{
      row: 0,
      message: "Quantity/inclusion and printed counts must be imported separately",
    }]);
    expect(applyDraftDecisions).not.toHaveBeenCalled();
    expect(applyAcceptedProgress).not.toHaveBeenCalled();
  });

  it("submits progress-only rows once against the exact accepted basis without local mutation", async () => {
    const review = sampleReview();
    const rows = buildPartsManifestRows({ review, sources: sampleSources });
    const applyAcceptedProgress = vi.fn().mockResolvedValue(undefined);

    const result = await applyPartsManifest(
      [{ ...rows[0]!, printed_count: "2" }],
      review,
      { applyPrintedProgress: true, applyAcceptedProgress },
    );

    expect(result).toEqual({ updated: 1, skipped: 0, errors: [] });
    expect(applyAcceptedProgress).toHaveBeenCalledOnce();
    expect(applyAcceptedProgress).toHaveBeenCalledWith(
      review.accepted_basis,
      [{ part_id: 42, printed_count: 2 }],
    );
    expect(review.part_groups[0]!.parts[0]).toMatchObject({
      printed_count: 1,
      print_units: [true, false],
    });
  });

  it("does not alter browser state when a stale accepted basis is rejected", async () => {
    const review = sampleReview();
    const rows = buildPartsManifestRows({ review, sources: sampleSources });

    await expect(applyPartsManifest(
      [{ ...rows[0]!, printed_count: "2" }],
      review,
      {
        applyPrintedProgress: true,
        applyAcceptedProgress: vi.fn().mockRejectedValue(new Error("Accepted Plan changed; reload and retry")),
      },
    )).rejects.toThrow("Accepted Plan changed; reload and retry");
    expect(review.part_groups[0]!.parts[0]).toMatchObject({
      printed_count: 1,
      print_units: [true, false],
    });
  });

  it("uses the stable header row", () => {
    const rows = buildPartsManifestRows({ review: sampleReview(), sources: sampleSources });
    const csv = rowsToCsv(rows);
    expect(csv.split(/\r?\n/)[0]).toBe(PARTS_MANIFEST_HEADERS.join(","));
    expect(rows[0]!.source_link).toBe("https://github.com/VoronDesign/Voron-2");
    expect(rows[0]!.file_name).toBe("x_extrusion.stl");
    expect(rows[0]!.quantity).toBe("2");
    expect(rows[0]!.printed_count).toBe("1");
  });

  it("dedupes missing_stl when both stl_missing and a matching issue are set", () => {
    const review = sampleReview();
    review.part_groups[0]!.parts[0]!.stl_missing = true;
    review.issues = [
      {
        severity: "blocker",
        code: "missing_stl",
        message: "STL not found on disk: x_extrusion.stl",
        link_hint: "sources",
      },
    ];
    const rows = buildPartsManifestRows({ review, sources: sampleSources });
    expect(rows[0]!.notes).toBe("missing_stl");
  });

  it("round-trips CSV parse", () => {
    const rows = buildPartsManifestRows({ review: sampleReview(), sources: sampleSources });
    const parsed = parseManifestCsv(rowsToCsv(rows));
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]!.match_key).toBe("frame/x_extrusion.stl");
    expect(parsed.rows[0]!.part_id).toBe("42");
  });

  it("accepts header aliases", () => {
    const csv = "filename,qty,url\npart.stl,3,https://example.com\n";
    const parsed = parseManifestCsv(csv);
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows[0]!.file_name).toBe("part.stl");
    expect(parsed.rows[0]!.quantity).toBe("3");
    expect(parsed.rows[0]!.source_link).toBe("https://example.com");
  });

  it("neutralizes formula-injection prefixes in CSV cells", () => {
    const empty = Object.fromEntries(PARTS_MANIFEST_HEADERS.map((h) => [h, ""])) as PartsManifestRow;
    empty.file_name = "=HYPERLINK(\"http://evil\")";
    empty.notes = "+cmd";
    empty.source_name = "-1+1";
    empty.filament_role = "@SUM(A1)";
    empty.quantity = "1";
    const csv = rowsToCsv([empty]);
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain("'+cmd");
    expect(csv).toContain("'-1+1");
    expect(csv).toContain("'@SUM(A1)");
  });
});

describe("partsManifest XLSX", () => {
  it("round-trips via JSZip workbook", async () => {
    const rows = buildPartsManifestRows({ review: sampleReview(), sources: sampleSources });
    const blob = await partsManifestToXlsxBlob(rows);
    const buf = await blob.arrayBuffer();
    const parsed = await parsePartsManifestXlsx(buf);
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows[0]!.file_name).toBe("x_extrusion.stl");
    expect(parsed.rows[0]!.quantity).toBe("2");
  });

  it("emits xml:space=preserve so spreadsheet clients keep cell padding", async () => {
    const empty = Object.fromEntries(PARTS_MANIFEST_HEADERS.map((h) => [h, ""])) as PartsManifestRow;
    empty.file_name = "  padded.stl  ";
    empty.quantity = "1";
    const blob = await partsManifestToXlsxBlob([empty]);
    const zip = await (await import("jszip")).default.loadAsync(await blob.arrayBuffer());
    const sheet = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
    expect(sheet).toContain('xml:space="preserve"');
    expect(sheet).toContain(">  padded.stl  <");
  });

  it("strips XML 1.0-invalid code points from cell values", async () => {
    const empty = Object.fromEntries(PARTS_MANIFEST_HEADERS.map((h) => [h, ""])) as PartsManifestRow;
    // U+FFFE, U+FFFF, and an unpaired high surrogate are not XML 1.0 Char.
    empty.file_name = `ok\uFFFE\uFFFFpart\uD800.stl`;
    empty.quantity = "1";
    empty.notes = "tab\tok\nline\rok";
    const blob = await partsManifestToXlsxBlob([empty]);
    const zip = await (await import("jszip")).default.loadAsync(await blob.arrayBuffer());
    const sheet = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
    expect(sheet).not.toContain("\uFFFE");
    expect(sheet).not.toContain("\uFFFF");
    expect(sheet).not.toContain("\uD800");
    expect(sheet).toContain("okpart.stl");
    expect(sheet).toContain("tab\tok\nline\rok");
  });

  it("preserves empty optional columns as strings", () => {
    const empty = Object.fromEntries(PARTS_MANIFEST_HEADERS.map((h) => [h, ""])) as PartsManifestRow;
    empty.file_name = "a.stl";
    empty.quantity = "1";
    expect(empty.notes).toBe("");
  });

  it("does not let self-closing cells swallow later cells", async () => {
    const JSZip = (await import("jszip")).default;
    const headerCells = PARTS_MANIFEST_HEADERS.map(
      (h, i) =>
        `<c r="${String.fromCharCode(65 + i)}1" t="inlineStr"><is><t>${h}</t></is></c>`,
    ).join("");
    // value, self-closing empty, value — old regex swallowed the third cell.
    const dataCells = [
      `<c r="A2" t="inlineStr"><is><t>https://example.com</t></is></c>`,
      `<c r="B2" t="inlineStr"><is><t>part.stl</t></is></c>`,
      `<c r="C2"/>`,
      `<c r="D2" t="inlineStr"><is><t>1</t></is></c>`,
    ].join("");
    const sheetXml =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `<sheetData>` +
      `<row r="1">${headerCells}</row>` +
      `<row r="2">${dataCells}</row>` +
      `</sheetData></worksheet>`;
    const zip = new JSZip();
    zip.file(
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
        `</Types>`,
    );
    zip.folder("_rels")!.file(
      ".rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
        `</Relationships>`,
    );
    const xl = zip.folder("xl")!;
    xl.file(
      "workbook.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
        `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
        `<sheets><sheet name="Parts" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    );
    xl.folder("_rels")!.file(
      "workbook.xml.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
        `</Relationships>`,
    );
    xl.folder("worksheets")!.file("sheet1.xml", sheetXml);
    const buf = await zip.generateAsync({ type: "arraybuffer" });
    const parsed = await parsePartsManifestXlsx(buf);
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]!.source_link).toBe("https://example.com");
    expect(parsed.rows[0]!.file_name).toBe("part.stl");
    expect(parsed.rows[0]!.quantity).toBe("");
    expect(parsed.rows[0]!.printed_count).toBe("1");
  });
});
