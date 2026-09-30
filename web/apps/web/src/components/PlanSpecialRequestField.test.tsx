// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import PlanSpecialRequestField from "./PlanSpecialRequestField";

const update = vi.hoisted(() => vi.fn());
vi.mock("../queries/profiles", () => ({
  useUpdateProfileMutation: () => ({ mutateAsync: update, isPending: false }),
}));

afterEach(() => {
  cleanup();
  update.mockReset();
});

it("keeps a failed special request across navigation and retries it", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  update.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(undefined);
  const field = (value: string | null) => (
    <QueryClientProvider client={client}>
      <PlanSpecialRequestField profileId={9001} value={value} />
    </QueryClientProvider>
  );
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
  client.clear();
});

it("keeps an unblurred request with its Build when switching Builds", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  update.mockResolvedValue(undefined);
  const field = (profileId: number, value: string | null) => (
    <QueryClientProvider client={client}>
      <PlanSpecialRequestField profileId={profileId} value={value} />
    </QueryClientProvider>
  );
  const first = render(field(9002, null));
  fireEvent.change(screen.getByRole("textbox", { name: "Special request" }), { target: { value: "Keep with Build 9002" } });
  expect(window.dispatchEvent(new Event("beforeunload", { cancelable: true }))).toBe(false);
  first.unmount();
  const other = render(field(9003, null));
  expect(screen.getByRole("textbox", { name: "Special request" })).toHaveProperty("value", "");
  other.unmount();
  const returned = render(field(9002, null));
  expect(screen.getByRole("textbox", { name: "Special request" })).toHaveProperty("value", "Keep with Build 9002");
  fireEvent.blur(screen.getByRole("textbox", { name: "Special request" }));
  await waitFor(() => expect(update).toHaveBeenCalledWith({ id: 9002, special_request: "Keep with Build 9002" }));
  returned.rerender(field(9002, "Keep with Build 9002"));
  await waitFor(() => expect(window.dispatchEvent(new Event("beforeunload", { cancelable: true }))).toBe(true));
  client.clear();
});
