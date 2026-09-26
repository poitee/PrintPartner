import { useEffect, useRef } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { useProfileSelection } from "../context/ProfileContext";
import {
  parseProfileParam,
  searchParamsWithProfile,
  shouldSyncProfileToPath,
} from "./profileUrlSync";

/** Publish local Build selections without overwriting an unresolved URL selection. */
export function useProfileUrlSync() {
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const {
    profiles,
    selectedProfileId,
    pendingSelectionId,
    clearPendingSelection,
    profilesLoaded,
  } = useProfileSelection();

  // Latest params, read inside the state -> URL effect without making it a dep
  // (which would fight the URL -> state sync).
  const searchParamsRef = useRef(searchParams);
  searchParamsRef.current = searchParams;
  const publishedPendingIdRef = useRef<number | null>(null);

  // ProfileProvider owns URL -> state so initial hydration and profile-list
  // reconciliation are one transition. This effect only publishes local choices.
  useEffect(() => {
    if (!shouldSyncProfileToPath(location.pathname)) return;
    const currentParams = searchParamsRef.current;
    const urlId = parseProfileParam(currentParams.get("profile"));
    if (pendingSelectionId == null) publishedPendingIdRef.current = null;
    else if (urlId === pendingSelectionId) publishedPendingIdRef.current = pendingSelectionId;
    if (
      pendingSelectionId != null &&
      publishedPendingIdRef.current === pendingSelectionId &&
      urlId != null &&
      urlId !== pendingSelectionId &&
      profiles.some((profile) => profile.id === urlId)
    ) return;
    const importedId = (location.state as { kitImport?: { profile_id?: number } } | null)?.kitImport?.profile_id;
    if (importedId === urlId && selectedProfileId !== importedId) return;
    const urlSelectsKnownProfile =
      urlId != null &&
      (!profilesLoaded || profiles.some((profile) => profile.id === urlId));
    if (
      pendingSelectionId == null &&
      urlSelectsKnownProfile &&
      urlId !== selectedProfileId
    ) {
      return;
    }
    const next = searchParamsWithProfile(currentParams, selectedProfileId);
    if (next) {
      setSearchParams(next, { replace: true });
    }
    if (
      selectedProfileId != null &&
      searchParamsRef.current.get("profile") === String(selectedProfileId) &&
      profiles.some((profile) => profile.id === selectedProfileId)
    ) {
      clearPendingSelection(selectedProfileId);
    }
  }, [
    location.pathname,
    location.state,
    selectedProfileId,
    pendingSelectionId,
    profilesLoaded,
    profiles,
    setSearchParams,
    clearPendingSelection,
  ]);
}
