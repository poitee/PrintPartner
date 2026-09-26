// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_STL_NAMING_PROFILE, type SourceSummary } from "@print-partner/contracts";
import SourceDetailSheet from "./SourceDetailSheet";
import { LibraryDraftProvider } from "../../context/LibraryDraftContext";

const { api } = vi.hoisted(() => ({
  api: {
    fetchSourceDocs: vi.fn(),
    fetchSourceDocMarkdown: vi.fn(),
    fetchSourceNotes: vi.fn(),
    fetchImportRules: vi.fn(),
    saveImportRules: vi.fn(),
    fetchStlNaming: vi.fn(),
    fetchSourceNaming: vi.fn(),
    saveSourceNaming: vi.fn(),
  },
}));

vi.mock("../../api/endpoints/sourceContent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/endpoints/sourceContent")>();
  return { ...actual, ...api };
});

vi.mock("../../api/endpoints/sources", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/endpoints/sources")>();
  return { ...actual, fetchImportRules: api.fetchImportRules, saveImportRules: api.saveImportRules };
});

vi.mock("../../api/endpoints/stlNaming", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/endpoints/stlNaming")>();
  return { ...actual, fetchStlNaming: api.fetchStlNaming };
});

vi.mock("../../api/endpoints/sourceNaming", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/endpoints/sourceNaming")>();
  return {
    ...actual,
    fetchSourceNaming: api.fetchSourceNaming,
    saveSourceNaming: api.saveSourceNaming,
  };
});

vi.mock("../SourceCardCover", () => ({ default: () => null }));
vi.mock("../ImportRulesTree", () => ({
  default: ({ onRulesChange }: { onRulesChange: (rules: string[]) => void }) => (
    <>
      <button type="button" onClick={() => onRulesChange(["first-source/**"])}>
        Change rule draft
      </button>
      <button type="button" onClick={() => onRulesChange(["second-source/**"])}>
        Change rule draft again
      </button>
    </>
  ),
}));

function source(id: number, name: string): SourceSummary {
  return {
    id,
    name,
    url: `https://github.com/example/${name}`,
    source_kind: "github",
    source_type: "git",
    role: "",
    category: null,
    branch: "main",
    tag: null,
    local_path: null,
    last_synced_at: null,
    last_commit_sha: null,
    current_source_revision_id: null,
    docs_url: null,
    manifest_community_slug: null,
    metadata: null,
  };
}

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
    return <QueryClientProvider client={queryClient}><LibraryDraftProvider>{children}</LibraryDraftProvider></QueryClientProvider>;
  };
}

const baseProps = {
  open: true,
  tab: "docs" as const,
  highlightPath: null,
  onOpenChange: vi.fn(),
  onTabChange: vi.fn(),
  onHighlightPathChange: vi.fn(),
  onEdit: vi.fn(),
  onDelete: vi.fn(),
  onSaveRules: vi.fn(),
  runImportScan: vi.fn(),
};

