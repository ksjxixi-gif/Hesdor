"use client";

import type { ReactNode } from "react";
import { AuthProvider } from "@/lib/auth/auth-provider";
import { QueryProvider } from "@/lib/query/query-provider";
import { RealtimeProvider } from "@/lib/signalr/realtime-provider";
import { TenantProvider } from "@/lib/tenant/tenant-provider";
import { ThemeProvider } from "@/lib/theme/theme-provider";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryProvider>
      <ThemeProvider>
        <AuthProvider>
          <TenantProvider>
            <RealtimeProvider>{children}</RealtimeProvider>
          </TenantProvider>
        </AuthProvider>
      </ThemeProvider>
    </QueryProvider>
  );
}
