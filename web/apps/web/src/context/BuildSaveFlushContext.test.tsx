// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KitManifest } from "../api/endpoints/planManifests";
import PlanSpecialRequestField, {
  resetSpecialRequestSaveStateForTests,
} from "../components/PlanSpecialRequestField";
import {
  resetKitManifestAutosaveForTests,
  useKitManifestAutosave,
} from "../hooks/useKitManifestAutosave";
import { resetAuxiliarySaveIntentForTests } from "../lib/planAuxiliarySaveIntent";
import {
  BuildSaveFlushProvider,
  useBuildSaveFlushRegistry,
  useFlushBuildPageSaves,
  useRetryBuildPageSaves,
} from "./BuildSaveFlushContext";

const saves = vi.hoisted(() => ({ updateProfile: vi.fn(), savePlanKitManifest: vi.fn() }));

vi.mock("../queries/profiles", () => ({
  useUpdateProfileMutation: () => ({ mutateAsync: saves.updateProfile, isPending: false }),
}));

vi.mock("../api/endpoints/planManifests", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/endpoints/planManifests")>()),
  savePlanKitManifest: saves.savePlanKitManifest,
}));

function resetSaveState() {
  resetSpecialRequestSaveStateForTests();
  resetKitManifestAutosaveForTests();
  resetAuxiliarySaveIntentForTests();
}

beforeEach(resetSaveState);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  resetSaveState();
});

describe("BuildSaveFlushProvider", () => {
  it("keeps same-Build producers independent and cleans up only its own registration", async () => {
    const { result } = renderHook(
      () => ({ register: useBuildSaveFlushRegistry(), flushAll: useFlushBuildPageSaves() }),
      { wrapper: BuildSaveFlushProvider },
    );
    const flushFirst = vi.fn(async () => {});
    const flushSecond = vi.fn(async () => {});

    const unregisterFirst = result.current.register(1, flushFirst);
    const unregisterSecond = result.current.register(1, flushSecond);
    await act(() => result.current.flushAll());
    expect(flushFirst).toHaveBeenCalledTimes(1);
    expect(flushSecond).toHaveBeenCalledTimes(1);

    unregisterFirst();
    await act(() => result.current.flushAll());
    expect(flushFirst).toHaveBeenCalledTimes(1);
    expect(flushSecond).toHaveBeenCalledTimes(2);

    unregisterSecond();
    await act(() => result.current.flushAll());
    expect(flushSecond).toHaveBeenCalledTimes(2);
  });

  it("waits for every producer before returning a failure", async () => {
    const { result } = renderHook(
      () => ({ register: useBuildSaveFlushRegistry(), flushAll: useFlushBuildPageSaves() }),
      { wrapper: BuildSaveFlushProvider },
    );
    let finishSlowSave!: () => void;
    const slowSave = new Promise<void>((resolve) => {
      finishSlowSave = resolve;
    });
    const failure = new Error("Plan save failed");
    result.current.register(1, async () => {
      throw failure;
    });
    result.current.register(1, () => slowSave);

    let finished = false;
    const barrier = result.current.flushAll().finally(() => {
      finished = true;
    });
    await act(async () => Promise.resolve());
    expect(finished).toBe(false);
    finishSlowSave();
    await expect(barrier).rejects.toBe(failure);
    expect(finished).toBe(true);
  });
});

const BUILD_ID = 41;

function kit(extras: string[]): KitManifest {
  return {
    name: null,
    layers: [],
    base_source_id: null,
    addon_source_ids: [],
    selections: { extras },
    include: [],
    exclude: [],
    replacements: {},
    choice_tree: [],
    category_links: [],
  };
}

function BuildEditors({ children }: { children: ReactNode }) {
  return (
    <BuildSaveFlushProvider>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        {children}
        <PlanSpecialRequestField profileId={BUILD_ID} value={null} />
      </QueryClientProvider>
    </BuildSaveFlushProvider>
  );
}

const NO_SELECTIONS = {};
const BASE_KIT = kit([]);

/** Both auxiliary Save producers for one Build, with one refused save each. */
async function renderBuildWithFailedSaves() {
  saves.updateProfile.mockRejectedValueOnce(new Error("Special request refused"));
  saves.savePlanKitManifest.mockRejectedValueOnce(new Error("Manifest refused"));
  const page = renderHook(
    () => ({
      flushAll: useFlushBuildPageSaves(),
      retryAll: useRetryBuildPageSaves(),
      manifest: useKitManifestAutosave({
        profileId: BUILD_ID,
        pendingSelections: NO_SELECTIONS,
        savedSelections: NO_SELECTIONS,
        loaded: true,
        userEdited: true,
        disabled: false,
        baseKit: BASE_KIT,
        onSaved: () => {},
        onRegisterFlush: useBuildSaveFlushRegistry(),
      }),
    }),
    { wrapper: BuildEditors },
  );
  const request = screen.getByRole("textbox", { name: "Special request" });
  fireEvent.change(request, { target: { value: "Ship with spare nozzles" } });
  fireEvent.blur(request);
  act(() => page.result.current.manifest.saveUserEdit({ extras: ["skirts"] }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Special request refused"));
  await waitFor(() => expect(page.result.current.manifest.status).toBe("error"));
  return page;
}

describe("failed Save intent", () => {
  it("flush_does_not_resend_failed_intent", async () => {
    const page = await renderBuildWithFailedSaves();
    const refusedRequest = saves.updateProfile.mock.calls[0]?.[0];
    const refusedKit = saves.savePlanKitManifest.mock.calls[0]?.[1];

    // Navigation flushes leave the retained intent alone and keep the Build open.
    await expect(page.result.current.flushAll()).rejects.toThrow();
    await expect(page.result.current.flushAll()).rejects.toThrow();

    expect(saves.updateProfile.mock.calls).toEqual([[refusedRequest]]);
    expect(saves.savePlanKitManifest.mock.calls).toEqual([[BUILD_ID, refusedKit]]);
    expect(screen.getByRole("alert").textContent).toContain("Special request refused");
    expect(page.result.current.manifest.status).toBe("error");
  });

  it("explicit_retry_flushes_retained_request", async () => {
    const page = await renderBuildWithFailedSaves();
    const refusedRequest = saves.updateProfile.mock.calls[0]?.[0];
    const refusedKit = saves.savePlanKitManifest.mock.calls[0]?.[1];
    await expect(page.result.current.flushAll()).rejects.toThrow();
    saves.updateProfile.mockResolvedValueOnce(undefined);
    saves.savePlanKitManifest.mockResolvedValueOnce(kit(["skirts"]));

    await act(() => page.result.current.retryAll());

    expect(refusedRequest).toEqual({ id: BUILD_ID, special_request: "Ship with spare nozzles" });
    expect(saves.updateProfile.mock.calls).toEqual([[refusedRequest], [refusedRequest]]);
    expect(saves.savePlanKitManifest).toHaveBeenCalledTimes(2);
    expect(saves.savePlanKitManifest.mock.calls[1]?.[1]).toBe(refusedKit);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(page.result.current.manifest.status).toBe("saved");
    // Once the retry lands there is nothing left to send.
    await act(() => page.result.current.flushAll());
    expect(saves.updateProfile).toHaveBeenCalledTimes(2);
    expect(saves.savePlanKitManifest).toHaveBeenCalledTimes(2);
  });
});
