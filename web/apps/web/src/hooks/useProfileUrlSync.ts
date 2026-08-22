import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { useProfileSelection } from "../context/ProfileContext";
import { shouldBlockUrlProfileSync } from "./profileSelection";
import {
  parseProfileParam,
  profileIdFromUrl,
  searchParamsWithProfile,
} from "./profileUrlSync";

/** Bidirectional sync between selected plan and ?profile= URL param. */
export function useProfileUrlSync() {
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    profiles,
    selectedProfileId,
    setSelectedProfileId,
    pendingSelectionId,
    clearPendingSelection,
  } = useProfileSelection();

  // Latest params, read inside the state -> URL effect without making it a dep
  // (which would fight the URL -> state sync).
  const searchParamsRef = useRef(searchParams);
  searchParamsRef.current = searchParams;

  const selectedRef = useRef(selectedProfileId);
  selectedRef.current = selectedProfileId;

  const pendingRef = useRef(pendingSelectionId);
  pendingRef.current = pendingSelectionId;

  // URL -> state when the query or plan list changes (not when selection changes).
  useEffect(() => {
    const urlId = parseProfileParam(searchParams.get("profile"));
    if (
      shouldBlockUrlProfileSync(urlId, pendingRef.current, selectedRef.current)
    ) {
      return;
    }
    if (urlId != null && urlId === pendingRef.current) {
      clearPendingSelection(urlId);
    }
    const nextId = profileIdFromUrl(
      urlId,
      profiles.map((p) => p.id),
      selectedRef.current,
    );
    if (nextId != null) {
      setSelectedProfileId(nextId, { fromUrl: true });
    }
    // selectedProfileId intentionally omitted — including it fights state -> URL sync.
  }, [searchParams, profiles, setSelectedProfileId, clearPendingSelection]);

  // State -> URL. Only navigate when the param actually changes; calling
  // setSearchParams on a no-op still replaces history and drops location.state
  // (e.g. the kit-import payload passed to the Build page).
  useEffect(() => {
    const next = searchParamsWithProfile(searchParamsRef.current, selectedProfileId);
    if (next) {
      setSearchParams(next, { replace: true });
    }
    if (
      selectedProfileId != null &&
      searchParamsRef.current.get("profile") === String(selectedProfileId)
    ) {
      clearPendingSelection(selectedProfileId);
    }
  }, [selectedProfileId, setSearchParams, clearPendingSelection]);
}
