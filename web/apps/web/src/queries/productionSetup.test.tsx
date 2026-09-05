// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import {
  defaultProductionSetup,
  type ProductionSetup,
  type ProductionSetupCommand,
} from "@print-partner/contracts";
import {
  applyProductionSetupCommand,
  fetchProductionSetup,
} from "../api/endpoints/productionSetup";
import { productionSetupKey, useProductionSetup } from "./productionSetup";

const stored: ProductionSetup = {
  ...defaultProductionSetup(1),
  preferred_slicer_instance_id: "orca-1",
  selection: { mode: "custom", selected_unit_tokens: ["unit-a", "unit-b"] },
  printer_assignments: [{ token: "unit-a", printer_id: "printer-1" }],
  route: "plates",
  rules: [{ id: "r1", enabled: true, kind: "separate_by", field: "color" }],
};

vi.mock("../api/endpoints/productionSetup", () => ({
  applyProductionSetupCommand: vi.fn(),
  fetchProductionSetup: vi.fn(),
}));

function applyCommand(
  setup: ProductionSetup,
  command: ProductionSetupCommand,
): ProductionSetup {
  switch (command.kind) {
    case "set_preferred_slicer_instance":
      return { ...setup, preferred_slicer_instance_id: command.preferred_slicer_instance_id };
    case "set_selection":
      return { ...setup, selection: command.selection };
    case "replace_printer_assignments":
      return { ...setup, printer_assignments: command.printer_assignments };
    case "set_route":
      return { ...setup, route: command.route };
    case "replace_rules":
      return { ...setup, rules: command.rules };
  }
}

function createDeferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  if (!resolve || !reject) throw new Error("Deferred promise was not initialized");
  return { promise, resolve, reject };
}

function wrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false },
    },
  });
}

function mount(profileId: number | null) {
  const queryClient = createQueryClient();
  const { result } = renderHook(() => useProductionSetup(profileId), {
    wrapper: wrapper(queryClient),
  });
  return { queryClient, result };
}

function startSave(action: () => Promise<ProductionSetup>): Promise<ProductionSetup> {
  let promise: Promise<ProductionSetup> | undefined;
  act(() => {
    promise = action();
  });
  if (!promise) throw new Error("Save did not start");
  return promise;
}

