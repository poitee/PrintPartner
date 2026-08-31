// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import BackupManagementCard from "./BackupManagementCard";

describe("BackupManagementCard", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders the backup list returned by the server contract", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify([
            {
              name: "print-partner-backup-2026-08-18.tar.gz",
              size: 2048,
              createdAt: "2026-08-18T09:00:00.000Z",
            },
          ]),
          { headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    render(<BackupManagementCard />);

    expect(
      await screen.findByText("print-partner-backup-2026-08-18.tar.gz"),
    ).toBeTruthy();
    expect(screen.getByText("1 backup")).toBeTruthy();
  });

  it("validates an uploaded backup before offering to restore it", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([]), {
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            valid: true,
            metadata: {
              version: "1",
              createdAt: "2026-08-18T09:00:00.000Z",
              appVersion: "3.1.0",
              formatVersion: 1,
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockImplementationOnce(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);

    render(<BackupManagementCard />);

    const input = await screen.findByLabelText("Backup file to restore");
    const backup = new File(["backup bytes"], "workshop-backup.tar.gz", {
      type: "application/gzip",
    });
    fireEvent.change(input, { target: { files: [backup] } });

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/backups/validate",
        expect.objectContaining({
          method: "POST",
          body: expect.any(FormData),
        }),
      ),
    );
    expect(await screen.findByText("workshop-backup.tar.gz")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restore this backup" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/backups/restore",
        expect.objectContaining({
          method: "POST",
          body: expect.any(FormData),
        }),
      ),
    );
  });
});
