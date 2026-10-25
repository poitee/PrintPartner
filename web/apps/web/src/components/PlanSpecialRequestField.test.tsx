// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import PlanSpecialRequestField, {
  flushSpecialRequestSave,
  resetSpecialRequestSaveStateForTests,
} from "./PlanSpecialRequestField";
import { BuildSaveFlushProvider, useFlushBuildPageSaves } from "../context/BuildSaveFlushContext";
import {
  resetAuxiliarySaveIntentForTests,
  retainFailedAuxiliarySave,
  retryFailedAuxiliarySaves,
} from "../lib/planAuxiliarySaveIntent";
import { act, renderHook } from "@testing-library/react";

const update = vi.hoisted(() => vi.fn());
vi.mock("../queries/profiles", () => ({
  useUpdateProfileMutation: () => ({ mutateAsync: update, isPending: false }),
}));

afterEach(() => {
  cleanup();
  update.mockReset();
  resetSpecialRequestSaveStateForTests();
  resetAuxiliarySaveIntentForTests();
});

function field(value: string | null, profileId = 9001) {
  return (
    <BuildSaveFlushProvider>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <PlanSpecialRequestField profileId={profileId} value={value} />
      </QueryClientProvider>
    </BuildSaveFlushProvider>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

it("special_request_barrier_waits_for_in_flight_save", async () => {
  const pending = deferred<undefined>();
  update.mockImplementationOnce(() => pending.promise);
  render(field(null));
  fireEvent.change(screen.getByRole("textbox", { name: "Special request" }), {
    target: { value: "Wait for in-flight" },
  });
  fireEvent.blur(screen.getByRole("textbox", { name: "Special request" }));
  await waitFor(() => expect(update).toHaveBeenCalledOnce());

  let finished = false;
  const barrier = flushSpecialRequestSave(9001, update, null).finally(() => {
    finished = true;
  });
  await act(async () => Promise.resolve());
  expect(finished).toBe(false);

  pending.resolve(undefined);
  await barrier;
  expect(finished).toBe(true);
  expect(update).toHaveBeenCalledTimes(1);
});

it("flushAll barrier waits for an in-flight special-request save", async () => {
  const pending = deferred<undefined>();
  update.mockImplementationOnce(() => pending.promise);
  const { result } = renderHook(() => useFlushBuildPageSaves(), {
    wrapper: ({ children }) => (
      <BuildSaveFlushProvider>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          {children}
          <PlanSpecialRequestField profileId={9001} value={null} />
        </QueryClientProvider>
      </BuildSaveFlushProvider>
    ),
  });

  fireEvent.change(screen.getByRole("textbox", { name: "Special request" }), {
    target: { value: "Barrier waits" },
  });
  fireEvent.blur(screen.getByRole("textbox", { name: "Special request" }));
  await waitFor(() => expect(update).toHaveBeenCalledOnce());

  let finished = false;
  const barrier = result.current().finally(() => {
    finished = true;
  });
  await act(async () => Promise.resolve());
  expect(finished).toBe(false);

  pending.resolve(undefined);
  await barrier;
  expect(finished).toBe(true);
  expect(update).toHaveBeenCalledTimes(1);
});

it("keeps a failed special request across navigation and retries it", async () => {
  update.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(undefined);
  const page = render(field(null));
  fireEvent.change(screen.getByRole("textbox", { name: "Special request" }), { target: { value: "Audit offline request draft" } });
  fireEvent.blur(screen.getByRole("textbox", { name: "Special request" }));
  await waitFor(() => expect(update).toHaveBeenCalledOnce());
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("offline"));
  expect(window.dispatchEvent(new Event("beforeunload", { cancelable: true }))).toBe(false);

  page.unmount();
  const returned = render(field(null));
  expect(screen.getByRole("textbox", { name: "Special request" })).toHaveProperty("value", "Audit offline request draft");
  fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
  await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
  expect(update.mock.calls[0]?.[0]).toEqual({ id: 9001, special_request: "Audit offline request draft" });
  expect(update.mock.calls[1]).toEqual(update.mock.calls[0]);
  returned.rerender(field("Audit offline request draft"));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(window.dispatchEvent(new Event("beforeunload", { cancelable: true }))).toBe(true);
});

it("keeps an unblurred request with its Build when switching Builds", async () => {
  update.mockResolvedValue(undefined);
  const first = render(field(null, 9002));
  fireEvent.change(screen.getByRole("textbox", { name: "Special request" }), { target: { value: "Keep with Build 9002" } });
  expect(window.dispatchEvent(new Event("beforeunload", { cancelable: true }))).toBe(false);
  first.unmount();
  const other = render(field(null, 9003));
  expect(screen.getByRole("textbox", { name: "Special request" })).toHaveProperty("value", "");
  other.unmount();
  const returned = render(field(null, 9002));
  expect(screen.getByRole("textbox", { name: "Special request" })).toHaveProperty("value", "Keep with Build 9002");
  fireEvent.blur(screen.getByRole("textbox", { name: "Special request" }));
  await waitFor(() => expect(update).toHaveBeenCalledWith({ id: 9002, special_request: "Keep with Build 9002" }));
  returned.rerender(field("Keep with Build 9002", 9002));
  await waitFor(() => expect(window.dispatchEvent(new Event("beforeunload", { cancelable: true }))).toBe(true));
});

it("failed_special_request_retry_preserves_order", async () => {
  const order: string[] = [];
  retainFailedAuxiliarySave(9001, "manifest", async () => {
    order.push("manifest");
  });
  update
    .mockRejectedValueOnce(new Error("offline"))
    .mockRejectedValueOnce(new Error("still offline"))
    .mockImplementationOnce(async () => {
      order.push("special_request");
    });
  const page = render(field(null));
  fireEvent.change(screen.getByRole("textbox", { name: "Special request" }), { target: { value: "Retry after manifest" } });
  fireEvent.blur(screen.getByRole("textbox", { name: "Special request" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("offline"));
  // A second failure updates the retained save but keeps its first-failure slot.
  fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("still offline"));

  await act(async () => {
    await retryFailedAuxiliarySaves(9001);
  });

  expect(order).toEqual(["manifest", "special_request"]);
  expect(update).toHaveBeenCalledTimes(3);
  expect(update.mock.calls[2]?.[0]).toEqual({ id: 9001, special_request: "Retry after manifest" });
  page.rerender(field("Retry after manifest"));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});
