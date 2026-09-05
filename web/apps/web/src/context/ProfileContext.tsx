import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ProfileSummary } from "@print-partner/contracts";
import { useSearchParams } from "react-router-dom";
import { useEngineHealth } from "../hooks/useEngineHealth";
import { reconcileSelectedProfileId } from "../hooks/profileSelection";
import { parseProfileParam } from "../hooks/profileUrlSync";
import { queryKeys } from "../queries/keys";
import { useProfilesQuery } from "../queries/profiles";
import { useAuth } from "./AuthContext";

const STORAGE_KEY = "pp-selected-profile-id";

type ProfileContextValue = {
  profiles: ProfileSummary[];
  selectedProfileId: number | null;
  setSelectedProfileId: (id: number | null) => void;
  /** Local selection not yet reflected in `?profile=`. */
  pendingSelectionId: number | null;
  clearPendingSelection: (matchedUrlId?: number | null) => void;
  reloadProfiles: () => Promise<void>;
  profilesLoaded: boolean;
  loading: boolean;
  error: string | null;
};

const ProfileContext = createContext<ProfileContextValue | null>(null);

function readStoredId(): number | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function ProfileProvider({ children }: { children: ReactNode }) {
  const { user, multiUser, loading: authLoading } = useAuth();
  const { health } = useEngineHealth();
  const canLoadProfiles =
    !authLoading && Boolean(health?.ok) && (!multiUser || user !== null);
  const qc = useQueryClient();
  const [searchParams] = useSearchParams();
  const {
    data: profiles = [],
    isLoading,
    isSuccess,
    error: queryError,
    refetch,
  } = useProfilesQuery(canLoadProfiles);

  const [selectedProfileId, setSelectedProfileIdState] = useState<number | null>(readStoredId);
  const [pendingSelectionId, setPendingSelectionId] = useState<number | null>(null);
  const previousProfileIdsRef = useRef<number[]>([]);
  const urlProfileId = parseProfileParam(searchParams.get("profile"));

  const commitSelectedProfileId = useCallback(
    (id: number | null, pending: boolean) => {
      setPendingSelectionId(pending ? id : null);
      setSelectedProfileIdState(id);
      try {
        if (id == null) sessionStorage.removeItem(STORAGE_KEY);
        else sessionStorage.setItem(STORAGE_KEY, String(id));
      } catch {
        /* ignore */
      }
    },
    [],
  );
  const setSelectedProfileId = useCallback(
    (id: number | null) => commitSelectedProfileId(id, true),
    [commitSelectedProfileId],
  );

  const clearPendingSelection = useCallback((matchedUrlId?: number | null) => {
    setPendingSelectionId((pending) => {
      if (pending == null) return null;
      if (matchedUrlId !== undefined && matchedUrlId !== pending) return pending;
      return null;
    });
  }, []);

  useEffect(() => {
    if (!isSuccess) return;

    const previousIds = previousProfileIdsRef.current;
    const nextIds = profiles.map((p) => p.id);
    previousProfileIdsRef.current = nextIds;

    const next = reconcileSelectedProfileId(
      nextIds,
      selectedProfileId,
      previousIds,
      urlProfileId,
      pendingSelectionId,
    );
    if (next !== undefined) {
      commitSelectedProfileId(next, false);
    }
  }, [
    isSuccess,
    profiles,
    selectedProfileId,
    urlProfileId,
    pendingSelectionId,
    commitSelectedProfileId,
  ]);

  const reloadProfiles = useCallback(async () => {
    if (!canLoadProfiles) return;
    await qc.invalidateQueries({ queryKey: queryKeys.profiles });
    await refetch();
  }, [canLoadProfiles, qc, refetch]);

  const value = useMemo(
    (): ProfileContextValue => ({
      profiles,
      selectedProfileId,
      setSelectedProfileId,
      pendingSelectionId,
      clearPendingSelection,
      reloadProfiles,
      profilesLoaded: isSuccess,
      loading: isLoading,
      error:
        queryError instanceof Error
          ? queryError.message
          : queryError
            ? String(queryError)
            : null,
    }),
    [
      profiles,
      selectedProfileId,
      setSelectedProfileId,
      pendingSelectionId,
      clearPendingSelection,
      reloadProfiles,
      isSuccess,
      isLoading,
      queryError,
    ],
  );

  return (
    <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>
  );
}

export function useProfileSelection() {
  const ctx = useContext(ProfileContext);
  if (!ctx) {
    throw new Error("useProfileSelection must be used within ProfileProvider");
  }
  return ctx;
}
