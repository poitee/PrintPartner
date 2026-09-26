import { useEffect, useRef } from "react";
import { useBlocker } from "react-router-dom";
import { toast } from "sonner";
import { useFlushBuildPageSaves } from "../hooks/useFlushBuildPageSaves";
import { isPlanPath, isSourcesPath } from "../lib/routes";

export default function BuildSaveNavigationGuard() {
  const flushSaves = useFlushBuildPageSaves();
  const handlingRef = useRef(false);
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) => {
      if (!isSourcesPath(currentLocation.pathname) && !isPlanPath(currentLocation.pathname)) {
        return false;
      }
      if (currentLocation.pathname !== nextLocation.pathname) return true;
      const currentProfile = new URLSearchParams(currentLocation.search).get("profile");
      const nextProfile = new URLSearchParams(nextLocation.search).get("profile");
      return currentProfile !== nextProfile;
    },
  );

  useEffect(() => {
    if (blocker.state !== "blocked" || handlingRef.current) return;
    handlingRef.current = true;
    void flushSaves()
      .then(() => blocker.proceed())
      .catch(() => {
        blocker.reset();
        toast.error("Save failed. Retry before leaving Sources or Plan.");
      })
      .finally(() => {
        handlingRef.current = false;
      });
  }, [blocker, flushSaves]);

  return null;
}
