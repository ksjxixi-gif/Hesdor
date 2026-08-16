"use client";

import { useQuery } from "@tanstack/react-query";
import { createContext, useContext, type ReactNode } from "react";
import { organizationApi } from "@/lib/api/client";
import { useAuth } from "@/lib/auth/auth-provider";
import type { Tenant } from "@/types/api";

type TenantContextValue = {
  tenant: Tenant | null;
  isLoading: boolean;
};

const TenantContext = createContext<TenantContextValue | null>(null);

export function TenantProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const query = useQuery({ queryKey: ["current-tenant"], queryFn: () => organizationApi.current(session!.accessToken), enabled: Boolean(session) });
  return <TenantContext.Provider value={{ tenant: query.data ?? null, isLoading: query.isPending }}>{children}</TenantContext.Provider>;
}

export function useTenant() {
  const context = useContext(TenantContext);
  if (!context) throw new Error("useTenant must be used within TenantProvider.");
  return context;
}
