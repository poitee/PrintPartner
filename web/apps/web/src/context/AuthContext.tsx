import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  fetchAuthMe,
  fetchHealth,
  loginWithEmail,
  logout as apiLogout,
  registerWithEmail,
  setEngineUnauthorizedHandler,
  type AuthUser,
} from "../api/engine";

type AuthContextValue = {
  user: AuthUser | null;
  multiUser: boolean;
  authRequired: boolean;
  registrationOpen: boolean;
  loading: boolean;
  loginEmail: (email: string, password: string) => Promise<void>;
  registerEmail: (email: string, password: string, displayName: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [multiUser, setMultiUser] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  const replaceUser = useCallback((nextUser: AuthUser | null) => {
    queryClient.clear();
    setUser(nextUser);
  }, [queryClient]);

  const refresh = useCallback(async () => {
    try {
      const health = await fetchHealth();
      setMultiUser(Boolean(health.multi_user));
      const requiresAuthentication = Boolean(
        health.authentication_required ?? health.multi_user,
      );
      setAuthRequired(requiresAuthentication);
      setRegistrationOpen(Boolean(health.registration_open ?? health.multi_user));
      if (!requiresAuthentication) {
        replaceUser(null);
        return;
      }
      if (health.authenticated === false) {
        replaceUser(null);
        return;
      }
      const me = await fetchAuthMe();
      replaceUser(me.user);
    } catch {
      replaceUser(null);
    }
  }, [replaceUser]);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      await refresh();
      setLoading(false);
    })();
  }, [refresh]);

  useEffect(() => {
    setEngineUnauthorizedHandler(() => {
      if (authRequired) replaceUser(null);
    });
    return () => setEngineUnauthorizedHandler(null);
  }, [authRequired, replaceUser]);

  const loginEmail = useCallback(async (email: string, password: string) => {
    const res = await loginWithEmail(email, password);
    replaceUser(res.user);
  }, [replaceUser]);

  const registerEmail = useCallback(
    async (email: string, password: string, displayName: string) => {
      const res = await registerWithEmail(email, password, displayName);
      replaceUser(res.user);
      setRegistrationOpen(false);
    },
    [replaceUser],
  );

  const logout = useCallback(async () => {
    await apiLogout();
    replaceUser(null);
    await refresh();
  }, [refresh, replaceUser]);

  const value = useMemo(
    () => ({
      user,
      multiUser,
      authRequired,
      registrationOpen,
      loading,
      loginEmail,
      registerEmail,
      logout,
      refresh,
    }),
    [user, multiUser, authRequired, registrationOpen, loading, loginEmail, registerEmail, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
