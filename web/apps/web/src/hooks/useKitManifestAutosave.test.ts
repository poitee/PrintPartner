// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManifestSelections } from "@print-partner/contracts";
import type { KitManifest } from "../api/endpoints/planManifests";
import { useKitManifestAutosave } from "./useKitManifestAutosave";

const mocks = vi.hoisted(() => ({
  savePlanKitManifest: vi.fn(),
}));

vi.mock("../api/endpoints/planManifests", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/endpoints/planManifests")>();
  return {
    ...actual,
    savePlanKitManifest: mocks.savePlanKitManifest,
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function kit(selections: ManifestSelections): KitManifest {
  return {
    name: null,
    layers: [],
    base_source_id: null,
    addon_source_ids: [],
    selections,
    include: [],
    exclude: [],
    replacements: {},
    choice_tree: [],
    category_links: [],
  };
}

type HookProps = {
  profileId: number;
  pendingSelections: ManifestSelections;
  savedSelections: ManifestSelections;
};

function renderAutosave(onSaved = vi.fn()) {
  const baseKit = kit({});
  const hook = renderHook(
    ({ profileId, pendingSelections, savedSelections }: HookProps) =>
      useKitManifestAutosave({
        profileId,
        pendingSelections,
        savedSelections,
        loaded: true,
        userEdited: true,
        disabled: false,
        baseKit,
        onSaved,
      }),
    {
      initialProps: {
        profileId: 7,
        pendingSelections: {},
        savedSelections: {},
      },
    },
  );
  return { ...hook, onSaved };
}

describe("useKitManifestAutosave", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("serializes rapid edits and coalesces the queue to the latest selections", async () => {
    const first = deferred<KitManifest>();
    const latest = deferred<KitManifest>();
    mocks.savePlanKitManifest
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => latest.promise);
    const { result, onSaved, rerender } = renderAutosave();

    act(() => {
      result.current.saveUserEdit({ extras: ["skirts"] });
      result.current.saveUserEdit({ extras: ["skirts", "panels"] });
      result.current.saveUserEdit({ extras: ["skirts", "panels", "screen"] });
      rerender({
        profileId: 7,
        pendingSelections: { extras: ["skirts", "panels", "screen"] },
        savedSelections: {},
      });
    });

    expect(mocks.savePlanKitManifest).toHaveBeenCalledTimes(1);
    expect(mocks.savePlanKitManifest.mock.calls[0]?.[1].selections).toEqual({
      extras: ["skirts"],
    });

    await act(async () => {
      first.resolve(kit({ extras: ["skirts"] }));
      await first.promise;
    });

    await waitFor(() => {
      expect(mocks.savePlanKitManifest).toHaveBeenCalledTimes(2);
    });
    expect(mocks.savePlanKitManifest.mock.calls[1]?.[1].selections).toEqual({
      extras: ["skirts", "panels", "screen"],
    });

    await act(async () => {
      latest.resolve(kit({ extras: ["skirts", "panels", "screen"] }));
      await latest.promise;
    });

    expect(mocks.savePlanKitManifest).toHaveBeenCalledTimes(2);
    expect(onSaved).toHaveBeenCalledTimes(2);
    expect(onSaved).toHaveBeenLastCalledWith(
      kit({ extras: ["skirts", "panels", "screen"] }),
    );
  });

  it("keeps the latest edit available for an explicit retry after an error", async () => {
    mocks.savePlanKitManifest
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(kit({ extras: ["skirts", "panels"] }));
    const { result, onSaved, rerender } = renderAutosave();

    act(() => {
      result.current.saveUserEdit({ extras: ["skirts", "panels"] });
      rerender({
        profileId: 7,
        pendingSelections: { extras: ["skirts", "panels"] },
        savedSelections: {},
      });
    });
    await waitFor(() => expect(result.current.status).toBe("error"));

    await act(async () => {
      await result.current.saveNow();
    });

    expect(mocks.savePlanKitManifest).toHaveBeenCalledTimes(2);
    expect(onSaved).toHaveBeenLastCalledWith(
      kit({ extras: ["skirts", "panels"] }),
    );
    expect(result.current.status).toBe("saved");
  });

  it("keeps in-flight saves isolated when the active profile changes", async () => {
    const oldProfile = deferred<KitManifest>();
    const newProfile = deferred<KitManifest>();
    mocks.savePlanKitManifest
      .mockImplementationOnce(() => oldProfile.promise)
      .mockImplementationOnce(() => newProfile.promise);
    const { result, onSaved, rerender } = renderAutosave();

    act(() => {
      result.current.saveUserEdit({ extras: ["skirts"] });
      rerender({
        profileId: 7,
        pendingSelections: { extras: ["skirts"] },
        savedSelections: {},
      });
    });

    act(() => {
      rerender({
        profileId: 8,
        pendingSelections: { extras: ["skirts"] },
        savedSelections: {},
      });
    });
    expect(mocks.savePlanKitManifest).toHaveBeenCalledTimes(1);
    act(() => {
      rerender({
        profileId: 8,
        pendingSelections: {},
        savedSelections: {},
      });
    });
    act(() => {
      result.current.saveUserEdit({ extras: ["panels"] });
      rerender({
        profileId: 8,
        pendingSelections: { extras: ["panels"] },
        savedSelections: {},
      });
    });

    expect(mocks.savePlanKitManifest).toHaveBeenCalledTimes(2);
    expect(mocks.savePlanKitManifest.mock.calls[0]?.[0]).toBe(7);
    expect(mocks.savePlanKitManifest.mock.calls[0]?.[1].selections).toEqual({
      extras: ["skirts"],
    });
    expect(mocks.savePlanKitManifest.mock.calls[1]?.[0]).toBe(8);
    expect(mocks.savePlanKitManifest.mock.calls[1]?.[1].selections).toEqual({
      extras: ["panels"],
    });

    await act(async () => {
      newProfile.resolve(kit({ extras: ["panels"] }));
      await newProfile.promise;
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenLastCalledWith(kit({ extras: ["panels"] }));

    await act(async () => {
      oldProfile.resolve(kit({ extras: ["skirts"] }));
      await oldProfile.promise;
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("saved");
  });

  it("does not let a detached profile flush read the new profile's reset state", async () => {
    const oldProfile = deferred<KitManifest>();
    mocks.savePlanKitManifest
      .mockImplementationOnce(() => oldProfile.promise)
      .mockResolvedValueOnce(kit({}));
    const { result, rerender } = renderAutosave();

    act(() => {
      result.current.saveUserEdit({ extras: ["skirts"] });
      rerender({
        profileId: 7,
        pendingSelections: { extras: ["skirts"] },
        savedSelections: {},
      });
    });
    act(() => {
      rerender({
        profileId: 8,
        pendingSelections: { extras: ["skirts"] },
        savedSelections: {},
      });
    });
    act(() => {
      rerender({
        profileId: 8,
        pendingSelections: {},
        savedSelections: {},
      });
    });

    await act(async () => {
      oldProfile.resolve(kit({ extras: ["skirts"] }));
      await oldProfile.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mocks.savePlanKitManifest).toHaveBeenCalledTimes(1);
    expect(mocks.savePlanKitManifest).toHaveBeenLastCalledWith(
      7,
      expect.objectContaining({ selections: { extras: ["skirts"] } }),
    );
  });
});
