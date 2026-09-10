// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { fetchPrinterCheckoffLinks } from "../../api/endpoints/checkoff";
import { useProductionCheckoffLinks } from "./useProductionCheckoffLinks";

vi.mock("../../api/endpoints/checkoff", () => ({ fetchPrinterCheckoffLinks: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("uses one Build-scoped queue read and excludes dismissed history", async () => {
  const base = { profile_id: 7, integration_id: "host", printer_id: "printer", host_name: "Printer", filename: "part.gcode", units: [], saw_active: true, created_at: "2026-09-09T00:00:00Z" };
  vi.mocked(fetchPrinterCheckoffLinks).mockResolvedValue({ links: [
    { ...base, id: "watch", state: "watching" },
    { ...base, id: "done", state: "verified" },
    { ...base, id: "dismissed", state: "dismissed" },
  ] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { result } = renderHook(() => useProductionCheckoffLinks(7, true), {
    wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(fetchPrinterCheckoffLinks).toHaveBeenCalledExactlyOnceWith({ profile_id: 7 });
  expect(result.current.data?.map((link) => link.id)).toEqual(["watch", "done"]);
  client.clear();
});
