// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import GitHubRefField from "./GitHubRefField";

const refs = vi.hoisted(() => ({
  fetchGithubBranches: vi.fn(),
  fetchGithubTags: vi.fn(),
}));

vi.mock("../api/endpoints/sourceContent", () => refs);

describe("GitHubRefField", () => {
  afterEach(() => {
    cleanup();
    refs.fetchGithubBranches.mockReset();
    refs.fetchGithubTags.mockReset();
  });

  it("selects the branch encoded in a deep GitHub tree URL", async () => {
    refs.fetchGithubBranches.mockResolvedValue({
      owner: "MillenniumMachines",
      repo: "Milo-V2.0",
      default_branch: "main",
      url_branch: "Current",
      branches: ["Current", "add-cabling", "main"],
    });
    const onBranchChange = vi.fn();

    render(
      <GitHubRefField
        url="https://github.com/MillenniumMachines/Milo-V2.0/tree/Current/STL%20Files/Spindle-Mounts/LDO-Kit-Spindle-Mount?plain=1#mount"
        refType="branch"
        branch="main"
        tag=""
        onRefTypeChange={vi.fn()}
        onBranchChange={onBranchChange}
        onTagChange={vi.fn()}
      />,
    );

    await waitFor(() => expect(onBranchChange).toHaveBeenCalledWith("Current"), {
      timeout: 1_500,
    });
  });
});
