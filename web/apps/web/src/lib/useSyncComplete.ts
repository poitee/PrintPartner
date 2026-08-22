/**
 * useSyncComplete — fires a callback whenever the service worker flushes
 * its offline checkoff queue and returns online.
 *
 * Usage in a query component:
 *   useSyncComplete(() => queryClient.invalidateQueries({ queryKey: ["parts"] }));
 */
import { useEffect } from "react";

export function useSyncComplete(callback: () => void) {
  useEffect(() => {
    const handler = () => callback();
    window.addEventListener("pp:sync-complete", handler);
    return () => window.removeEventListener("pp:sync-complete", handler);
  }, [callback]);
}
