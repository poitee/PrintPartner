import { useEffect, useRef } from "react";
import { useBlocker, useLocation } from "react-router-dom";
import { toast } from "sonner";
import { confirmDiscardSourceChanges, useLibraryDraft } from "../context/LibraryDraftContext";
import { useFlushBuildPageSaves } from "../hooks/useFlushBuildPageSaves";
import { isLibraryPath, isPlanPath, isSourcesPath } from "../lib/routes";

export default function BuildSaveNavigationGuard() {
  const flushSaves = useFlushBuildPageSaves();
  const { hasDirtyDraft } = useLibraryDraft();
  const location = useLocation();
  const handlingRef = useRef(false);
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) => {
      if (isLibraryPath(currentLocation.pathname)) {
        if (!hasDirtyDraft()) return false;
        if (currentLocation.pathname !== nextLocation.pathname) return true;
        const currentSource = new URLSearchParams(currentLocation.search).get("source");
        const nextSource = new URLSearchParams(nextLocation.search).get("source");
        return currentSource !== nextSource;
      }
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
    if (isLibraryPath(location.pathname) && hasDirtyDraft()) {
      if (confirmDiscardSourceChanges()) blocker.proceed();
      else blocker.reset();
      handlingRef.current = false;
      return;
    }
    void flushSaves()
      .then(() => blocker.proceed())
      .catch(() => {
        blocker.reset();
        toast.error("Save failed. Retry before leaving Sources or Plan.");
      })
      .finally(() => {
        handlingRef.current = false;
      });
  }, [blocker, flushSaves, hasDirtyDraft, location.pathname]);

  return null;
}
