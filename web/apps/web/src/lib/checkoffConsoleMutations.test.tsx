// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReviewPart } from "../api/endpoints/planManifests";
import { useCheckoffProgressMutations } from "./checkoffConsoleMutations";

afterEach(cleanup);

const part: ReviewPart = {
  id: 11,
  match_key: "part.stl",
  relative_path: "folder/part.stl",
  filename: "part.stl",
  source_layer: null,
  status: "active",
  role: "part",
  requirement: null,
  option_group_id: null,
  included: true,
  filament_color_id: null,
  quantity_auto: 1,
  quantity_override: null,
  quantity_effective: 1,
  print_units: [false],
  printed_count: 0,
  missing: true,
  filament_display: "Red PLA",
};

function deferred() {
  let resolve: (() => void) | undefined;
  let reject: ((reason: Error) => void) | undefined;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  if (!resolve || !reject) throw new Error("Deferred mutation was not initialized");
  return { promise, resolve, reject };
}

it("ignores a pending mutation failure after clearing row errors", async () => {
  const previous = deferred();
  const run = vi.fn(() => previous.promise);
  const { result } = renderHook(useCheckoffProgressMutations);

  act(() => result.current.runMutation({ part, action: "checkoff", run }));
  act(() => result.current.clearAll());
  await act(async () => previous.reject(new Error("previous Build went offline")));

  expect(result.current.rowErrors).toEqual({});
  act(() => result.current.retryRow(part.id));
  expect(run).toHaveBeenCalledTimes(1);
});

it("keeps a current failure and its retry when a cleared mutation succeeds", async () => {
  const previous = deferred();
  const currentRun = vi.fn<() => Promise<void>>()
    .mockRejectedValueOnce(new Error("current change went offline"))
    .mockResolvedValueOnce(undefined);
  const { result } = renderHook(useCheckoffProgressMutations);

  act(() => result.current.runMutation({ part, action: "checkoff", run: () => previous.promise }));
  act(() => result.current.clearAll());
  await act(async () => result.current.runMutation({ part, action: "assembly", run: currentRun }));
  expect(result.current.rowErrors["part:11"]?.message).toContain("current change went offline");

  await act(async () => previous.resolve());

  expect(result.current.rowErrors["part:11"]?.message).toContain("current change went offline");
  await act(async () => result.current.retryRow(part.id));
  expect(currentRun).toHaveBeenCalledTimes(2);
  expect(result.current.rowErrors).toEqual({});
});
