// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CommandPalette from "./CommandPalette";

const state = vi.hoisted(() => ({
  flush: vi.fn<() => Promise<void>>(),
  kitRun: vi.fn(),
  stlRun: vi.fn(),
  syncRun: vi.fn(),
  startKit: vi.fn(),
  startStl: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { error: state.toastError } }));
vi.mock("../api/endpoints/jobs", () => ({
  startExportKitBundle: state.startKit,
  startExportStlPack: state.startStl,
  startSync: vi.fn(),
}));
vi.mock("../context/PlanActionsContext", () => ({
  usePlanActions: () => ({ openCreatePlan: vi.fn() }),
}));
vi.mock("../context/PlanWorkspaceContext", () => ({
  usePlanWorkspace: () => ({ review: null }),
}));
vi.mock("../context/ProfileContext", () => ({
  useProfileSelection: () => ({ selectedProfileId: 7 }),
}));
vi.mock("../context/BuildSaveFlushContext", () => ({
  useFlushBuildPageSaves: () => state.flush,
}));
vi.mock("../hooks/useImportSharedBuild", () => ({
  useImportSharedBuild: () => vi.fn(),
}));
vi.mock("../hooks/useEngineHealth", () => ({
  useEngineHealth: () => ({ health: { ok: true, capabilities: [] } }),
}));
vi.mock("../hooks/useJobRunner", () => ({
  useJobRunner: (kind: string) => ({
    busy: false,
    runJob: kind === "kit-export"
      ? state.kitRun
      : kind === "stl-export"
        ? state.stlRun
        : state.syncRun,
  }),
}));
vi.mock("../lib/exportActions", () => ({ completeExportDownload: vi.fn() }));
vi.mock("../lib/exportStlJobResult", () => ({ handleStlPackExportJobDone: vi.fn() }));
vi.mock("./ui/command", () => ({
  CommandDialog: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <div role="dialog">{children}</div> : null,
  CommandInput: () => <input aria-label="Command search" />,
  CommandList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CommandEmpty: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CommandGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CommandItem: ({ children, disabled, onSelect }: { children: ReactNode; disabled?: boolean; onSelect?: () => void }) => (
    <button disabled={disabled} onClick={onSelect}>{children}</button>
  ),
  CommandSeparator: () => <hr />,
}));

const actions = [
  { label: "Share build…", job: "kit", destination: null },
  { label: "Export STLs (color + directory)", job: "stl", destination: null },
  { label: "Export STLs (color only)", job: "stl", destination: null },
  { label: "Export remaining (color + directory)", job: "stl", destination: "/export" },
  { label: "Export remaining (color only)", job: "stl", destination: "/export" },
] as const;

function LocationProbe() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

function renderPalette(pathname: string) {
  render(
    <MemoryRouter initialEntries={[pathname]}>
      <CommandPalette />
      <LocationProbe />
    </MemoryRouter>,
  );
  fireEvent.keyDown(window, { key: "k", metaKey: true });
}

function selectAction(label: string) {
  const labelNode = screen.getByText(label);
  const button = labelNode.closest("button");
  if (!button) throw new Error(`No command button for ${label}`);
  fireEvent.click(button);
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  state.startKit.mockResolvedValue("kit-job");
  state.startStl.mockResolvedValue("stl-job");
  state.kitRun.mockImplementation(async (start: () => Promise<string>) => {
    await start();
  });
  state.stlRun.mockImplementation(async (start: () => Promise<string>) => {
    await start();
  });
});

afterEach(cleanup);

describe.each(["/sources", "/plan"])("Command Palette exports from %s", (pathname) => {
  it.each(actions)("waits for pending saves before $label", async (action) => {
    const flush = deferred();
    state.flush.mockReturnValue(flush.promise);
    renderPalette(pathname);

    selectAction(action.label);

    expect(state.flush).toHaveBeenCalledOnce();
    expect(state.kitRun).not.toHaveBeenCalled();
    expect(state.stlRun).not.toHaveBeenCalled();
    expect(state.startKit).not.toHaveBeenCalled();
    expect(state.startStl).not.toHaveBeenCalled();
    expect(screen.getByTestId("location").textContent).toBe(pathname);
    expect(screen.getByRole("dialog")).toBeTruthy();

    flush.resolve();
    const run = action.job === "kit" ? state.kitRun : state.stlRun;
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    const expectedPath = action.destination ?? pathname;
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe(expectedPath));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it.each(actions)("keeps the palette open when the save barrier rejects for $label", async (action) => {
    state.flush.mockRejectedValue(new Error("Plan save failed"));
    renderPalette(pathname);

    selectAction(action.label);

    await waitFor(() => expect(state.toastError).toHaveBeenCalledOnce());
    expect(state.kitRun).not.toHaveBeenCalled();
    expect(state.stlRun).not.toHaveBeenCalled();
    expect(state.startKit).not.toHaveBeenCalled();
    expect(state.startStl).not.toHaveBeenCalled();
    expect(screen.getByTestId("location").textContent).toBe(pathname);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it.each(actions)("starts only the selected job after a successful barrier for $label", async (action) => {
    state.flush.mockResolvedValue(undefined);
    renderPalette(pathname);

    selectAction(action.label);

    const run = action.job === "kit" ? state.kitRun : state.stlRun;
    const otherRun = action.job === "kit" ? state.stlRun : state.kitRun;
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(otherRun).not.toHaveBeenCalled();
    expect(state.flush).toHaveBeenCalledOnce();
  });
});
