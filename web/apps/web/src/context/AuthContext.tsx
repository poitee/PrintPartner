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
  loading: boolean;
  loginEmail: (email: string, password: string) => Promise<void>;
  registerEmail: (email: string, password: string, displayName: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [multiUser, setMultiUser] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const health = await fetchHealth();
      setMultiUser(Boolean(health.multi_user));
      if (!health.multi_user) {
        setUser(null);
        return;
      }
      const me = await fetchAuthMe();
      setUser(me.user);
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      await refresh();
      setLoading(false);
    })();
  }, [refresh]);

  useEffect(() => {
    setEngineUnauthorizedHandler(() => {
      if (multiUser) setUser(null);
    });
    return () => setEngineUnauthorizedHandler(null);
  }, [multiUser]);

  const loginEmail = useCallback(async (email: string, password: string) => {
    const res = await loginWithEmail(email, password);
    setUser(res.user);
  }, []);

  const registerEmail = useCallback(
    async (email: string, password: string, displayName: string) => {
      const res = await registerWithEmail(email, password, displayName);
      setUser(res.user);
    },
    [],
  );

  const logout = useCallback(async () => {
    await apiLogout();
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({
      user,
      multiUser,
      loading,
      loginEmail,
      registerEmail,
      logout,
      refresh,
    }),
    [user, multiUser, loading, loginEmail, registerEmail, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
