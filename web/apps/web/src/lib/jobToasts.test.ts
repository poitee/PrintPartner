import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobSnapshot } from "@print-partner/contracts";
import { toast } from "sonner";
import { toastJobResult } from "./jobToasts";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));

function syncJob(result: JobSnapshot["result"]): JobSnapshot {
  return { job_id: "sync-1", kind: "sync", status: "done", message: "Done", progress: 100, error: null, result };
}

describe("sync job completion toasts", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reports partial failures instead of claiming all Sources synced", () => {
    toastJobResult(syncJob({ synced: 1, failed: 1, failures: [{ project_id: 6, name: "Failed Source", error: "No commit found" }] }), "Synced 2 sources");
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledWith("Synced 1 Source; 1 failed.");
  });

  it("retains normal success and terminal failure messages", () => {
    toastJobResult(syncJob({ synced: 2, failed: 0, failures: [] }), "Synced 2 sources");
    expect(toast.success).toHaveBeenCalledWith("Synced 2 sources");
    toastJobResult({ ...syncJob(null), status: "error", message: "No commit found" }, "Synced 2 sources");
    expect(toast.error).toHaveBeenCalledWith("No commit found");
  });
});
