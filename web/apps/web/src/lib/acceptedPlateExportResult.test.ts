import { describe, expect, it, vi } from "vitest";
import { downloadAcceptedPlateExport } from "./acceptedPlateExportResult";

const digest = "a".repeat(64);
const plateId = `plate_${"c".repeat(32)}`;

describe("accepted Plate export result", () => {
  it("downloads only a strictly parsed terminal result", () => {
    const click = vi.fn();
    const remove = vi.fn();
    const append = vi.fn();
    const document = {
      createElement: vi.fn(() => ({ click, remove, href: "", download: "" })),
      body: { append },
    };
    const result = {
      format: "accepted-plate-export-job-v1",
      profile_id: 7,
      basis: {
        profile_id: 7,
        plan_version: 3,
        plan_revision_id: 11,
        plan_revision_digest: digest,
        required_unit_mapping_digest: digest,
      },
      plate_revision_id: 19,
      plate_revision_number: 2,
      layout_digest: digest,
      download_url: "/exports/accepted/revision-19/bundle.zip",
      manifest_download_url: "/exports/accepted/revision-19/manifest.json",
      bundle_download_url: "/exports/accepted/revision-19/bundle.zip",
      plates: [{
        plate_id: plateId,
        ordinal: 1,
        filename: "plate-0001.3mf",
        download_url: "/exports/accepted/revision-19/plate-0001.3mf",
      }],
    };
    expect(downloadAcceptedPlateExport({
      job_id: "job-one",
      kind: "export-accepted-plate-3mf",
      status: "done",
      message: "Done",
      progress: 1,
      result,
      error: null,
    }, document)).toEqual({ kind: "downloaded", result });
    expect(click).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
  });

  it("rejects a malformed terminal snapshot without starting a download", () => {
    const document = {
      createElement: vi.fn(),
      body: { append: vi.fn() },
    };
    expect(downloadAcceptedPlateExport({
      job_id: "job-one",
      kind: "export-accepted-plate-3mf",
      status: "done",
      message: "Done",
      progress: 1,
      result: { download_url: "https://attacker.test/file" },
      error: null,
    }, document)).toEqual({ kind: "invalid_result" });
    expect(document.createElement).not.toHaveBeenCalled();
  });
});
