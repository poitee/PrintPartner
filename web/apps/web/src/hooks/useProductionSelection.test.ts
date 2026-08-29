// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { createElement, type PropsWithChildren } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  parseRequiredUnitTokenContract,
  type ProductionSetup,
  type RequiredUnitToken,
} from "@print-partner/contracts";
import type { ProductionSelectableUnit } from "../lib/productionSelection";
import { useProductionSelection } from "./useProductionSelection";

const setupState = vi.hoisted(() => ({
  data: undefined as ProductionSetup | undefined,
}));

vi.mock("../queries/productionSetup", () => ({
  useProductionSetup: (_profileId: number | null, enabled: boolean) => ({
    data: enabled ? setupState.data : undefined,
    save: vi.fn().mockResolvedValue(undefined),
    isPending: false,
    saving: false,
    error: null,
    saveError: null,
  }),
}));

const first = parseRequiredUnitTokenContract(`ppu_${"a".repeat(32)}`);
const second = parseRequiredUnitTokenContract(`ppu_${"b".repeat(32)}`);
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function wrapper({ children }: PropsWithChildren) {
  return createElement(QueryClientProvider, { client: queryClient }, children);
}

function unit(token: RequiredUnitToken, completed = false): ProductionSelectableUnit {
  return {
    token,
    object_name: `part__${token}`,
    filename: "part.stl",
    relative_path: "XY/part.stl",
    source_directory: "XY",
    source_layer: "Hardware",
    role: "primary",
    filament_color_id: null,
    completed,
  };
}

describe("useProductionSelection", () => {
  beforeEach(() => {
    setupState.data = undefined;
  });

  it("preserves manual selection across workspace-only refetches", () => {
    const { result, rerender } = renderHook(
      ({ units }) => useProductionSelection(units, null, 7, false),
      { initialProps: { units: [unit(first), unit(second)] }, wrapper },
    );
    act(() => result.current.setSelection(new Set([second])));

    rerender({ units: [unit(first), unit(second)] });

    expect([...result.current.selection]).toEqual([second]);
  });

  it("preserves manual selection when Plate edits reorder the same Required units", () => {
    const { result, rerender } = renderHook(
      ({ units }) => useProductionSelection(units, null, 7, false),
      { initialProps: { units: [unit(first), unit(second)] }, wrapper },
    );
    act(() => result.current.setSelection(new Set([second])));

    rerender({ units: [unit(second), unit(first)] });

    expect([...result.current.selection]).toEqual([second]);
  });

  it("resets when the Required-unit identity changes", () => {
    const { result, rerender } = renderHook(
      ({ units }) => useProductionSelection(units, "missing", 7, false),
      { initialProps: { units: [unit(first), unit(second, true)] }, wrapper },
    );
    expect([...result.current.selection]).toEqual([first]);

    rerender({ units: [unit(second)] });

    expect([...result.current.selection]).toEqual([second]);
  });

  it("resets when the Build changes with the same Required units", () => {
    const { result, rerender } = renderHook(
      ({ profileId }) => useProductionSelection([unit(first), unit(second)], null, profileId, false),
      { initialProps: { profileId: 7 }, wrapper },
    );
    act(() => result.current.setSelection(new Set([second])));

    rerender({ profileId: 8 });

    expect([...result.current.selection]).toEqual([first, second]);
  });

  it("keeps a custom selection when persisted setup only changes updated_at", () => {
    const units = [unit(first), unit(second, true)];
    setupState.data = {
      format: "production-setup-v1",
      profile_id: 7,
      preferred_slicer_instance_id: null,
      selection: { mode: "all_incomplete" },
      printer_assignments: [],
      route: null,
      rules: [],
      updated_at: "2026-08-29T00:00:00.000Z",
    };
    const { result, rerender } = renderHook(
      () => useProductionSelection(units, "missing", 7, true),
      { wrapper },
    );
    expect([...result.current.selection]).toEqual([first]);

    act(() => result.current.setSelection(new Set([second])));
    setupState.data = {
      ...setupState.data,
      selection: { mode: "custom", selected_unit_tokens: [second] },
      updated_at: "2026-08-29T00:00:01.000Z",
    };
    rerender();

    expect([...result.current.selection]).toEqual([second]);
  });
});
