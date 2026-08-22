import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type ReactNode,
} from "react";

type PlanIdHandler = (planId?: number) => void;

type PlanActionsContextValue = {
  openCreatePlan: () => void;
  openRenamePlan: PlanIdHandler;
  openDuplicatePlan: PlanIdHandler;
  openDeletePlan: PlanIdHandler;
  openArchivePlan: PlanIdHandler;
  registerOpenCreate: (fn: (() => void) | null) => void;
  registerOpenRename: (fn: PlanIdHandler | null) => void;
  registerOpenDuplicate: (fn: PlanIdHandler | null) => void;
  registerOpenDelete: (fn: PlanIdHandler | null) => void;
  registerOpenArchive: (fn: PlanIdHandler | null) => void;
};

const PlanActionsContext = createContext<PlanActionsContextValue | null>(null);

export function PlanActionsProvider({ children }: { children: ReactNode }) {
  const openCreateRef = useRef<(() => void) | null>(null);
  const openRenameRef = useRef<PlanIdHandler | null>(null);
  const openDuplicateRef = useRef<PlanIdHandler | null>(null);
  const openDeleteRef = useRef<PlanIdHandler | null>(null);
  const openArchiveRef = useRef<PlanIdHandler | null>(null);

  const registerOpenCreate = useCallback((fn: (() => void) | null) => {
    openCreateRef.current = fn;
  }, []);

  const registerOpenRename = useCallback((fn: PlanIdHandler | null) => {
    openRenameRef.current = fn;
  }, []);

  const registerOpenDuplicate = useCallback((fn: PlanIdHandler | null) => {
    openDuplicateRef.current = fn;
  }, []);

  const registerOpenDelete = useCallback((fn: PlanIdHandler | null) => {
    openDeleteRef.current = fn;
  }, []);

  const registerOpenArchive = useCallback((fn: PlanIdHandler | null) => {
    openArchiveRef.current = fn;
  }, []);

  const openCreatePlan = useCallback(() => {
    openCreateRef.current?.();
  }, []);

  const openRenamePlan = useCallback((planId?: number) => {
    openRenameRef.current?.(typeof planId === "number" ? planId : undefined);
  }, []);

  const openDuplicatePlan = useCallback((planId?: number) => {
    openDuplicateRef.current?.(typeof planId === "number" ? planId : undefined);
  }, []);

  const openDeletePlan = useCallback((planId?: number) => {
    openDeleteRef.current?.(typeof planId === "number" ? planId : undefined);
  }, []);

  const openArchivePlan = useCallback((planId?: number) => {
    openArchiveRef.current?.(typeof planId === "number" ? planId : undefined);
  }, []);

  const value = useMemo(
    () => ({
      openCreatePlan,
      openRenamePlan,
      openDuplicatePlan,
      openDeletePlan,
      openArchivePlan,
      registerOpenCreate,
      registerOpenRename,
      registerOpenDuplicate,
      registerOpenDelete,
      registerOpenArchive,
    }),
    [
      openCreatePlan,
      openRenamePlan,
      openDuplicatePlan,
      openDeletePlan,
      openArchivePlan,
      registerOpenCreate,
      registerOpenRename,
      registerOpenDuplicate,
      registerOpenDelete,
      registerOpenArchive,
    ],
  );

  return (
    <PlanActionsContext.Provider value={value}>
      {children}
    </PlanActionsContext.Provider>
  );
}

export function usePlanActions() {
  const ctx = useContext(PlanActionsContext);
  if (!ctx) {
    throw new Error("usePlanActions must be used within PlanActionsProvider");
  }
  return ctx;
}
