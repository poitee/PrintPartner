import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import type { RequiredUnitToken } from "@print-partner/contracts";
import {
  initialProductionSelection,
  type ProductionSelectableUnit,
} from "../lib/productionSelection";
import { useProductionSetup } from "../queries/productionSetup";

export function useProductionSelection(
  units: readonly ProductionSelectableUnit[],
  select: string | null,
  profileId: number | null,
  persist = true,
) {
  const setup = useProductionSetup(profileId, persist);
  const identity = `${profileId ?? ""}:${select ?? ""}:${setup.data ? "ready" : "loading"}:${units.map((unit) => unit.token).sort().join(",")}`;
  const previousIdentity = useRef(identity);
  const [selection, setSelection] = useState<ReadonlySet<RequiredUnitToken>>(() =>
    initialProductionSelection(units, select),
  );

  useEffect(() => {
    if (previousIdentity.current === identity) return;
    previousIdentity.current = identity;
    if (select) {
      setSelection(initialProductionSelection(units, select));
      return;
    }
    if (setup.data?.selection.mode === "custom") {
      const available = new Set(units.map((unit) => unit.token));
      setSelection(new Set(setup.data.selection.selected_unit_tokens.filter((token) =>
        available.has(token as RequiredUnitToken)
      ) as RequiredUnitToken[]));
      return;
    }
    if (setup.data?.selection.mode === "all_incomplete") {
      setSelection(new Set(units.filter((unit) => !unit.completed).map((unit) => unit.token)));
      return;
    }
    setSelection(initialProductionSelection(units, select));
  }, [identity, select, setup.data, units]);

  const setPersistedSelection = useCallback((action: SetStateAction<ReadonlySet<RequiredUnitToken>>) => {
    setSelection((current) => {
      const next = typeof action === "function" ? action(current) : action;
      if (persist && profileId != null) {
        void setup.save({
          kind: "set_selection",
          selection: { mode: "custom", selected_unit_tokens: [...next] },
        }).catch(() => undefined);
      }
      return next;
    });
  }, [persist, profileId, setup]);

  return {
    selection,
    setSelection: setPersistedSelection,
    setup: setup.data,
    setupLoading: setup.isPending,
    setupSaving: setup.saving,
    setupError: setup.error ?? setup.saveError,
  };
}
