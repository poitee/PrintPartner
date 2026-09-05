// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import GitHubRefField from "./GitHubRefField";

const refs = vi.hoisted(() => ({
  fetchGithubBranches: vi.fn(),
  fetchGithubTags: vi.fn(),
}));

vi.mock("../api/endpoints/sourceContent", () => refs);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

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

  it("uses the latest branch value when props change during the debounce", async () => {
    refs.fetchGithubBranches.mockResolvedValue({
      owner: "owner",
      repo: "repo",
      default_branch: "main",
      url_branch: null,
      branches: ["main", "release"],
    });
    const originalChange = vi.fn();
    const latestChange = vi.fn();
    const shared = {
      url: "https://github.com/owner/repo",
      refType: "branch" as const,
      tag: "",
      onRefTypeChange: vi.fn(),
      onTagChange: vi.fn(),
    };
    const view = render(
      <GitHubRefField
        {...shared}
        branch="obsolete"
        onBranchChange={originalChange}
      />,
    );

    view.rerender(
      <GitHubRefField
        {...shared}
        branch="release"
        onBranchChange={latestChange}
      />,
    );

    await screen.findByRole("option", { name: "release" }, { timeout: 1_500 });
    expect(originalChange).not.toHaveBeenCalled();
    expect(latestChange).not.toHaveBeenCalled();
  });

  it("uses the latest change callback when props change during the debounce", async () => {
    refs.fetchGithubBranches.mockResolvedValue({
      owner: "owner",
      repo: "repo",
      default_branch: "main",
      url_branch: null,
      branches: ["main"],
    });
    const originalChange = vi.fn();
    const latestChange = vi.fn();
    const shared = {
      url: "https://github.com/owner/repo",
      refType: "branch" as const,
      branch: "obsolete",
      tag: "",
      onRefTypeChange: vi.fn(),
      onTagChange: vi.fn(),
    };
    const view = render(
      <GitHubRefField {...shared} onBranchChange={originalChange} />,
    );

    view.rerender(
      <GitHubRefField {...shared} onBranchChange={latestChange} />,
    );

    await waitFor(() => expect(latestChange).toHaveBeenCalledWith("main"), {
      timeout: 1_500,
    });
    expect(originalChange).not.toHaveBeenCalled();
  });

  it("ignores an old repository response as soon as the URL changes", async () => {
    const oldRequest = deferred<{
      owner: string;
      repo: string;
      default_branch: string;
      url_branch: string;
      branches: string[];
    }>();
    refs.fetchGithubBranches
      .mockImplementationOnce(() => oldRequest.promise)
      .mockResolvedValueOnce({
        owner: "owner",
        repo: "new-repo",
        default_branch: "main",
        url_branch: "fresh",
        branches: ["main", "fresh"],
      });
    const onBranchChange = vi.fn();
    const shared = {
      refType: "branch" as const,
      branch: "main",
      tag: "",
      onRefTypeChange: vi.fn(),
      onBranchChange,
      onTagChange: vi.fn(),
    };
    const view = render(
      <GitHubRefField {...shared} url="https://github.com/owner/old-repo" />,
    );
    await waitFor(() => expect(refs.fetchGithubBranches).toHaveBeenCalledTimes(1), {
      timeout: 1_500,
    });

    view.rerender(
      <GitHubRefField {...shared} url="https://github.com/owner/new-repo" />,
    );
    await act(async () => {
      oldRequest.resolve({
        owner: "owner",
        repo: "old-repo",
        default_branch: "main",
        url_branch: "stale",
        branches: ["main", "stale"],
      });
      await oldRequest.promise;
    });
    expect(onBranchChange).not.toHaveBeenCalledWith("stale");

    await waitFor(() => expect(onBranchChange).toHaveBeenCalledWith("fresh"), {
      timeout: 1_500,
    });
    expect(onBranchChange).toHaveBeenCalledTimes(1);
  });
});
