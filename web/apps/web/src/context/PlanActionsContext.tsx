import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type ReactNode,
} from "react";

type PlanIdHandler = (planId?: number) => void;
type PlanActionHandler<Args extends unknown[]> = (...args: Args) => void;
type PlanActionRegistration<Args extends unknown[]> = {
  handler: PlanActionHandler<Args>;
};
type RegisterPlanAction<Args extends unknown[]> = (
  handler: PlanActionHandler<Args>,
) => () => void;

type PlanActionsContextValue = {
  openCreatePlan: () => void;
  openRenamePlan: PlanIdHandler;
  openDuplicatePlan: PlanIdHandler;
  openDeletePlan: PlanIdHandler;
  openArchivePlan: PlanIdHandler;
  registerOpenCreate: RegisterPlanAction<[]>;
  registerOpenRename: RegisterPlanAction<[planId?: number]>;
  registerOpenDuplicate: RegisterPlanAction<[planId?: number]>;
  registerOpenDelete: RegisterPlanAction<[planId?: number]>;
  registerOpenArchive: RegisterPlanAction<[planId?: number]>;
};

const PlanActionsContext = createContext<PlanActionsContextValue | null>(null);

function usePlanActionRegistry<Args extends unknown[]>() {
  const registrationsRef = useRef<PlanActionRegistration<Args>[]>([]);

  const register = useCallback<RegisterPlanAction<Args>>((handler) => {
    const registration = { handler };
    registrationsRef.current.push(registration);
    return () => {
      registrationsRef.current = registrationsRef.current.filter(
        (candidate) => candidate !== registration,
      );
    };
  }, []);

  const open = useCallback((...args: Args) => {
    const registrations = registrationsRef.current;
    registrations[registrations.length - 1]?.handler(...args);
  }, []);

  return [open, register] as const;
}

function usePlanIdActionRegistry() {
  const [openRegisteredAction, register] =
    usePlanActionRegistry<[planId?: number]>();
  const open = useCallback<PlanIdHandler>((planId) => {
    openRegisteredAction(typeof planId === "number" ? planId : undefined);
  }, [openRegisteredAction]);

  return [open, register] as const;
}

export function PlanActionsProvider({ children }: { children: ReactNode }) {
  const [openCreatePlan, registerOpenCreate] = usePlanActionRegistry<[]>();
  const [openRenamePlan, registerOpenRename] = usePlanIdActionRegistry();
  const [openDuplicatePlan, registerOpenDuplicate] = usePlanIdActionRegistry();
  const [openDeletePlan, registerOpenDelete] = usePlanIdActionRegistry();
  const [openArchivePlan, registerOpenArchive] = usePlanIdActionRegistry();

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
