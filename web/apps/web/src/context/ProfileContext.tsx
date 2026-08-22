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
import type { ProfileSummary } from "../api/engine";
import { useEngineHealth } from "../hooks/useEngineHealth";
import { reconcileSelectedProfileId } from "../hooks/profileSelection";
import { queryKeys } from "../queries/keys";
import { useProfilesQuery } from "../queries/profiles";

const STORAGE_KEY = "pp-selected-profile-id";

type SetSelectedProfileOptions = {
  /** When true, selection came from `?profile=` — do not mark URL sync as pending. */
  fromUrl?: boolean;
};

type ProfileContextValue = {
  profiles: ProfileSummary[];
  selectedProfileId: number | null;
  setSelectedProfileId: (id: number | null, options?: SetSelectedProfileOptions) => void;
  /** Local selection not yet reflected in `?profile=` — used by URL sync. */
  pendingSelectionId: number | null;
  clearPendingSelection: (matchedUrlId?: number | null) => void;
  reloadProfiles: () => Promise<void>;
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
  const { health } = useEngineHealth();
  const qc = useQueryClient();
  const {
    data: profiles = [],
    isLoading,
    isSuccess,
    error: queryError,
    refetch,
  } = useProfilesQuery(Boolean(health?.ok));

  const [selectedProfileId, setSelectedProfileIdState] = useState<number | null>(readStoredId);
  const [pendingSelectionId, setPendingSelectionId] = useState<number | null>(null);
  const previousProfileIdsRef = useRef<number[]>([]);

  const setSelectedProfileId = useCallback(
    (id: number | null, options?: SetSelectedProfileOptions) => {
      if (options?.fromUrl) setPendingSelectionId(null);
      else setPendingSelectionId(id);
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

    const next = reconcileSelectedProfileId(nextIds, selectedProfileId, previousIds);
    if (next !== undefined) {
      setSelectedProfileId(next);
    }
  }, [isSuccess, profiles, selectedProfileId, setSelectedProfileId]);

  const reloadProfiles = useCallback(async () => {
    if (!health?.ok) return;
    await qc.invalidateQueries({ queryKey: queryKeys.profiles });
    await refetch();
  }, [health?.ok, qc, refetch]);

  const value = useMemo(
    (): ProfileContextValue => ({
      profiles,
      selectedProfileId,
      setSelectedProfileId,
      pendingSelectionId,
      clearPendingSelection,
      reloadProfiles,
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
