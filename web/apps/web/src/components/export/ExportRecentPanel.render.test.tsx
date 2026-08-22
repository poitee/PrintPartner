// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ExportRecentPanel from "./ExportRecentPanel";

vi.mock("../../context/ProfileContext", () => ({
  useProfileSelection: () => ({ selectedProfileId: 7 }),
}));

vi.mock("../../context/JobContext", () => ({
  useJobContext: () => ({ activeJobs: [] }),
}));

vi.mock("../../queries/acceptedPlates", () => ({
  useAcceptedPlateExportJobsQuery: () => ({
    data: undefined,
    isPending: false,
    isError: true,
  }),
  useAcceptedPlateWorkspaceQuery: () => ({ data: undefined }),
}));

afterEach(cleanup);

describe("ExportRecentPanel initial failure", () => {
  it("renders the history error even when no cached rows exist", () => {
    render(<ExportRecentPanel />);
    expect(screen.getByText("Could not refresh recent exports.")).toBeDefined();
  });
});
