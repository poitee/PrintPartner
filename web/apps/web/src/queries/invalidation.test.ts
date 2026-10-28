import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { JobSnapshot } from "@print-partner/contracts";
import { invalidateAfterJob } from "./invalidation";
import { queryKeys } from "./keys";

const completedUpdateCheck: JobSnapshot = {
  job_id: "job-1",
  kind: "check-source-updates",
  status: "done",
  message: "done",
  progress: 1,
  result: null,
  error: null,
};

describe("job query invalidation", () => {
  it("invalidates shared Source and Plan summaries after an update check", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(queryKeys.sources, []);
    queryClient.setQueryData(queryKeys.profiles, []);
    queryClient.setQueryData(queryKeys.planReview(3, false), { profile_id: 3 });

    invalidateAfterJob(
      queryClient,
      "check-source-updates",
      completedUpdateCheck,
    );

    expect(queryClient.getQueryState(queryKeys.sources)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(queryKeys.profiles)?.isInvalidated).toBe(true);
    expect(
      queryClient.getQueryState(queryKeys.planReview(3, false))?.isInvalidated,
    ).toBe(true);
  });

  it("does not invalidate Source state when the update check fails", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(queryKeys.sources, []);

    invalidateAfterJob(queryClient, "check-source-updates", {
      ...completedUpdateCheck,
      status: "error",
    });

    expect(queryClient.getQueryState(queryKeys.sources)?.isInvalidated).toBe(false);
  });

  it("refreshes accepted export history after a terminal export failure", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(queryKeys.acceptedPlateExportJobs(7), []);

    invalidateAfterJob(queryClient, "export-accepted-plate-3mf", {
      ...completedUpdateCheck,
      kind: "export-accepted-plate-3mf",
      status: "error",
      error: "Export failed",
    }, 7);

    expect(queryClient.getQueryState(queryKeys.acceptedPlateExportJobs(7))?.isInvalidated).toBe(true);
  });

  it("source_import_completion_invalidates_owned_queries", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(queryKeys.sources, []);
    queryClient.setQueryData(["sources", 18], { id: 18 });
    queryClient.setQueryData(queryKeys.sourceActivity, []);
    queryClient.setQueryData(["sourceContent", 17, "docs"], ["cached"]);
    queryClient.setQueryData(["sourceContent", 17, "document", "manual.pdf"], "cached");
    queryClient.setQueryData(["sourceContent", 18, "docs"], ["other"]);
    queryClient.setQueryData(queryKeys.profiles, []);
    queryClient.setQueryData(queryKeys.planReview(4, false), { profile_id: 4 });

    invalidateAfterJob(queryClient, "import-scan", {
      ...completedUpdateCheck,
      kind: "import-scan",
      result: { stl_count: 2, project_id: 17 },
    }, null, { rebuild: true, sourceIds: [18] });

    expect(queryClient.getQueryState(queryKeys.sources)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(["sources", 18])?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(queryKeys.sourceActivity)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(["sourceContent", 17, "docs"])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(["sourceContent", 17, "document", "manual.pdf"])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(["sourceContent", 18, "docs"])?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(queryKeys.profiles)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(queryKeys.planReview(4, false))?.isInvalidated).toBe(false);
  });

  it("does not invalidate source or plan queries when the import scan fails", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(queryKeys.sources, []);
    queryClient.setQueryData(["sourceContent", 17, "docs"], ["cached"]);
    queryClient.setQueryData(queryKeys.planReview(4, false), { profile_id: 4 });

    invalidateAfterJob(queryClient, "import-scan", {
      ...completedUpdateCheck,
      kind: "import-scan",
      status: "error",
      result: { project_id: 17, profile_id: 4, draft_id: 8, revision_id: 11 },
    }, null, { rebuild: true, sourceIds: [17] });

    expect(queryClient.getQueryState(queryKeys.sources)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(["sourceContent", 17, "docs"])?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(queryKeys.planReview(4, false))?.isInvalidated).toBe(false);
  });

  it("plan_publication_invalidates_only_matching_plan", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(queryKeys.planReview(4, false), { profile_id: 4 });
    queryClient.setQueryData(queryKeys.planReview(9, false), { profile_id: 9 });
    queryClient.setQueryData(queryKeys.planLayers(4), []);
    queryClient.setQueryData(queryKeys.planLayers(9), []);
    queryClient.setQueryData(queryKeys.checkoff(4), { profile_id: 4 });
    queryClient.setQueryData(queryKeys.checkoff(9), { profile_id: 9 });
    queryClient.setQueryData(queryKeys.profiles, []);
    queryClient.setQueryData(queryKeys.profile(4), { id: 4 });
    queryClient.setQueryData(queryKeys.profile(9), { id: 9 });
    queryClient.setQueryData(queryKeys.sources, []);

    invalidateAfterJob(queryClient, "check-source-updates", {
      ...completedUpdateCheck,
      result: { profile_id: 4, draft_id: 8, revision_id: 11, plan_version: 2 },
    }, null, { rebuild: true });

    expect(queryClient.getQueryState(queryKeys.planReview(4, false))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(queryKeys.planLayers(4))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(queryKeys.checkoff(4))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(queryKeys.profile(4))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(queryKeys.planReview(9, false))?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(queryKeys.planLayers(9))?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(queryKeys.checkoff(9))?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(queryKeys.profile(9))?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(queryKeys.profiles)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(queryKeys.sources)?.isInvalidated).toBe(false);
  });

  it("does not treat an export result as plan publication", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(queryKeys.planReview(4, false), { profile_id: 4 });

    invalidateAfterJob(queryClient, "export-kit-bundle", {
      ...completedUpdateCheck,
      kind: "export-kit-bundle",
      result: { profile_id: 4, revision_id: 11, download_url: "/exports/kit" },
    }, 4, { rebuild: true });

    expect(queryClient.getQueryState(queryKeys.planReview(4, false))?.isInvalidated).toBe(false);
  });
});
