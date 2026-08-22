import { describe, expect, it } from "vitest";
import { parseAcceptedPlateExportJobList } from "@print-partner/contracts";
import {
  acceptedPlateRecentJobs,
  acceptedPlateRevisionLabel,
} from "./ExportRecentPanel";
import { acceptedPlateHistoryNeedsPolling } from "../../queries/acceptedPlates";

const digest = "a".repeat(64);
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
    plate_id: `plate_${"c".repeat(32)}`,
    ordinal: 1,
    filename: "plate-0001.3mf",
    download_url: "/exports/accepted/revision-19/plate-0001.3mf",
  }],
};

describe("accepted Plate recent exports", () => {
  it("scopes active jobs by Build and deduplicates them from reload-stable history", () => {
    const history = parseAcceptedPlateExportJobList({ jobs: [{
      job_id: "job-one",
      kind: "export-accepted-plate-3mf",
      status: "done",
      message: "Done",
      progress: 1,
      result,
      error: null,
    }, {
      job_id: "job-two",
      kind: "export-accepted-plate-3mf",
      status: "done",
      message: "Done",
      progress: 1,
      result,
      error: null,
    }] }, 7);
    const pendingHistory = parseAcceptedPlateExportJobList({ jobs: [{
      job_id: "job-reload",
      kind: "export-accepted-plate-3mf",
      status: "running",
      message: "Exporting",
      progress: 0.25,
      result: null,
      error: null,
    }] }, 7);
    const recent = acceptedPlateRecentJobs([
      {
        jobId: "job-one",
        kind: "export-accepted-plate-3mf",
        status: "running",
        message: "Exporting",
        progress: 0.5,
        profileId: 7,
      },
      {
        jobId: "job-failed",
        kind: "export-accepted-plate-3mf",
        status: "error",
        message: "Could not start",
        progress: null,
        profileId: 7,
      },
      {
        jobId: "job-other-build",
        kind: "export-accepted-plate-3mf",
        status: "running",
        message: "Exporting",
        progress: 0.5,
        profileId: 8,
      },
    ], [...history, ...pendingHistory], 7);

    expect(recent.runningContext.map((job) => job.jobId)).toEqual(["job-one"]);
    expect(recent.failedContext.map((job) => job.jobId)).toEqual(["job-failed"]);
    expect(recent.runningHistory.map((job) => job.job_id)).toEqual(["job-reload"]);
    expect(recent.completed.map((job) => job.job_id)).toEqual(["job-two"]);
    expect(acceptedPlateHistoryNeedsPolling([...history, ...pendingHistory])).toBe(true);
    expect(acceptedPlateHistoryNeedsPolling(history)).toBe(false);
  });

  it("labels only the matching workspace revision as current", () => {
    expect(acceptedPlateRevisionLabel(2, null)).toBe("Plate revision 2");
    expect(acceptedPlateRevisionLabel(2, 2)).toBe("Current Plate revision 2");
    expect(acceptedPlateRevisionLabel(2, 3)).toBe("Plate revision 2");
  });
});
