// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  parseRequiredUnitTokenContract,
  type RequiredUnitToken,
} from "@print-partner/contracts";
import type { ProductionSelectableUnit } from "../lib/productionSelection";
import { useProductionSelection } from "./useProductionSelection";

const first = parseRequiredUnitTokenContract(`ppu_${"a".repeat(32)}`);
const second = parseRequiredUnitTokenContract(`ppu_${"b".repeat(32)}`);

function unit(token: RequiredUnitToken, completed = false): ProductionSelectableUnit {
  return {
    token,
    object_name: `part__${token}`,
    filename: "part.stl",
    source_layer: "Hardware",
    role: "primary",
    filament_color_id: null,
    completed,
  };
}

describe("useProductionSelection", () => {
  it("preserves manual selection across workspace-only refetches", () => {
    const { result, rerender } = renderHook(
      ({ units }) => useProductionSelection(units, null, 7),
      { initialProps: { units: [unit(first), unit(second)] } },
    );
    act(() => result.current.setSelection(new Set([second])));

    rerender({ units: [unit(first), unit(second)] });

    expect([...result.current.selection]).toEqual([second]);
  });

  it("preserves manual selection when Plate edits reorder the same Required units", () => {
    const { result, rerender } = renderHook(
      ({ units }) => useProductionSelection(units, null, 7),
      { initialProps: { units: [unit(first), unit(second)] } },
    );
    act(() => result.current.setSelection(new Set([second])));

    rerender({ units: [unit(second), unit(first)] });

    expect([...result.current.selection]).toEqual([second]);
  });

  it("resets when the Required-unit identity changes", () => {
    const { result, rerender } = renderHook(
      ({ units }) => useProductionSelection(units, "missing", 7),
      { initialProps: { units: [unit(first), unit(second, true)] } },
    );
    expect([...result.current.selection]).toEqual([first]);

    rerender({ units: [unit(second)] });

    expect([...result.current.selection]).toEqual([second]);
  });

  it("resets when the Build changes with the same Required units", () => {
    const { result, rerender } = renderHook(
      ({ profileId }) => useProductionSelection([unit(first), unit(second)], null, profileId),
      { initialProps: { profileId: 7 } },
    );
    act(() => result.current.setSelection(new Set([second])));

    rerender({ profileId: 8 });

    expect([...result.current.selection]).toEqual([first, second]);
  });
});
