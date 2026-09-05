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
    const inventory = {
      categories: [
        { key: "repos", label: "Source revisions", bytes: 3_145_728, files: 4 },
      ],
      totalBytes: 3_145_728,
      backupContentBytes: 2_097_152,
      freeBytes: 10_737_418_240,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string | URL | Request) =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              String(input) === "/backups/storage"
                ? inventory
                : [
                    {
                      name: "print-partner-backup-2026-08-18.tar.gz",
                      size: 2048,
                      createdAt: "2026-08-18T09:00:00.000Z",
                    },
                  ],
            ),
            { headers: { "Content-Type": "application/json" } },
          ),
        ),
      ),
    );

    render(<BackupManagementCard />);

    expect(
      await screen.findByText("print-partner-backup-2026-08-18.tar.gz"),
    ).toBeTruthy();
    expect(screen.getByText("1 backup")).toBeTruthy();
    expect(screen.getByText("Source revisions")).toBeTruthy();
    expect(screen.getByText("2 MB")).toBeTruthy();
    expect(screen.getByText("10 GB")).toBeTruthy();
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
            categories: [],
            totalBytes: 0,
            backupContentBytes: 0,
            freeBytes: 2_000_000_000,
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            valid: true,
            metadata: {
              version: "2",
              createdAt: "2026-08-18T09:00:00.000Z",
              appVersion: "3.1.0",
              formatVersion: 2,
              scope: {
                kind: "database-only",
                includedRoots: [],
              },
            },
            restorePreflight: {
              archiveBytes: 100_000,
              requiredBytes: 67_208_864,
              freeBytes: 2_000_000_000,
              sufficient: true,
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
    expect(screen.getByText(/This database-only backup leaves stored files unchanged/)).toBeTruthy();
    expect(screen.getByText(/Restore needs 64\.1 MB of free space/)).toBeTruthy();
    expect(screen.getByText(/server currently reports 1\.86 GB free/)).toBeTruthy();
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

  it("shows an insufficient-space preflight and blocks the restore action", async () => {
    const backup = {
      name: "print-partner-backup-2026-08-18.tar.gz",
      size: 2_048,
      createdAt: "2026-08-18T09:00:00.000Z",
    };
    const fetchMock = vi.fn().mockImplementation((input: string | URL | Request) => {
      const url = String(input);
      if (url === "/backups") {
        return Promise.resolve(new Response(JSON.stringify([backup])));
      }
      if (url === "/backups/storage") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              categories: [],
              totalBytes: 0,
              backupContentBytes: 0,
              freeBytes: 1_000,
            }),
          ),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            metadata: {
              version: "2",
              createdAt: backup.createdAt,
              appVersion: "3.1.0",
              formatVersion: 2,
              scope: {
                kind: "full",
                includedRoots: ["repos", "sources"],
              },
            },
            restorePreflight: {
              archiveBytes: 1_000,
              requiredBytes: 67_109_864,
              freeBytes: 1_000,
              sufficient: false,
            },
          }),
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<BackupManagementCard />);

    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    expect(await screen.findByText(/does not have enough free space/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restore this backup" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `/backups/${backup.name}/preflight`,
    );
  });

  it("lets the browser stream a backup download instead of buffering it in JavaScript", async () => {
    const backup = {
      name: "print-partner-backup-2026-08-18.tar.gz",
      size: 20 * 1024 * 1024 * 1024,
      createdAt: "2026-08-18T09:00:00.000Z",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([backup])))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            categories: [],
            totalBytes: 0,
            backupContentBytes: 0,
            freeBytes: 30 * 1024 * 1024 * 1024,
          }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    render(<BackupManagementCard />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: `Download backup ${backup.name}`,
      }),
    );

    expect(click).toHaveBeenCalledOnce();
    const link = click.mock.instances[0];
    if (!(link instanceof HTMLAnchorElement)) {
      throw new Error("Download did not use a native link");
    }
    expect(link.getAttribute("href")).toBe(`/backups/${backup.name}`);
    expect(link.getAttribute("download")).toBe(backup.name);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
