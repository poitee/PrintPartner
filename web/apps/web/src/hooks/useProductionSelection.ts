import { useEffect, useRef, useState } from "react";
import type { RequiredUnitToken } from "@print-partner/contracts";
import {
  initialProductionSelection,
  type ProductionSelectableUnit,
} from "../lib/productionSelection";

export function useProductionSelection(
  units: readonly ProductionSelectableUnit[],
  select: string | null,
  profileId: number | null,
) {
  const identity = `${profileId ?? ""}:${select ?? ""}:${units.map((unit) => unit.token).sort().join(",")}`;
  const previousIdentity = useRef(identity);
  const [selection, setSelection] = useState<ReadonlySet<RequiredUnitToken>>(() =>
    initialProductionSelection(units, select),
  );

  useEffect(() => {
    if (previousIdentity.current === identity) return;
    previousIdentity.current = identity;
    setSelection(initialProductionSelection(units, select));
  }, [identity, select, units]);

  return { selection, setSelection };
}
