// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BuildSaveFlushProvider,
  useBuildSaveFlushRegistry,
  useFlushBuildPageSaves,
} from "./BuildSaveFlushContext";

afterEach(cleanup);

describe("BuildSaveFlushProvider", () => {
  it("keeps same-Build producers independent and cleans up only its own registration", async () => {
    const { result } = renderHook(
      () => ({ register: useBuildSaveFlushRegistry(), flushAll: useFlushBuildPageSaves() }),
      { wrapper: BuildSaveFlushProvider },
    );
    const flushFirst = vi.fn(async () => {});
    const flushSecond = vi.fn(async () => {});

    const unregisterFirst = result.current.register(1, flushFirst);
    const unregisterSecond = result.current.register(1, flushSecond);
    await act(() => result.current.flushAll());
    expect(flushFirst).toHaveBeenCalledTimes(1);
    expect(flushSecond).toHaveBeenCalledTimes(1);

    unregisterFirst();
    await act(() => result.current.flushAll());
    expect(flushFirst).toHaveBeenCalledTimes(1);
    expect(flushSecond).toHaveBeenCalledTimes(2);

    unregisterSecond();
    await act(() => result.current.flushAll());
    expect(flushSecond).toHaveBeenCalledTimes(2);
  });

  it("waits for every producer before returning a failure", async () => {
    const { result } = renderHook(
      () => ({ register: useBuildSaveFlushRegistry(), flushAll: useFlushBuildPageSaves() }),
      { wrapper: BuildSaveFlushProvider },
    );
    let finishSlowSave!: () => void;
    const slowSave = new Promise<void>((resolve) => {
      finishSlowSave = resolve;
    });
    const failure = new Error("Plan save failed");
    result.current.register(1, async () => {
      throw failure;
    });
    result.current.register(1, () => slowSave);

    let finished = false;
    const barrier = result.current.flushAll().finally(() => {
      finished = true;
    });
    await act(async () => Promise.resolve());
    expect(finished).toBe(false);
    finishSlowSave();
    await expect(barrier).rejects.toBe(failure);
    expect(finished).toBe(true);
  });
});