beforeEach(() => {
  const server = new Map<number, ProductionSetup>([
    [1, stored],
    [2, defaultProductionSetup(2)],
  ]);
  vi.mocked(fetchProductionSetup).mockImplementation(async (profileId) =>
    server.get(profileId) ?? defaultProductionSetup(profileId)
  );
  vi.mocked(applyProductionSetupCommand).mockImplementation(async (profileId, command) => {
    const current = server.get(profileId) ?? defaultProductionSetup(profileId);
    const next = applyCommand(current, command);
    server.set(profileId, next);
    return next;
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useProductionSetup", () => {
  it("sends only the command owned by the caller", async () => {
    const { result } = mount(1);
    await waitFor(() => expect(result.current.data).toEqual(stored));

    const command = { kind: "set_route", route: "stl" } as const;
    await result.current.save(command);

    expect(applyProductionSetupCommand).toHaveBeenCalledWith(1, command);
  });

  it("cancels competing reads and publishes the canonical response", async () => {
    const { queryClient, result } = mount(1);
    await waitFor(() => expect(result.current.data).toEqual(stored));
    const cancelQueries = vi.spyOn(queryClient, "cancelQueries");

    await result.current.save({ kind: "set_route", route: "external" });

    expect(cancelQueries).toHaveBeenCalledWith({ queryKey: productionSetupKey(1) });
    expect(queryClient.getQueryData<ProductionSetup>(productionSetupKey(1))?.route).toBe(
      "external",
    );
  });

  it("serializes commands across hook instances and exposes shared pending state", async () => {
    const firstResponse = createDeferred<ProductionSetup>();
    const secondResponse = createDeferred<ProductionSetup>();
    vi.mocked(applyProductionSetupCommand)
      .mockImplementationOnce(() => firstResponse.promise)
      .mockImplementationOnce(() => secondResponse.promise);
    const queryClient = createQueryClient();
    const { result } = renderHook(() => ({
      first: useProductionSetup(1),
      second: useProductionSetup(1),
    }), { wrapper: wrapper(queryClient) });
    await waitFor(() => expect(result.current.first.data).toEqual(stored));

    const firstCommand = { kind: "set_route", route: "stl" } as const;
    const secondCommand: ProductionSetupCommand = {
      kind: "replace_rules",
      rules: [{ id: "r2", enabled: true, kind: "separate_by", field: "material" }],
    };
    const firstSave = startSave(() => result.current.first.save(firstCommand));
    const secondSave = startSave(() => result.current.second.save(secondCommand));

    await waitFor(() => {
      expect(applyProductionSetupCommand).toHaveBeenCalledTimes(1);
      expect(result.current.first.saving).toBe(true);
      expect(result.current.second.saving).toBe(true);
    });

    const afterFirst = applyCommand(stored, firstCommand);
    firstResponse.resolve(afterFirst);
    await firstSave;
    await waitFor(() => expect(applyProductionSetupCommand).toHaveBeenCalledTimes(2));
    expect(applyProductionSetupCommand).toHaveBeenNthCalledWith(2, 1, secondCommand);

    const afterSecond = applyCommand(afterFirst, secondCommand);
    secondResponse.resolve(afterSecond);
    await secondSave;
    await waitFor(() => {
      expect(result.current.first.saving).toBe(false);
      expect(result.current.second.saving).toBe(false);
    });
    expect(queryClient.getQueryData(productionSetupKey(1))).toEqual(afterSecond);
  });

  it("continues a Build queue after a command fails", async () => {
    const firstResponse = createDeferred<ProductionSetup>();
    vi.mocked(applyProductionSetupCommand)
      .mockImplementationOnce(() => firstResponse.promise)
      .mockResolvedValueOnce({ ...stored, route: "external" });
    const queryClient = createQueryClient();
    const { result } = renderHook(() => ({
      first: useProductionSetup(1),
      second: useProductionSetup(1),
    }), { wrapper: wrapper(queryClient) });
    await waitFor(() => expect(result.current.first.data).toEqual(stored));

    const failedSave = startSave(() => result.current.first.save({
      kind: "set_route",
      route: "stl",
    }));
    const nextSave = startSave(() => result.current.second.save({
      kind: "set_route",
      route: "external",
    }));
    await waitFor(() => expect(applyProductionSetupCommand).toHaveBeenCalledTimes(1));

    firstResponse.reject(new Error("save failed"));
    await expect(failedSave).rejects.toThrow("save failed");
    await expect(nextSave).resolves.toMatchObject({ route: "external" });
    expect(applyProductionSetupCommand).toHaveBeenCalledTimes(2);
  });

  it("does not serialize commands for different Builds", async () => {
    const firstResponse = createDeferred<ProductionSetup>();
    const secondResponse = createDeferred<ProductionSetup>();
    vi.mocked(applyProductionSetupCommand).mockImplementation((profileId) =>
      profileId === 1 ? firstResponse.promise : secondResponse.promise
    );
    const queryClient = createQueryClient();
    const { result } = renderHook(() => ({
      first: useProductionSetup(1),
      second: useProductionSetup(2),
    }), { wrapper: wrapper(queryClient) });
    await waitFor(() => {
      expect(result.current.first.data).toEqual(stored);
      expect(result.current.second.data).toEqual(defaultProductionSetup(2));
    });

    const firstSave = startSave(() => result.current.first.save({
      kind: "set_route",
      route: "plates",
    }));
    const secondSave = startSave(() => result.current.second.save({
      kind: "set_route",
      route: "stl",
    }));
    await waitFor(() => expect(applyProductionSetupCommand).toHaveBeenCalledTimes(2));

    firstResponse.resolve(stored);
    secondResponse.resolve({ ...defaultProductionSetup(2), route: "stl" });
    await Promise.all([firstSave, secondSave]);
  });

  it("refuses to save before the record has loaded", async () => {
    const { result } = mount(null);
    await expect(result.current.save({ kind: "set_route", route: "stl" })).rejects.toThrow(
      "Production setup has not loaded yet.",
    );
    expect(applyProductionSetupCommand).not.toHaveBeenCalled();
    expect(fetchProductionSetup).not.toHaveBeenCalled();
  });
});
