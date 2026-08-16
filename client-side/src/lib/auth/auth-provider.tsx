"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useRef, useSyncExternalStore, useState, type ReactNode } from "react";
import { ApiError, authApi, identityApi } from "@/lib/api/client";
import { clearSession, getSession, saveSession, subscribeSession } from "@/lib/auth/session";
import type { CurrentUser, Session } from "@/types/api";

type AuthContextValue = {
  session: Session | null;
  user: CurrentUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  sessionExpired: boolean;
  logout: () => void;
};

const emptySession = () => null;
const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const session = useSyncExternalStore(subscribeSession, getSession, emptySession);
  const [sessionExpired, setSessionExpired] = useState(false);
  const refreshPromise = useRef<Promise<void> | null>(null);
  const userQuery = useQuery({
    queryKey: ["current-user"],
    queryFn: () => identityApi.me(session!.accessToken),
    enabled: Boolean(session),
    retry: (failureCount, error) => !(error instanceof ApiError && error.status === 401) && failureCount < 1,
  });

  useEffect(() => {
    const handleSessionExpired = () => {
      const currentSession = getSession();
      if (!currentSession?.refreshToken) {
        setSessionExpired(true);
        clearSession();
        return;
      }
      if (refreshPromise.current) return;
      refreshPromise.current = authApi.refresh(currentSession.refreshToken)
        .then((refreshedSession) => {
          setSessionExpired(false);
          saveSession(refreshedSession);
        })
        .catch(() => {
          setSessionExpired(true);
          clearSession();
        })
        .finally(() => {
          refreshPromise.current = null;
        });
    };

    window.addEventListener("hesdor:session-expired", handleSessionExpired);
    return () => window.removeEventListener("hesdor:session-expired", handleSessionExpired);
  }, []);

  function logout() {
    clearSession();
    queryClient.removeQueries({ queryKey: ["current-user"] });
  }

  const value: AuthContextValue = {
    session,
    user: userQuery.data ?? null,
    isAuthenticated: Boolean(session && userQuery.data),
    isLoading: Boolean(session && userQuery.isPending),
    sessionExpired,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider.");
  }
  return context;
}