describe("SourceDetailSheet loading", () => {
  beforeEach(() => {
    api.fetchSourceDocs.mockReset();
    api.fetchSourceDocMarkdown.mockReset();
    api.fetchSourceNotes.mockReset();
    api.fetchImportRules.mockReset();
    api.saveImportRules.mockReset();
    api.fetchStlNaming.mockReset();
    api.fetchSourceNaming.mockReset();
    api.saveSourceNaming.mockReset();
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
      <SourceDetailSheet {...baseProps} source={source(1, "First Source")} />,
      { wrapper: createQueryWrapper() },
    );

    rerender(<SourceDetailSheet {...baseProps} source={source(2, "Second Source")} />);

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

    render(<SourceDetailSheet {...baseProps} source={source(1, "Source")} />, {
      wrapper: createQueryWrapper(),
    });

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
    api.fetchSourceDocMarkdown.mockResolvedValue("# Synced detail guide");

    render(<SourceDetailSheet {...baseProps} source={source(1, "Source")} />, {
      wrapper: createQueryWrapper(),
    });

    expect(await screen.findByText("# Synced detail guide")).toBeTruthy();
    expect(api.fetchSourceDocMarkdown).toHaveBeenCalledWith(1, "README.md");
  });

  it("shows a retryable error instead of empty Source docs", async () => {
    api.fetchSourceDocs
      .mockRejectedValueOnce(new Error("detail unavailable"))
      .mockResolvedValueOnce([{ path: "recovered.md", title: "Recovered guide" }]);
    api.fetchSourceDocMarkdown.mockResolvedValue("Recovered content");

    render(<SourceDetailSheet {...baseProps} source={source(1, "Broken Source")} />, {
      wrapper: createQueryWrapper(),
    });

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not load Source details: detail unavailable",
    );
    expect(screen.getByRole("button", { name: "Retry loading Source details" })).toBeTruthy();
    expect(screen.queryByText("This source has not been synced yet.")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry loading Source details" }));

    expect(await screen.findByText("Recovered content")).toBeTruthy();
  });

  it("cannot save the previous Source rules while the next Source is loading", async () => {
    const secondRules = deferred<{ rules: string[] }>();
    api.fetchSourceDocs.mockResolvedValue([]);
    api.fetchImportRules.mockImplementation((sourceId: number) =>
      sourceId === 1 ? Promise.resolve({ rules: ["original/**"] }) : secondRules.promise,
    );
    api.saveImportRules.mockResolvedValue(undefined);

    const { rerender } = render(
      <SourceDetailSheet {...baseProps} tab="rules" source={source(1, "First Source")} />,
      { wrapper: createQueryWrapper() },
    );

    const saveButton = await screen.findByRole("button", { name: "Save rules" });
    await waitFor(() => expect((saveButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Change rule draft" }));

    rerender(
      <SourceDetailSheet {...baseProps} tab="rules" source={source(2, "Second Source")} />,
    );

    expect((screen.getByRole("button", { name: "Save rules" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Save rules" }));
    expect(api.saveImportRules).not.toHaveBeenCalled();

    await act(async () => {
      secondRules.resolve({ rules: ["second/**"] });
      await secondRules.promise;
    });
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Save rules" }) as HTMLButtonElement).disabled).toBe(false),
    );
  });

  it("keeps an unsaved import-rule draft when switching tabs", async () => {
    api.fetchSourceDocs.mockResolvedValue([]);
    api.fetchImportRules.mockResolvedValue({ rules: ["original/**"] });
    api.saveImportRules.mockResolvedValue({ rules: ["first-source/**"] });
    const { rerender } = render(
      <SourceDetailSheet {...baseProps} tab="rules" source={source(1, "Source")} />,
      { wrapper: createQueryWrapper() },
    );
    await waitFor(() => expect(api.fetchImportRules).toHaveBeenCalledTimes(1));
    await screen.findByRole("button", { name: "Change rule draft" });
    fireEvent.click(screen.getByRole("button", { name: "Change rule draft" }));

    rerender(<SourceDetailSheet {...baseProps} tab="docs" source={source(1, "Source")} />);
    rerender(<SourceDetailSheet {...baseProps} tab="rules" source={source(1, "Source")} />);

    expect(api.fetchImportRules).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Save rules" }));
    await waitFor(() => expect(api.saveImportRules).toHaveBeenCalledWith(1, ["first-source/**"]));
  });

  it("preserves edits made during a rule save and sends them in a later save", async () => {
    const firstSave = deferred<{ rules: string[] }>();
    api.fetchSourceDocs.mockResolvedValue([]);
    api.fetchImportRules.mockResolvedValue({ rules: ["original/**"] });
    api.saveImportRules
      .mockReturnValueOnce(firstSave.promise)
      .mockResolvedValueOnce({ rules: ["second-source/**"] });
    render(
      <SourceDetailSheet {...baseProps} tab="rules" source={source(1, "Source")} />,
      { wrapper: createQueryWrapper() },
    );
    await screen.findByRole("button", { name: "Change rule draft" });

    fireEvent.click(screen.getByRole("button", { name: "Change rule draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Save rules" }));
    expect(api.saveImportRules).toHaveBeenCalledWith(1, ["first-source/**"]);
    fireEvent.click(screen.getByRole("button", { name: "Change rule draft again" }));
    fireEvent.click(screen.getByRole("button", { name: "Saving…" }));
    expect(api.saveImportRules).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstSave.resolve({ rules: ["first-source/**"] });
      await firstSave.promise;
    });
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Save rules" }) as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save rules" }));
    await waitFor(() => expect(api.saveImportRules).toHaveBeenLastCalledWith(1, ["second-source/**"]));
  });

  it("lets another Source save while the previous Source save is pending", async () => {
    baseProps.runImportScan.mockClear();
    const firstSave = deferred<{ rules: string[] }>();
    const secondSave = deferred<{ rules: string[] }>();
    api.fetchSourceDocs.mockResolvedValue([]);
    api.fetchImportRules.mockImplementation((sourceId: number) =>
      Promise.resolve({ rules: sourceId === 1 ? ["first-original/**"] : ["second-original/**"] }),
    );
    api.saveImportRules.mockImplementation((sourceId: number) =>
      sourceId === 1 ? firstSave.promise : secondSave.promise,
    );
    const { rerender } = render(
      <SourceDetailSheet {...baseProps} tab="rules" source={source(1, "First Source")} />,
      { wrapper: createQueryWrapper() },
    );
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Save rules" }) as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Change rule draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Save rules" }));
    expect(api.saveImportRules).toHaveBeenCalledWith(1, ["first-source/**"]);

    rerender(<SourceDetailSheet {...baseProps} tab="rules" source={source(2, "Second Source")} />);
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Save rules" }) as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Change rule draft again" }));
    fireEvent.click(screen.getByRole("button", { name: "Save rules" }));
    expect(api.saveImportRules).toHaveBeenCalledWith(2, ["second-source/**"]);

    await act(async () => {
      firstSave.resolve({ rules: ["first-source/**"] });
      await firstSave.promise;
    });
    expect((screen.getByRole("button", { name: "Saving…" }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      secondSave.resolve({ rules: ["second-source/**"] });
      await secondSave.promise;
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Save rules" })).toBeTruthy());
    expect(baseProps.runImportScan).toHaveBeenCalledWith(2);
    expect(baseProps.runImportScan).toHaveBeenCalledWith(1);
  });

  it("reloads the saved rules after returning to a Source whose save is pending", async () => {
    const firstSave = deferred<{ rules: string[] }>();
    let storedRules = ["first-original/**"];
    api.fetchSourceDocs.mockResolvedValue([]);
    api.fetchImportRules.mockImplementation((sourceId: number) =>
      Promise.resolve({ rules: sourceId === 1 ? [...storedRules] : ["second-original/**"] }),
    );
    api.saveImportRules.mockImplementation((sourceId: number, rules: string[]) =>
      sourceId === 1 && api.saveImportRules.mock.calls.length === 1
        ? firstSave.promise
        : Promise.resolve({ rules }),
    );
    const { rerender } = render(
      <SourceDetailSheet {...baseProps} tab="rules" source={source(1, "First Source")} />,
      { wrapper: createQueryWrapper() },
    );
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Save rules" }) as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Change rule draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Save rules" }));

    rerender(<SourceDetailSheet {...baseProps} tab="rules" source={source(2, "Second Source")} />);
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Save rules" }) as HTMLButtonElement).disabled).toBe(false),
    );
    rerender(<SourceDetailSheet {...baseProps} tab="rules" source={source(1, "First Source")} />);
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Saving…" }) as HTMLButtonElement).disabled).toBe(true),
    );
    expect(api.fetchImportRules.mock.calls.filter(([sourceId]) => sourceId === 1)).toHaveLength(1);

    await act(async () => {
      storedRules = ["first-source/**"];
      firstSave.resolve({ rules: storedRules });
      await firstSave.promise;
    });
    await waitFor(() =>
      expect(api.fetchImportRules.mock.calls.filter(([sourceId]) => sourceId === 1)).toHaveLength(2),
    );
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Save rules" }) as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save rules" }));
    expect(api.saveImportRules).toHaveBeenLastCalledWith(1, ["first-source/**"]);
  });

  it("keeps the Source sheet open when the user cancels discarding unsaved rules", async () => {
    api.fetchSourceDocs.mockResolvedValue([]);
    api.fetchImportRules.mockResolvedValue({ rules: ["original/**"] });
    const onOpenChange = vi.fn();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    try {
      render(
        <SourceDetailSheet {...baseProps} onOpenChange={onOpenChange} tab="rules" source={source(1, "Source")} />,
        { wrapper: createQueryWrapper() },
      );
      await screen.findByRole("button", { name: "Change rule draft" });
      fireEvent.click(screen.getByRole("button", { name: "Change rule draft" }));
      fireEvent.click(screen.getByRole("button", { name: "Close source details" }));
      expect(confirm).toHaveBeenCalledOnce();
      expect(onOpenChange).not.toHaveBeenCalled();
    } finally {
      confirm.mockRestore();
    }
  });

  it("keeps an unsaved naming override when switching tabs", async () => {
    api.fetchSourceDocs.mockResolvedValue([]);
    api.fetchStlNaming.mockResolvedValue(DEFAULT_STL_NAMING_PROFILE);
    api.fetchSourceNaming.mockResolvedValue({
      use_defaults: true,
      override: {},
      effective: DEFAULT_STL_NAMING_PROFILE,
      effective_digest: "0".repeat(64),
    });
    const { rerender } = render(
      <SourceDetailSheet {...baseProps} tab="naming" source={source(1, "Source")} />,
      { wrapper: createQueryWrapper() },
    );
    const useDefaults = await screen.findByRole("checkbox", { name: "Use app default naming rules" });
    await waitFor(() => expect((useDefaults as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(useDefaults);

    rerender(<SourceDetailSheet {...baseProps} tab="docs" source={source(1, "Source")} />);
    rerender(<SourceDetailSheet {...baseProps} tab="naming" source={source(1, "Source")} />);

    expect(api.fetchSourceNaming).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("checkbox", { name: "Use app default naming rules" }).getAttribute("data-state")).toBe("unchecked");
  });

  it("cannot save the previous Source naming draft while the next Source is loading", async () => {
    const sourceNaming = {
      use_defaults: true,
      override: {},
      effective: DEFAULT_STL_NAMING_PROFILE,
      effective_digest: "0".repeat(64),
    };
    const secondNaming = deferred<typeof sourceNaming>();
    api.fetchSourceDocs.mockResolvedValue([]);
    api.fetchStlNaming.mockResolvedValue(DEFAULT_STL_NAMING_PROFILE);
    api.fetchSourceNaming.mockImplementation((sourceId: number) =>
      sourceId === 1 ? Promise.resolve(sourceNaming) : secondNaming.promise,
    );

    const { rerender } = render(
      <SourceDetailSheet {...baseProps} tab="naming" source={source(1, "First Source")} />,
      { wrapper: createQueryWrapper() },
    );

    const useDefaults = await screen.findByRole("checkbox", {
      name: "Use app default naming rules",
    });
    await waitFor(() => expect((useDefaults as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(useDefaults);
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Save naming" }) as HTMLButtonElement).disabled).toBe(false),
    );

    rerender(
      <SourceDetailSheet {...baseProps} tab="naming" source={source(2, "Second Source")} />,
    );

    expect((screen.getByRole("button", { name: "Save naming" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Save naming" }));
    expect(api.saveSourceNaming).not.toHaveBeenCalled();

    await act(async () => {
      secondNaming.resolve(sourceNaming);
      await secondNaming.promise;
    });
    await waitFor(() =>
      expect((screen.getByRole("checkbox", { name: "Use app default naming rules" }) as HTMLButtonElement).disabled).toBe(false),
    );
  });
});
