// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SourceDocsSheet from "./SourceDocsSheet";

const { api } = vi.hoisted(() => ({
  api: {
    fetchSourceDocs: vi.fn(),
    fetchSourceDocMarkdown: vi.fn(),
    fetchSourceNotes: vi.fn(),
    fetchSourceReadme: vi.fn(),
  },
}));

vi.mock("../../api/endpoints/sourceContent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/endpoints/sourceContent")>();
  return { ...actual, ...api };
});

vi.mock("../../context/ProfileContext", () => ({
  useProfileSelection: () => ({ selectedProfileId: null }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createQueryWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe("SourceDocsSheet loading", () => {
  beforeEach(() => {
    api.fetchSourceDocs.mockReset();
    api.fetchSourceDocMarkdown.mockReset();
    api.fetchSourceNotes.mockReset();
    api.fetchSourceReadme.mockReset();
    api.fetchSourceNotes.mockResolvedValue([]);
  });

  afterEach(cleanup);

  it("does not let the previous Source overwrite the current Source", async () => {
    const firstDocs = deferred<Array<{ path: string; title: string }>>();
    api.fetchSourceDocs.mockImplementation((sourceId: number) =>
      sourceId === 1
        ? firstDocs.promise
        : Promise.resolve([{ path: "second.md", title: "Second guide" }]),
    );
    api.fetchSourceDocMarkdown.mockImplementation((sourceId: number) =>
      Promise.resolve(sourceId === 1 ? "First content" : "Second content"),
    );

    const { rerender } = render(
      <SourceDocsSheet
        sourceId={1}
        sourceName="First Source"
        open
        onOpenChange={vi.fn()}
      />,
      { wrapper: createQueryWrapper() },
    );

    rerender(
      <SourceDocsSheet
        sourceId={2}
        sourceName="Second Source"
        open
        onOpenChange={vi.fn()}
      />,
    );

    expect(await screen.findByText("Second content")).toBeTruthy();

    await act(async () => {
      firstDocs.resolve([{ path: "first.md", title: "First guide" }]);
      await firstDocs.promise;
    });

    await waitFor(() => {
      expect(screen.queryByText("First content")).toBeNull();
      expect(screen.getByText("Second content")).toBeTruthy();
    });
  });

  it("keeps the last selected document when an earlier request finishes later", async () => {
    const secondMarkdown = deferred<string>();
    api.fetchSourceDocs.mockResolvedValue([
      { path: "first.md", title: "First guide" },
      { path: "second.md", title: "Second guide" },
      { path: "third.md", title: "Third guide" },
    ]);
    api.fetchSourceDocMarkdown.mockImplementation((_sourceId: number, path: string) =>
      path === "second.md" ? secondMarkdown.promise : Promise.resolve(`${path} content`),
    );

    render(
      <SourceDocsSheet
        sourceId={1}
        sourceName="Source"
        open
        onOpenChange={vi.fn()}
      />,
      { wrapper: createQueryWrapper() },
    );

    expect(await screen.findByText("first.md content")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Second guide" }));
    fireEvent.click(screen.getByRole("button", { name: "Third guide" }));
    expect(await screen.findByText("third.md content")).toBeTruthy();

    await act(async () => {
      secondMarkdown.resolve("second.md content");
      await secondMarkdown.promise;
    });

    await waitFor(() => {
      expect(screen.queryByText("second.md content")).toBeNull();
      expect(screen.getByText("third.md content")).toBeTruthy();
    });
  });

  it("loads a synced README through the document endpoint", async () => {
    api.fetchSourceDocs.mockResolvedValue([
      { path: "README.md", title: "README", kind: "readme" },
    ]);
    api.fetchSourceDocMarkdown.mockResolvedValue("# Synced guide");

    render(
      <SourceDocsSheet
        sourceId={1}
        sourceName="Source"
        open
        onOpenChange={vi.fn()}
      />,
      { wrapper: createQueryWrapper() },
    );

    expect(await screen.findByText("# Synced guide")).toBeTruthy();
    expect(api.fetchSourceDocMarkdown).toHaveBeenCalledWith(1, "README.md");
    expect(api.fetchSourceReadme).not.toHaveBeenCalled();
  });

  it("shows a retryable error instead of an empty-docs message", async () => {
    api.fetchSourceDocs
      .mockRejectedValueOnce(new Error("docs unavailable"))
      .mockResolvedValueOnce([{ path: "recovered.md", title: "Recovered guide" }]);
    api.fetchSourceDocMarkdown.mockResolvedValue("Recovered content");

    render(
      <SourceDocsSheet
        sourceId={1}
        sourceName="Broken Source"
        open
        onOpenChange={vi.fn()}
      />,
      { wrapper: createQueryWrapper() },
    );

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not load Source docs: docs unavailable",
    );
    expect(screen.getByRole("button", { name: "Retry loading Source docs" })).toBeTruthy();
    expect(screen.queryByText(/Sync this Source to pull README/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry loading Source docs" }));

    expect(await screen.findByText("Recovered content")).toBeTruthy();
  });

  it("shows a retryable error when the live README fallback fails", async () => {
    api.fetchSourceDocs.mockResolvedValue([]);
    api.fetchSourceReadme.mockRejectedValue(new Error("README unavailable"));

    render(
      <SourceDocsSheet
        sourceId={1}
        sourceName="Broken Source"
        open
        onOpenChange={vi.fn()}
      />,
      { wrapper: createQueryWrapper() },
    );

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not load Source docs: README unavailable",
    );
    expect(screen.queryByText(/Sync this Source to pull README/i)).toBeNull();
  });
});
