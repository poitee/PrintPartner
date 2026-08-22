// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
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
});
