import { useCallback, useEffect, useRef, useState } from "react";
import { fetchAppUpdateCheck, type AppUpdateCheckResponse } from "../api/engine";

const DEBOUNCE_MS = 1500;

export function useAppUpdateCheck(engineReady: boolean) {
  const [updateCheck, setUpdateCheck] = useState<AppUpdateCheckResponse | null>(null);
  const fetchedRef = useRef(false);

  const refresh = useCallback(async (force = false) => {
    if (!engineReady) return;
    try {
      const result = await fetchAppUpdateCheck(force);
      setUpdateCheck(result);
    } catch {
      setUpdateCheck(null);
    }
  }, [engineReady]);

  useEffect(() => {
    if (!engineReady || fetchedRef.current) return;
    const timer = window.setTimeout(() => {
      fetchedRef.current = true;
      void refresh();
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [engineReady, refresh]);

  return { updateCheck, refresh };
}
