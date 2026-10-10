import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
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
  it("refreshes mounted Source documents after extraction completes", async () => {
    const queryClient = new QueryClient();
    const docsKey = ["sourceContent", 17, "docs"] as const;
    const documentKey = ["sourceContent", 17, "document", "manual.pdf"] as const;
    const cachedDocs = [{ path: "manual.pdf", title: "Manual", kind: "pdf" }];
    const refreshedDocs = [
      { path: "manual.pdf", title: "Manual", kind: "pdf" },
      { path: "guide.pdf", title: "Guide", kind: "pdf" },
    ];
    queryClient.setQueryData(docsKey, cachedDocs);
    queryClient.setQueryData(documentKey, "Cached PDF text");
    const fetchDocs = vi.fn().mockResolvedValue(refreshedDocs);
    const fetchDocument = vi.fn().mockResolvedValue("Refreshed PDF text");
    const docsObserver = new QueryObserver(queryClient, {
      queryKey: docsKey,
      queryFn: fetchDocs,
      staleTime: Number.POSITIVE_INFINITY,
    });
    const documentObserver = new QueryObserver(queryClient, {
      queryKey: documentKey,
      queryFn: fetchDocument,
      staleTime: Number.POSITIVE_INFINITY,
    });
    const unsubscribeDocs = docsObserver.subscribe(() => {});
    const unsubscribeDocument = documentObserver.subscribe(() => {});

    expect(docsObserver.getCurrentResult().data).toEqual(cachedDocs);
    expect(documentObserver.getCurrentResult().data).toBe("Cached PDF text");
    expect(fetchDocs).not.toHaveBeenCalled();
    expect(fetchDocument).not.toHaveBeenCalled();

    invalidateAfterJob(queryClient, "extract-source-docs", {
      ...completedUpdateCheck,
      kind: "extract-source-docs",
    });

    await vi.waitFor(() => {
      expect(docsObserver.getCurrentResult().data).toEqual(refreshedDocs);
      expect(documentObserver.getCurrentResult().data).toBe("Refreshed PDF text");
    });
    expect(fetchDocs).toHaveBeenCalledOnce();
    expect(fetchDocument).toHaveBeenCalledOnce();

    unsubscribeDocs();
    unsubscribeDocument();
    queryClient.clear();
  });

  it.each(["pending", "running", "error", "cancelled"] as const)(
    "does not refresh Source documents when extraction is %s",
    async (status) => {
      const queryClient = new QueryClient();
      const docsKey = ["sourceContent", 17, "docs"] as const;
      queryClient.setQueryData(docsKey, ["cached"]);
      const fetchDocs = vi.fn().mockResolvedValue(["refreshed"]);
      const observer = new QueryObserver(queryClient, {
        queryKey: docsKey,
        queryFn: fetchDocs,
        staleTime: Number.POSITIVE_INFINITY,
      });
      const unsubscribe = observer.subscribe(() => {});

      invalidateAfterJob(queryClient, "extract-source-docs", {
        ...completedUpdateCheck,
        kind: "extract-source-docs",
        status,
      });
      await Promise.resolve();

      expect(observer.getCurrentResult().data).toEqual(["cached"]);
      expect(fetchDocs).not.toHaveBeenCalled();
      unsubscribe();
      queryClient.clear();
    },
  );

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
});
