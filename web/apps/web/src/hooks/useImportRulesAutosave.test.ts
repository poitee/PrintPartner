// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useImportRulesAutosave } from "./useImportRulesAutosave";

const { saveImportRules } = vi.hoisted(() => ({ saveImportRules: vi.fn() }));
vi.mock("../api/endpoints/sources", () => ({ saveImportRules }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("useImportRulesAutosave", () => {
  afterEach(() => {
    cleanup();
    saveImportRules.mockReset();
  });

  it("serializes writes and keeps the newest edit visible while an old write completes", async () => {
    const first = deferred<{ rules: string[] }>();
    const second = deferred<{ rules: string[] }>();
    saveImportRules.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const onSaved = vi.fn();
    const hook = renderHook(({ pendingRules, savedRules }) => useImportRulesAutosave({
      sourceId: 5,
      pendingRules,
      savedRules,
      rulesLoaded: true,
      userEdited: true,
      disabled: false,
      onSaved,
    }), { initialProps: { pendingRules: [], savedRules: [] } });

    act(() => {
      hook.result.current.saveUserEdit(["first.stl"]);
      hook.result.current.saveUserEdit(["second.stl"]);
      hook.result.current.saveUserEdit(["latest.stl"]);
      hook.rerender({ pendingRules: ["latest.stl"], savedRules: [] });
    });
    expect(saveImportRules).toHaveBeenCalledTimes(1);

    await act(async () => { first.resolve({ rules: ["first.stl"] }); await first.promise; });
    await waitFor(() => expect(saveImportRules).toHaveBeenCalledTimes(2));
    expect(saveImportRules.mock.calls[1]).toEqual([5, ["latest.stl"]]);
    expect(onSaved).not.toHaveBeenCalled();

    await act(async () => { second.resolve({ rules: ["latest.stl"] }); await second.promise; });
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(["latest.stl"]);
  });

  it("rejects a failed flush so navigation can keep the editor open", async () => {
    saveImportRules.mockRejectedValue(new Error("offline"));
    const hook = renderHook(() => useImportRulesAutosave({
      sourceId: 5,
      pendingRules: [],
      savedRules: [],
      rulesLoaded: true,
      userEdited: true,
      disabled: false,
      onSaved: vi.fn(),
    }));
    act(() => hook.result.current.saveUserEdit(["latest.stl"]));
    await waitFor(() => expect(hook.result.current.status).toBe("error"));
    await expect(hook.result.current.saveNow()).rejects.toThrow("offline");
  });
});
