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
  it("flushes every registered Profile until it unregisters", async () => {
    const { result } = renderHook(
      () => ({ registry: useBuildSaveFlushRegistry(), flushAll: useFlushBuildPageSaves() }),
      { wrapper: BuildSaveFlushProvider },
    );
    const flushFirst = vi.fn(async () => {});
    const flushSecond = vi.fn(async () => {});

    result.current.registry.registerFlush(1, flushFirst);
    result.current.registry.registerFlush(2, flushSecond);
    await act(() => result.current.flushAll());
    expect(flushFirst).toHaveBeenCalledTimes(1);
    expect(flushSecond).toHaveBeenCalledTimes(1);

    result.current.registry.unregisterFlush(1);
    await act(() => result.current.flushAll());
    expect(flushFirst).toHaveBeenCalledTimes(1);
    expect(flushSecond).toHaveBeenCalledTimes(2);
  });
});
