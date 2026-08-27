/**
 * Worklist order for one Build.
 *
 * The order is a local operator preference, not Plan state: it is how someone
 * chose to walk their bins today. It survives navigation, drops parts the
 * Accepted Plan no longer requires, and keeps bag or sort bars in place.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getProgressRowsForPlan,
  loadPersistedCheckoffUi,
  savePersistedCheckoffUi,
  withProgressRowsForPlan,
  type PersistedProgressRow,
} from "./persistedCheckoffUi";
import {
  defaultBagBarLabel,
  newBagBarId,
  reconcileProgressRows,
  type ProgressRowRef,
} from "./progressListOrder";

export type CheckoffWorklistOrder = {
  /** Full reconciled order for the Build: every known part, plus bag bars. */
  rows: ProgressRowRef[];
  setRows: (rows: ProgressRowRef[]) => void;
  addBagBar: () => void;
  renameBagBar: (bagId: string, label: string) => void;
  removeBagBar: (bagId: string) => void;
};

function initialRowsByPlan(): Record<string, PersistedProgressRow[]> {
  const stored = loadPersistedCheckoffUi();
  const initial: Record<string, PersistedProgressRow[]> = {
    ...stored.progressRowsByPlanId,
  };
  for (const key of [
    ...Object.keys(stored.partOrderByPlanId),
    ...Object.keys(stored.bagBarsByPlanId),
  ]) {
    if (!initial[key]?.length) {
      initial[key] = getProgressRowsForPlan(stored, Number(key));
    }
  }
  return initial;
}

export function useCheckoffWorklistOrder(input: {
  planId: number | null;
  partIds: number[];
}): CheckoffWorklistOrder {
  const { planId, partIds } = input;
  const [rowsByPlanId, setRowsByPlanId] =
    useState<Record<string, PersistedProgressRow[]>>(initialRowsByPlan);

  useEffect(() => {
    let next = loadPersistedCheckoffUi();
    for (const [planKey, rows] of Object.entries(rowsByPlanId)) {
      const id = Number(planKey);
      if (!Number.isFinite(id)) continue;
      next = withProgressRowsForPlan(next, id, rows);
    }
    savePersistedCheckoffUi(next);
  }, [rowsByPlanId]);

  const rows = useMemo(() => {
    const preferred: ProgressRowRef[] =
      planId == null ? [] : (rowsByPlanId[String(planId)] ?? []);
    const bags = preferred
      .filter((row): row is Extract<ProgressRowRef, { kind: "bag" }> => row.kind === "bag")
      .map((row) => ({ id: row.id, label: row.label }));
    return reconcileProgressRows(preferred, partIds, bags);
  }, [partIds, planId, rowsByPlanId]);

  const setRows = useCallback(
    (next: ProgressRowRef[]) => {
      if (planId == null) return;
      setRowsByPlanId((prev) => ({ ...prev, [String(planId)]: next }));
    },
    [planId],
  );

  const addBagBar = useCallback(() => {
    const bagCount = rows.filter((row) => row.kind === "bag").length;
    setRows([...rows, { kind: "bag", id: newBagBarId(), label: defaultBagBarLabel(bagCount) }]);
  }, [rows, setRows]);

  const renameBagBar = useCallback(
    (bagId: string, label: string) => {
      setRows(
        rows.map((row) => (row.kind === "bag" && row.id === bagId ? { ...row, label } : row)),
      );
    },
    [rows, setRows],
  );

  const removeBagBar = useCallback(
    (bagId: string) => {
      setRows(rows.filter((row) => !(row.kind === "bag" && row.id === bagId)));
    },
    [rows, setRows],
  );

  return { rows, setRows, addBagBar, renameBagBar, removeBagBar };
}
