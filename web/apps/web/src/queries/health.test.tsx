// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { HealthResponse } from "@print-partner/contracts";
import { fetchHealth } from "../api/endpoints/help";
import { useHealthQuery } from "./health";

vi.mock("../api/endpoints/help", () => ({
  fetchHealth: vi.fn(),
}));

function renderHealthQuery() {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useHealthQuery(), { wrapper });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("useHealthQuery", () => {
  it("sends one health request per poll", async () => {
    const health = { ok: true, data_dir: "/data" } as HealthResponse;
    vi.mocked(fetchHealth).mockResolvedValue(health);

    const { result } = renderHealthQuery();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(fetchHealth).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual(health);

    await act(() => vi.advanceTimersByTimeAsync(8000));
    expect(fetchHealth).toHaveBeenCalledTimes(2);
  });

  it("reports an unreachable server after retries", async () => {
    vi.mocked(fetchHealth).mockRejectedValue(new TypeError("Failed to fetch"));

    const { result } = renderHealthQuery();
    await act(() => vi.advanceTimersByTimeAsync(3500));

    expect(fetchHealth).toHaveBeenCalledTimes(3);
    expect(result.current.error?.message).toBe(
      "API server is not reachable. Start the server with `npm run dev` from web/.",
    );
  });
});
