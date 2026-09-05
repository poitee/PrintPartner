import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppRepository } from "../db/repository.js";

const watcherState = vi.hoisted(() => {
  const handlers = new Map<string, (path: string) => void>();
  const watcher = {
    on(event: string, handler: (path: string) => void) {
      handlers.set(event, handler);
      return watcher;
    },
    once() {
      return watcher;
    },
    close: vi.fn(async () => {}),
  };
  return { handlers, watcher };
});

vi.mock("chokidar", () => ({
  default: {
    watch: vi.fn(() => watcherState.watcher),
  },
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  readFileSync: vi.fn(() =>
    JSON.stringify({
      name: "Windows Process",
      type: "process",
    }),
  ),
}));

import { startProfileSyncWatcher } from "./profile-sync.js";

describe("profile-sync Windows event paths", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    watcherState.handlers.clear();
    watcherState.watcher.close.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("matches Chokidar's normalized event path to a Windows watch directory", async () => {
    const upsertSyncedProcessProfile = vi.fn();
    const repository = {
      upsertSyncedProcessProfile,
    } as unknown as AppRepository;
    const handle = startProfileSyncWatcher(
      repository,
      {
        enabled: true,
        roots: [
          {
            kind: "orca",
            baseDir: "C:\\SlicerProfiles",
            dirs: { process: "user\\process" },
          },
        ],
      },
      () => {},
    );

    const onAdd = watcherState.handlers.get("add");
    expect(onAdd).toBeTypeOf("function");
    onAdd?.("C:/SlicerProfiles/user/process/windows.json");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(upsertSyncedProcessProfile).toHaveBeenCalledOnce();
    expect(upsertSyncedProcessProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Windows Process",
        sourcePath: "C:/SlicerProfiles/user/process/windows.json",
      }),
    );
    await handle.stop();
  });
});
