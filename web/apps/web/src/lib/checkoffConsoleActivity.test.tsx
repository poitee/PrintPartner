// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PrinterCheckoffLink } from "@print-partner/contracts";
import { fetchPrinterCheckoffLinks } from "../api/endpoints/checkoff";
import { useCheckoffPrinterActivity } from "./checkoffConsoleActivity";

vi.mock("../api/endpoints/checkoff", () => ({
  fetchPrinterCheckoffLinks: vi.fn(),
  fetchUnattributedPrints: vi.fn(async () => []),
}));
vi.mock("../api/endpoints/planVariants", () => ({
  fetchPlanPhaseManifest: vi.fn(async () => null),
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const links: PrinterCheckoffLink[] = (["watching", "awaiting_verify", "host_failed", "verified", "dismissed"] as const).map(
  (state, index) => ({
    id: String(index), profile_id: 1, integration_id: "host", printer_id: "printer",
    host_name: "Printer", filename: `part-${index}.gcode`, units: [], saw_active: true,
    created_at: "2026-09-09T00:00:00Z",
    state,
  }),
);

it("reads one Build queue per refresh and partitions its states", async () => {
  vi.mocked(fetchPrinterCheckoffLinks).mockResolvedValue({ links });
  const { result } = renderHook(() => useCheckoffPrinterActivity({ engineReady: true, profileId: 1 }));
  await waitFor(() => expect(result.current.watchingLinks).toEqual([links[0]]));
  expect(result.current.awaitingLinks).toEqual([links[1]]);
  expect(result.current.failedLinks).toEqual([links[2]]);
  expect(result.current.verifiedLinks).toEqual([links[3]]);
  expect(fetchPrinterCheckoffLinks).toHaveBeenCalledExactlyOnceWith({ profile_id: 1 });
  act(() => result.current.refreshLinks());
  await waitFor(() => expect(fetchPrinterCheckoffLinks).toHaveBeenCalledTimes(2));
});

it("does not request fleet links when no Build is selected", async () => {
  vi.mocked(fetchPrinterCheckoffLinks).mockResolvedValue({ links });
  const { result } = renderHook(() => useCheckoffPrinterActivity({ engineReady: true, profileId: null }));
  await act(async () => result.current.refreshLinks());
  expect(fetchPrinterCheckoffLinks).not.toHaveBeenCalled();
  expect(result.current.watchingLinks).toEqual([]);
});

it("ignores a previous Build's response after switching Builds", async () => {
  let resolvePrevious!: (value: { links: PrinterCheckoffLink[] }) => void;
  vi.mocked(fetchPrinterCheckoffLinks)
    .mockImplementationOnce(() => new Promise((resolve) => { resolvePrevious = resolve; }))
    .mockResolvedValueOnce({ links: [] });
  const { result, rerender } = renderHook(
    ({ profileId }) => useCheckoffPrinterActivity({ engineReady: true, profileId }),
    { initialProps: { profileId: 1 } },
  );
  rerender({ profileId: 2 });
  await waitFor(() => expect(fetchPrinterCheckoffLinks).toHaveBeenCalledTimes(2));
  await act(async () => resolvePrevious({ links }));
  expect(result.current.watchingLinks).toEqual([]);
  expect(result.current.awaitingLinks).toEqual([]);
});

it("reports queue failures and clears them after a successful retry", async () => {
  vi.mocked(fetchPrinterCheckoffLinks).mockRejectedValueOnce(new Error("offline"));
  const { result } = renderHook(() => useCheckoffPrinterActivity({ engineReady: true, profileId: 1 }));
  await waitFor(() => expect(result.current.auxiliaryError).toContain("offline"));
  vi.mocked(fetchPrinterCheckoffLinks).mockResolvedValueOnce({ links: [] });
  act(() => result.current.refreshLinks());
  await waitFor(() => expect(result.current.auxiliaryError).toBeNull());
});
