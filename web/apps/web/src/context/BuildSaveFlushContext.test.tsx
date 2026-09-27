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
  it("keeps import-rule and kit-manifest flushes with the same id apart", async () => {
    const { result } = renderHook(
      () => ({
        rules: useBuildSaveFlushRegistry("importRules"),
        manifest: useBuildSaveFlushRegistry("kitManifest"),
        flushAll: useFlushBuildPageSaves(),
      }),
      { wrapper: BuildSaveFlushProvider },
    );
    const flushRules = vi.fn(async () => {});
    const flushManifest = vi.fn(async () => {});

    result.current.rules.registerFlush(1, flushRules);
    result.current.manifest.registerFlush(1, flushManifest);
    await act(() => result.current.flushAll());
    expect(flushRules).toHaveBeenCalledTimes(1);
    expect(flushManifest).toHaveBeenCalledTimes(1);

    result.current.rules.unregisterFlush(1);
    await act(() => result.current.flushAll());
    expect(flushRules).toHaveBeenCalledTimes(1);
    expect(flushManifest).toHaveBeenCalledTimes(2);
  });
});
